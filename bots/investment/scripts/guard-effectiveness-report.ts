#!/usr/bin/env node
// @ts-nocheck
/**
 * Phase 3: 가드 효과 측정 주간 보고서
 *
 * 매주 일요일 06:00 KST — investment.guard_events 기반 분석
 * launchd: ai.luna.guard-effectiveness-weekly-sun-0600.plist
 *
 * 출력:
 *   1. Telegram 알림 (마스터)
 *   2. /tmp/guard-effectiveness-report-YYYYMMDD.json
 *   3. /tmp/guard-effectiveness-report-YYYYMMDD.md
 */

import { query, run } from '../shared/db/core.ts';
import { initHubConfig } from '../../../packages/core/lib/llm-keys.ts';
import { maybeSkipForMemory } from '../shared/memory-pressure-guard.ts';

const REPORT_DATE = new Date().toISOString().split('T')[0];
const REPORT_DAYS = 7;

async function fetchGuardSummary(days = 7) {
  const rows = await query(
    `SELECT
       guard_name,
       COUNT(*)                                             AS total,
       COUNT(*) FILTER (WHERE severity = 'danger')         AS danger_count,
       COUNT(*) FILTER (WHERE severity = 'warning')        AS warning_count,
       COUNT(*) FILTER (WHERE severity = 'info')           AS info_count,
       COUNT(*) FILTER (WHERE outcome = 'success')         AS success_count,
       COUNT(*) FILTER (WHERE outcome = 'failure')         AS failure_count,
       AVG(outcome_pnl_usd) FILTER (
         WHERE outcome_pnl_usd IS NOT NULL
       )                                                   AS avg_pnl_usd,
       SUM(outcome_pnl_usd) FILTER (
         WHERE outcome_pnl_usd IS NOT NULL
       )                                                   AS total_pnl_usd,
       MAX(triggered_at)                                   AS last_triggered_at
     FROM investment.guard_events
    WHERE triggered_at >= NOW() - $1::interval
    GROUP BY guard_name
    ORDER BY COUNT(*) DESC`,
    [`${days} days`],
  ).catch(() => []);
  return rows || [];
}

async function fetchTopSymbolsByGuard(days = 7) {
  const rows = await query(
    `SELECT
       guard_name,
       symbol,
       COUNT(*) AS triggers
     FROM investment.guard_events
    WHERE triggered_at >= NOW() - $1::interval
      AND symbol IS NOT NULL
    GROUP BY guard_name, symbol
    ORDER BY guard_name, COUNT(*) DESC`,
    [`${days} days`],
  ).catch(() => []);
  return rows || [];
}

async function fetchDailyTrend(days = 7) {
  const rows = await query(
    `SELECT
       DATE_TRUNC('day', triggered_at)::DATE AS day,
       COUNT(*)                               AS triggers,
       COUNT(DISTINCT guard_name)             AS guard_types
     FROM investment.guard_events
    WHERE triggered_at >= NOW() - $1::interval
    GROUP BY 1
    ORDER BY 1`,
    [`${days} days`],
  ).catch(() => []);
  return rows || [];
}

