#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/data-loop-health-report.ts — 데이터-분석-피드백-학습 루프 건강 보고
 *
 * 매일 09:00 KST (guard-outcome-tracker 이후 실행)
 * launchd: ai.luna.data-loop-health-daily-0905.plist
 *
 * 측정 지표:
 *   1. 거래 수 (24h / 7d) — soft 가드 제거 효과
 *   2. guard_events outcome 분포 (success / failure / no_trade / pending)
 *   3. feedback_to_action_map 누적 건수
 *   4. luna_failure_reflexions 누적 건수
 *   5. agent_curriculum_state 레벨 분포
 *   6. v_luna_learning_progress 최근 학습 진행률
 *   7. LUNA_FULL_DATA_LOOP 활성 여부
 */

import { query, close } from '../shared/db/core.ts';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { initHubConfig } = require('../../../packages/core/lib/llm-keys.js');

const TODAY = new Date().toISOString().split('T')[0];

async function fetchTradeStats() {
  const row24h = await query(
    `SELECT COUNT(*) AS cnt
     FROM investment.trade_journal
     WHERE exit_time IS NOT NULL
       AND NOT is_paper
       AND to_timestamp(exit_time / 1000.0) >= NOW() - INTERVAL '24 hours'`,
    [],
  ).catch(() => [{}]);
  const row7d = await query(
    `SELECT COUNT(*) AS cnt
     FROM investment.trade_journal
     WHERE exit_time IS NOT NULL
       AND NOT is_paper
       AND to_timestamp(exit_time / 1000.0) >= NOW() - INTERVAL '7 days'`,
    [],
  ).catch(() => [{}]);
  return {
    trades24h: Number(row24h?.[0]?.cnt || 0),
    trades7d: Number(row7d?.[0]?.cnt || 0),
  };
}

async function fetchGuardOutcomeStats() {
  const rows = await query(
    `SELECT
       outcome,
       COUNT(*) AS cnt
     FROM investment.guard_events
     WHERE triggered_at >= NOW() - INTERVAL '7 days'
     GROUP BY outcome
     ORDER BY outcome NULLS LAST`,
    [],
  ).catch(() => []);
  const stats = { success: 0, failure: 0, no_trade: 0, pending: 0, total: 0 };
  for (const r of (rows || [])) {
    const k = r.outcome === null ? 'pending' : String(r.outcome);
    stats[k] = Number(r.cnt || 0);
    stats.total += Number(r.cnt || 0);
  }
  return stats;
}

async function fetchGuardEffectiveness() {
  const rows = await query(
    `SELECT guard_name, total_triggers, success_count, failure_count, success_rate_pct, avg_outcome_pnl_usd
     FROM investment.v_guard_effectiveness
     WHERE total_triggers > 0
     ORDER BY total_triggers DESC
     LIMIT 10`,
    [],
  ).catch(() => []);
  return rows || [];
}

async function fetchFeedbackStats() {
  const row = await query(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS recent7d
     FROM investment.feedback_to_action_map`,
    [],
  ).catch(() => [{}]);
  return {
    total: Number(row?.[0]?.total || 0),
    recent7d: Number(row?.[0]?.recent7d || 0),
  };
}

async function fetchReflexionStats() {
  const row = await query(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS recent7d
     FROM investment.luna_failure_reflexions`,
    [],
  ).catch(() => [{}]);
  return {
    total: Number(row?.[0]?.total || 0),
    recent7d: Number(row?.[0]?.recent7d || 0),
  };
}

async function fetchCurriculumStats() {
  const rows = await query(
    `SELECT current_level, COUNT(*) AS cnt
     FROM investment.agent_curriculum_state
     GROUP BY current_level
     ORDER BY cnt DESC`,
    [],
  ).catch(() => []);
  const dist = {};
  for (const r of (rows || [])) {
    dist[String(r.current_level || 'unknown')] = Number(r.cnt || 0);
  }
  return dist;
}

async function fetchLearningProgress() {
  const rows = await query(
    `SELECT trade_date, AVG(learning_progress) AS avg_progress
     FROM investment.v_luna_learning_progress
     WHERE trade_date >= CURRENT_DATE - INTERVAL '7 days'
     GROUP BY trade_date
     ORDER BY trade_date DESC
     LIMIT 7`,
    [],
  ).catch(() => []);
  return rows || [];
}

