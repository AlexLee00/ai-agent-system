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
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';

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

async function fetchLaunchdHealth() {
  try {
    const launchdDir = new URL('../launchd', import.meta.url).pathname;
    const plistFiles = fs.readdirSync(launchdDir).filter((f) => f.endsWith('.plist'));

    const definedLabels: string[] = [];
    for (const file of plistFiles) {
      const content = fs.readFileSync(`${launchdDir}/${file}`, 'utf8');
      const match = content.match(/<key>Label<\/key>\s*<string>(.*?)<\/string>/);
      if (match) definedLabels.push(match[1].trim());
    }

    const result = spawnSync('launchctl', ['list'], { encoding: 'utf8', timeout: 5000 });
    const registeredLabels = new Set<string>();
    if (result.stdout) {
      for (const line of result.stdout.split('\n')) {
        const parts = line.split('\t');
        if (parts.length >= 3) registeredLabels.add(parts[2].trim());
      }
    }

    const unregistered = definedLabels.filter((l) => !registeredLabels.has(l));
    return {
      defined: definedLabels.length,
      registered: definedLabels.length - unregistered.length,
      unregistered,
    };
  } catch (err) {
    console.error('[DataLoopHealth] launchd 점검 실패:', err);
    return { defined: 0, registered: 0, unregistered: [] };
  }
}

async function fetchOpsSchedulerHealth() {
  try {
    const stateFile = new URL('../output/ops/luna-ops-scheduler-state.json', import.meta.url).pathname;
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const now = Date.now();
    const staleJobs: { name: string; elapsedHours: number; thresholdHours: number }[] = [];

    for (const [name, job] of Object.entries(state.jobs || {})) {
      const lastRunAt = (job as any).lastRunAt;
      if (!lastRunAt) continue;

      const elapsedHours = (now - new Date(lastRunAt).getTime()) / 3_600_000;
      let thresholdHours = 48;
      if (/15min|30min|hourly/.test(name)) thresholdHours = 6;
      else if (/weekly/.test(name)) thresholdHours = 336;

      if (elapsedHours > thresholdHours) {
        staleJobs.push({ name, elapsedHours: Math.round(elapsedHours), thresholdHours });
      }
    }

    return { staleJobs };
  } catch (err) {
    console.error('[DataLoopHealth] ops-scheduler 점검 실패:', err);
    return { staleJobs: [] };
  }
}

async function fetchTableFreshness() {
  const checks = [
    { table: 'investment.positions', tsCol: 'updated_at', epochMs: false, expectHours: 1 },
    { table: 'investment.trade_journal', tsCol: 'entry_time', epochMs: true, expectHours: 168 },
    { table: 'investment.market_regime_snapshots', tsCol: 'captured_at', epochMs: false, expectHours: 2 },
    { table: 'investment.candidate_universe', tsCol: 'created_at', epochMs: false, expectHours: 48 },
    { table: 'investment.guard_events', tsCol: 'triggered_at', epochMs: false, expectHours: 48 },
    { table: 'investment.account_balances', tsCol: 'updated_at', epochMs: false, expectHours: 1 },
  ];

  const results: { table: string; status: 'ok' | 'stale' | 'missing'; elapsedHours?: number; expectHours: number }[] = [];

  for (const { table, tsCol, epochMs, expectHours } of checks) {
    try {
      const tsExpr = epochMs ? `to_timestamp(MAX(${tsCol}) / 1000.0)` : `MAX(${tsCol})`;
      const rows = await query(`SELECT ${tsExpr} AS latest FROM ${table}`, []);
      const latest = rows?.[0]?.latest;
      if (!latest) {
        results.push({ table, status: 'stale', elapsedHours: undefined, expectHours });
        continue;
      }
      const elapsedHours = (Date.now() - new Date(latest).getTime()) / 3_600_000;
      results.push({
        table,
        status: elapsedHours > expectHours ? 'stale' : 'ok',
        elapsedHours: Math.round(elapsedHours),
        expectHours,
      });
    } catch (err: any) {
      const isMissing = /relation|does not exist/i.test(err?.message || '');
      results.push({ table, status: isMissing ? 'missing' : 'stale', expectHours });
    }
  }

  return results;
}