function buildMarkdownReport(summary, topSymbols, dailyTrend) {
  const total = summary.reduce((sum, r) => sum + Number(r.total || 0), 0);
  const totalPnl = summary.reduce((sum, r) => sum + Number(r.total_pnl_usd || 0), 0);
  const notifyGuards = summary.filter((r) => r.guard_name === 'trade_data_entry_guard');
  const notifyTotal = notifyGuards.reduce((sum, r) => sum + Number(r.total || 0), 0);

  let md = `# 루나 가드 효과 보고서 — ${REPORT_DATE}\n\n`;
  md += `> 기간: 최근 ${REPORT_DAYS}일 | 자동 생성: guard-effectiveness-report.ts\n\n`;
  md += `## 요약\n\n`;
  md += `- 전체 가드 이벤트: **${total}건**\n`;
  md += `- Notify 모드 이벤트: **${notifyTotal}건** (거래 허용 + 학습)\n`;
  md += `- 총 PnL 영향: **${totalPnl.toFixed(2)} USD**\n`;
  md += `- 활성 가드 종류: **${summary.length}개**\n\n`;

  if (summary.length > 0) {
    md += `## 가드별 통계\n\n`;
    md += `| 가드 이름 | 트리거 | danger | warning | info | 마지막 트리거 |\n`;
    md += `|----------|--------|--------|---------|------|-------------|\n`;
    for (const r of summary) {
      md += `| \`${r.guard_name}\` | ${r.total} | ${r.danger_count} | ${r.warning_count} | ${r.info_count} | ${String(r.last_triggered_at || '').slice(0, 10)} |\n`;
    }
    md += '\n';
  }

  if (dailyTrend.length > 0) {
    md += `## 일별 트렌드\n\n`;
    md += `| 날짜 | 트리거 수 | 가드 종류 수 |\n|------|----------|-------------|\n`;
    for (const r of dailyTrend) {
      md += `| ${r.day} | ${r.triggers} | ${r.guard_types} |\n`;
    }
    md += '\n';
  }

  // Top symbols 요약
  const symbolMap = {};
  for (const r of topSymbols) {
    if (!symbolMap[r.guard_name]) symbolMap[r.guard_name] = [];
    if (symbolMap[r.guard_name].length < 3) {
      symbolMap[r.guard_name].push(`${r.symbol}(${r.triggers})`);
    }
  }
  if (Object.keys(symbolMap).length > 0) {
    md += `## 가드별 주요 종목\n\n`;
    for (const [guardName, symbols] of Object.entries(symbolMap)) {
      md += `- \`${guardName}\`: ${symbols.join(', ')}\n`;
    }
    md += '\n';
  }

  md += `## 권장 사항\n\n`;
  const highTrigger = summary.filter((r) => Number(r.total || 0) > 20);
  if (highTrigger.length > 0) {
    md += `⚠️ **고빈도 가드** (주간 20건+):\n`;
    for (const r of highTrigger) {
      md += `  - \`${r.guard_name}\`: ${r.total}건 → 임계값 완화 검토\n`;
    }
    md += '\n';
  }
  const lowTrigger = summary.filter((r) => Number(r.total || 0) === 0);
  if (lowTrigger.length > 0) {
    md += `✅ **비트리거 가드** (무트리거): ${lowTrigger.map((r) => `\`${r.guard_name}\``).join(', ')}\n`;
    md += `  → 임계값 강화 또는 제거 검토\n\n`;
  }
  md += `## 다음 단계\n\n`;
  md += `- Self-Tuning 가드 조정 권장 사항: \`guard-self-tuning.ts\` 참조\n`;
  md += `- 마스터 승인 후 임계값 자동 적용\n`;
  return md;
}

async function sendTelegramNotification(message) {
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
      body: JSON.stringify({ message, source: 'guard-effectiveness-report' }),
    }).catch(() => null);
  } catch {
    // ignore
  }
}

async function main() {
  if (maybeSkipForMemory('luna.guard-effectiveness')) return;
  console.log(`[GuardEffectiveness] ${REPORT_DATE} 보고서 생성 시작`);

  try {
    await initHubConfig().catch(() => null);
  } catch {}

  const [summary, topSymbols, dailyTrend] = await Promise.all([
    fetchGuardSummary(REPORT_DAYS),
    fetchTopSymbolsByGuard(REPORT_DAYS),
    fetchDailyTrend(REPORT_DAYS),
  ]);

  const report = buildMarkdownReport(summary, topSymbols, dailyTrend);
  const dateTag = REPORT_DATE.replace(/-/g, '');
  const mdPath = `/tmp/guard-effectiveness-report-${dateTag}.md`;
  const jsonPath = `/tmp/guard-effectiveness-report-${dateTag}.json`;

  const { writeFileSync } = await import('fs');
  writeFileSync(mdPath, report, 'utf-8');
  writeFileSync(jsonPath, JSON.stringify({ date: REPORT_DATE, summary, dailyTrend }, null, 2), 'utf-8');

  const total = summary.reduce((sum, r) => sum + Number(r.total || 0), 0);
  const tgMsg = `📊 *루나 가드 효과 보고서* (${REPORT_DATE})\n전체: ${total}건 | 가드: ${summary.length}종\n보고서: ${mdPath}`;
  await sendTelegramNotification(tgMsg);

  console.log(`[GuardEffectiveness] 완료 — ${mdPath}`);
  console.log(`[GuardEffectiveness] 이벤트: ${total}건, 가드 종류: ${summary.length}`);
}

main().catch((err) => {
  console.error('[GuardEffectiveness] 오류:', err?.message);
  process.exit(1);
});
