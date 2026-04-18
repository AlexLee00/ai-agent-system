/**
 * sigma-daily-report.ts
 * 매일 06:30 KST 실행 — ai.sigma.daily-report launchd plist
 *
 * 어제(24시간 이내) MAPE-K 사이클 통계 + Pod 성과 + Directive 이행율을
 * 수집해 TelegramReporter.on_daily_report 경로로 Telegram 발송.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const path = require('path');
const PROJECT_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../..'
);

const { query } = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));
const hub = require(path.join(PROJECT_ROOT, 'packages/core/lib/hub-client'));

const SIGMA_HTTP_PORT = process.env.SIGMA_HTTP_PORT || '4010';
const SIGMA_V2_ENDPOINT =
  process.env.SIGMA_V2_ENDPOINT || `http://127.0.0.1:${SIGMA_HTTP_PORT}/sigma/v2`;

async function collectDailyStats() {
  const [cycleRows, directiveRows, dpoRows, costRows] = await Promise.allSettled([
    query(`
      SELECT
        COUNT(*) AS total_cycles,
        COUNT(*) FILTER (WHERE outcome = 'success') AS success_count,
        COUNT(*) FILTER (WHERE outcome = 'failure') AS error_count
      FROM sigma_v2_directive_audit
      WHERE executed_at >= NOW() - INTERVAL '24 hours'
    `),
    query(`
      SELECT
        COUNT(*) AS total_directives,
        COUNT(*) FILTER (WHERE tier = 2) AS tier2_count,
        COUNT(*) FILTER (WHERE outcome = 'success') AS applied_count,
        COUNT(*) FILTER (WHERE outcome = 'failure') AS rejected_count
      FROM sigma_v2_directive_audit
      WHERE executed_at >= NOW() - INTERVAL '24 hours'
    `),
    query(`
      SELECT category, COUNT(*) AS cnt
      FROM sigma_dpo_preference_pairs
      WHERE inserted_at >= NOW() - INTERVAL '24 hours'
      GROUP BY category
    `),
    query(`
      SELECT COALESCE(SUM(cost_usd), 0) AS llm_cost_usd
      FROM sigma_llm_cost_tracking
      WHERE inserted_at >= NOW() - INTERVAL '24 hours'
    `),
  ]);

  const cycle = cycleRows.status === 'fulfilled' ? cycleRows.value?.rows?.[0] : {};
  const directive = directiveRows.status === 'fulfilled' ? directiveRows.value?.rows?.[0] : {};
  const dpo = dpoRows.status === 'fulfilled' ? dpoRows.value?.rows ?? [] : [];
  const cost = costRows.status === 'fulfilled' ? costRows.value?.rows?.[0] : {};

  const preferredCount = dpo.find((r: any) => r.category === 'preferred')?.cnt ?? 0;
  const rejectedCount = dpo.find((r: any) => r.category === 'rejected')?.cnt ?? 0;

  return {
    date: new Date().toISOString().slice(0, 10),
    total_cycles: Number(cycle.total_cycles ?? 0),
    success_count: Number(cycle.success_count ?? 0),
    error_count: Number(cycle.error_count ?? 0),
    directives_issued: Number(directive.total_directives ?? 0),
    directives_applied: Number(directive.applied_count ?? 0),
    directives_rejected: Number(directive.rejected_count ?? 0),
    tier2_applied: Number(directive.tier2_count ?? 0),
    self_rewarding_preferred: Number(preferredCount),
    self_rewarding_rejected: Number(rejectedCount),
    llm_cost_usd: Number(cost.llm_cost_usd ?? 0).toFixed(4),
  };
}

function formatReport(stats: ReturnType<typeof collectDailyStats> extends Promise<infer T> ? T : never): string {
  const successRate = stats.total_cycles > 0
    ? ((stats.success_count / stats.total_cycles) * 100).toFixed(1)
    : 'N/A';
  const applyRate = stats.directives_issued > 0
    ? ((stats.directives_applied / stats.directives_issued) * 100).toFixed(1)
    : 'N/A';

  return [
    `🔮 시그마 일일 리포트 (${stats.date})`,
    ``,
    `📊 MAPE-K 사이클`,
    `  총 ${stats.total_cycles}회 | 성공 ${stats.success_count} | 실패 ${stats.error_count} | 성공률 ${successRate}%`,
    ``,
    `📋 Directive 발행`,
    `  발행 ${stats.directives_issued}건 | 이행 ${stats.directives_applied}건 | 거절 ${stats.directives_rejected}건`,
    `  이행률 ${applyRate}% | Tier2 자동 ${stats.tier2_applied}건`,
    ``,
    `🧠 Self-Rewarding (DPO)`,
    `  Preferred ${stats.self_rewarding_preferred}건 | Rejected ${stats.self_rewarding_rejected}건`,
    ``,
    `💰 LLM 비용: $${stats.llm_cost_usd} (상한 $10/일)`,
  ].join('\n');
}

async function sendViaTelegramElixir(msg: string): Promise<void> {
  try {
    const res = await fetch(`${SIGMA_V2_ENDPOINT}/telegram/general`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: msg }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return;
  } catch {
    // Elixir HTTP 불가시 Hub fallback
  }

  await hub.sendTelegram({ message: msg, channel: 'general' });
}

async function main() {
  console.log('[sigma-daily-report] 시작');

  try {
    const stats = await collectDailyStats();
    const msg = formatReport(stats);

    console.log(msg);

    if (process.env.SIGMA_TELEGRAM_ENHANCED === 'true') {
      await sendViaTelegramElixir(msg);
      console.log('[sigma-daily-report] Telegram 발송 완료');
    } else {
      console.log('[sigma-daily-report] SIGMA_TELEGRAM_ENHANCED=false — 발송 스킵 (Shadow 모드)');
    }
  } catch (e: any) {
    console.error('[sigma-daily-report] 오류:', e.message);
    process.exit(1);
  }
}

main();