function buildFreshnessSection(launchd, opsScheduler, tableFreshness) {
  const tables: any[] = Array.isArray(tableFreshness) ? tableFreshness : [];
  const staleJobs: any[] = opsScheduler?.staleJobs ?? [];
  const unregistered: string[] = launchd?.unregistered ?? [];
  const ldDefined: number = launchd?.defined ?? 0;
  const ldRegistered: number = launchd?.registered ?? 0;

  let section = `*7. 프로세스/테이블 신선도*\n`;
  let hasCritical = false;
  let hasWarn = false;

  // Table freshness
  for (const t of tables) {
    if (t.status === 'missing') {
      section += `🔴 CRITICAL: \`${t.table}\` MISSING\n`;
      hasCritical = true;
    } else if (t.status === 'stale') {
      const hrs = t.elapsedHours !== undefined ? `${t.elapsedHours}h` : '?h';
      if ((t.elapsedHours ?? 0) > 24) {
        section += `🔴 CRITICAL: \`${t.table}\` STALE ${hrs} (기대: ${t.expectHours}h)\n`;
        hasCritical = true;
      } else {
        section += `⚠️ WARN: \`${t.table}\` STALE ${hrs} (기대: ${t.expectHours}h)\n`;
        hasWarn = true;
      }
    }
  }

  // Ops-scheduler stale jobs
  for (const j of staleJobs) {
    section += `⚠️ WARN: ops \`${j.name}\` ${j.elapsedHours}h 정지 (기대: ${j.thresholdHours}h)\n`;
    hasWarn = true;
  }

  // Launchd unregistered
  if (unregistered.length > 0) {
    section += `⚠️ WARN: launchd 미등록 ${unregistered.length}개:\n`;
    for (const l of unregistered) {
      section += `  • \`${l}\`\n`;
    }
    hasWarn = true;
  }

  if (!hasCritical && !hasWarn) {
    section += `✅ 모두 정상 (미등록/stale 없음)\n`;
  }

  section += `  launchd: ${ldRegistered}/${ldDefined} 등록\n`;
  return { section, hasCritical };
}

function buildTelegramMessage(data) {
  const { trades, guardOutcome, guardTop, feedback, reflexion, curriculum, learning, fullDataLoop, launchd, opsScheduler, tableFreshness } = data;
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

  const { section: freshnessSection, hasCritical } = buildFreshnessSection(launchd, opsScheduler, tableFreshness);
  msg += freshnessSection + '\n';

  const statusEmoji = hasCritical ? '🚨' : '✅';
  msg += `_${statusEmoji} 데이터 루프: 거래 → 분석 → 피드백 → 학습 → 진화 ♻️_`;
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

  const [trades, guardOutcome, guardTop, feedback, reflexion, curriculum, learning, launchd, opsScheduler, tableFreshness] = await Promise.allSettled([
    fetchTradeStats(),
    fetchGuardOutcomeStats(),
    fetchGuardEffectiveness(),
    fetchFeedbackStats(),
    fetchReflexionStats(),
    fetchCurriculumStats(),
    fetchLearningProgress(),
    fetchLaunchdHealth(),
    fetchOpsSchedulerHealth(),
    fetchTableFreshness(),
  ]).then((results) => results.map((r) => r.status === 'fulfilled' ? r.value : r.status === 'rejected' ? {} : {}));

  const data = { trades, guardOutcome, guardTop, feedback, reflexion, curriculum, learning, fullDataLoop, launchd, opsScheduler, tableFreshness };

  console.log(`[DataLoopHealth] 거래: 24h=${trades.trades24h} 7d=${trades.trades7d}`);
  console.log(`[DataLoopHealth] 가드 아웃컴: 총${guardOutcome.total} success=${guardOutcome.success} failure=${guardOutcome.failure} no_trade=${guardOutcome.no_trade}`);
  console.log(`[DataLoopHealth] 피드백: ${feedback.total}건 | reflexion: ${reflexion.total}건`);
  console.log(`[DataLoopHealth] LUNA_FULL_DATA_LOOP: ${fullDataLoop}`);
  console.log(`[DataLoopHealth] launchd: ${launchd.registered ?? '?'}/${launchd.defined ?? '?'} 등록, 미등록 ${(launchd.unregistered ?? []).length}개`);
  console.log(`[DataLoopHealth] ops stale jobs: ${(opsScheduler.staleJobs ?? []).length}개`);
  const criticalTables = (tableFreshness ?? []).filter((t) => t.status === 'missing' || (t.status === 'stale' && (t.elapsedHours ?? 0) > 24));
  console.log(`[DataLoopHealth] 테이블 CRITICAL: ${criticalTables.map((t) => `${t.table}(${t.status})`).join(', ') || '없음'}`);

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