function buildTelegramMessage(data) {
  const { trades, guardOutcome, guardTop, feedback, reflexion, curriculum, learning, fullDataLoop } = data;
  const loopStatus = fullDataLoop ? '🟢 ENABLED' : '🟡 DISABLED (shadow)';

  let msg = `📊 *루나 데이터 루프 건강 보고 — ${TODAY}*\n\n`;
  msg += `🔄 LUNA_FULL_DATA_LOOP: ${loopStatus}\n\n`;

  msg += `*1. 거래 (데이터 수집)*\n`;
  msg += `  • 24h: ${trades.trades24h}건\n`;
  msg += `  • 7d: ${trades.trades7d}건\n\n`;

  msg += `*2. 가드 이벤트 아웃컴 (7d)*\n`;
  msg += `  • 전체: ${guardOutcome.total}건\n`;
  msg += `  • ✅ success: ${guardOutcome.success}\n`;
  msg += `  • ❌ failure: ${guardOutcome.failure}\n`;
  msg += `  • ⚪ no_trade: ${guardOutcome.no_trade}\n`;
  msg += `  • ⏳ pending: ${guardOutcome.pending}\n`;

  if (guardOutcome.success + guardOutcome.failure > 0) {
    const successRate = Math.round(100 * guardOutcome.success / (guardOutcome.success + guardOutcome.failure));
    msg += `  • 승률: ${successRate}%\n`;
  }
  msg += '\n';

  if (guardTop.length > 0) {
    msg += `*3. 가드별 효과 (Top 5)*\n`;
    for (const g of guardTop.slice(0, 5)) {
      const rate = g.success_rate_pct ? `${Number(g.success_rate_pct).toFixed(1)}%` : '-';
      msg += `  • \`${g.guard_name}\`: ${g.total_triggers}건 (승률 ${rate})\n`;
    }
    msg += '\n';
  }

  msg += `*4. 피드백 누적*\n`;
  msg += `  • feedback_to_action_map: 총 ${feedback.total}건 (7d +${feedback.recent7d})\n`;
  msg += `  • failure_reflexions: 총 ${reflexion.total}건 (7d +${reflexion.recent7d})\n\n`;

  msg += `*5. 에이전트 진화*\n`;
  const levels = Object.entries(curriculum).map(([k, v]) => `${k}:${v}`).join(' / ');
  msg += `  • 커리큘럼 레벨: ${levels || '없음'}\n\n`;

  if (learning.length > 0) {
    const latest = learning[0];
    msg += `*6. 학습 진행률 (최근)*\n`;
    msg += `  • ${latest.trade_date}: ${Number(latest.avg_progress || 0).toFixed(3)}\n\n`;
  }

  msg += `_데이터 루프: 거래 → 분석 → 피드백 → 학습 → 진화 ♻️_`;
  return msg;
}

async function sendTelegram(message) {
  try {
    const hubUrl = process.env.HUB_URL || 'http://localhost:7788';
    const hubToken = process.env.HUB_AUTH_TOKEN;
    if (!hubToken) return;
    await fetch(`${hubUrl}/hub/notifications/telegram`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hubToken}`,
      },
      body: JSON.stringify({ message, source: 'data-loop-health-report', parseMode: 'Markdown' }),
    }).catch(() => null);
  } catch {
    // ignore
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`[DataLoopHealth] ${new Date().toISOString()} 루프 건강 보고 시작`);

  try {
    await initHubConfig().catch(() => null);
  } catch {}

  const fullDataLoop = !['0', 'false', 'no', 'off', 'disabled']
    .includes(String(process.env.LUNA_FULL_DATA_LOOP_ENABLED ?? 'true').toLowerCase());

  const [trades, guardOutcome, guardTop, feedback, reflexion, curriculum, learning] = await Promise.allSettled([
    fetchTradeStats(),
    fetchGuardOutcomeStats(),
    fetchGuardEffectiveness(),
    fetchFeedbackStats(),
    fetchReflexionStats(),
    fetchCurriculumStats(),
    fetchLearningProgress(),
  ]).then((results) => results.map((r) => r.status === 'fulfilled' ? r.value : {}));

  const data = { trades, guardOutcome, guardTop, feedback, reflexion, curriculum, learning, fullDataLoop };

  console.log(`[DataLoopHealth] 거래: 24h=${trades.trades24h} 7d=${trades.trades7d}`);
  console.log(`[DataLoopHealth] 가드 아웃컴: 총${guardOutcome.total} success=${guardOutcome.success} failure=${guardOutcome.failure} no_trade=${guardOutcome.no_trade}`);
  console.log(`[DataLoopHealth] 피드백: ${feedback.total}건 | reflexion: ${reflexion.total}건`);
  console.log(`[DataLoopHealth] LUNA_FULL_DATA_LOOP: ${fullDataLoop}`);

  const message = buildTelegramMessage(data);
  if (!dryRun) {
    await sendTelegram(message);
  } else {
    console.log('[DataLoopHealth][dry] Telegram 메시지:');
    console.log(message);
  }

  try { await close(); } catch {}
  process.exit(0);
}

main().catch((err) => {
  console.error('[DataLoopHealth] 실패:', err);
  process.exit(1);
});
