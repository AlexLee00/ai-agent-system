/**
 * sigma-daily-report.ts
 * 매일 06:30 KST 실행 — ai.sigma.daily-report launchd plist
 *
 * 어제(24시간 이내) MAPE-K 사이클 통계 + Pod 성과 + Directive 발행/전송 통계를
 * 수집해 TelegramReporter.on_daily_report 경로로 Telegram 발송.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const path = require('path');
const PROJECT_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../../..'
);

const { query } = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));
const hubAlarm = require(path.join(PROJECT_ROOT, 'packages/core/lib/hub-alarm-client.js'));

const CANONICAL_SIGMA_HTTP_PORT = '4000';
const SIGMA_HTTP_PORT = process.env.SIGMA_HTTP_PORT || CANONICAL_SIGMA_HTTP_PORT;
const SIGMA_V2_ENDPOINT =
  process.env.SIGMA_V2_ENDPOINT || `http://127.0.0.1:${SIGMA_HTTP_PORT}/sigma/v2`;

function sigmaEndpointCandidates(): string[] {
  if (process.env.SIGMA_V2_ENDPOINT) return [process.env.SIGMA_V2_ENDPOINT];
  const canonical = `http://127.0.0.1:${CANONICAL_SIGMA_HTTP_PORT}/sigma/v2`;
  return SIGMA_V2_ENDPOINT === canonical ? [SIGMA_V2_ENDPOINT] : [SIGMA_V2_ENDPOINT, canonical];
}

const FAILURE_OUTCOMES = ['failure', 'failed', 'rejected', 'error', 'blocked'];
const SUCCESS_ISSUED_STATUSES = ['ok'];

function kstDateLabel(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function queryPublic<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  return query('public', sql, params);
}

function firstRow<T extends Record<string, any>>(rows: T[]): T {
  return rows[0] ?? ({} as T);
}

async function collectDailyStats() {
  const [cycleRows, directiveRows, anomalyRows, dpoRows, costRows] = await Promise.all([
    queryPublic(`
      SELECT
        COUNT(DISTINCT cycle_id) AS total_cycles,
        COUNT(DISTINCT cycle_id) FILTER (
          WHERE issued_status = ANY($1::text[])
        ) AS success_count
      FROM public.sigma_directive_tracking
      WHERE issued_at >= NOW() - INTERVAL '24 hours'
    `, [SUCCESS_ISSUED_STATUSES]),
    queryPublic(`
      SELECT
        COUNT(*) AS total_directives,
        COUNT(*) FILTER (WHERE issued_status = ANY($1::text[])) AS dispatched_count,
        COUNT(*) FILTER (WHERE issued_status <> ALL($1::text[])) AS blocked_count
      FROM public.sigma_directive_tracking
      WHERE issued_at >= NOW() - INTERVAL '24 hours'
    `, [SUCCESS_ISSUED_STATUSES]),
    queryPublic(`
      SELECT COUNT(*) AS anomaly_count
      FROM public.sigma_v2_directive_audit
      WHERE executed_at >= NOW() - INTERVAL '24 hours'
        AND outcome = ANY($1::text[])
    `, [FAILURE_OUTCOMES]),
    queryPublic(`
      SELECT category, COUNT(*) AS cnt
      FROM public.sigma_dpo_preference_pairs
      WHERE inserted_at >= NOW() - INTERVAL '24 hours'
      GROUP BY category
    `),
    queryPublic(`
      SELECT COALESCE(SUM(cost_usd), 0) AS llm_cost_usd
      FROM public.sigma_llm_cost_tracking
      WHERE inserted_at >= NOW() - INTERVAL '24 hours'
    `),
  ]);

  const cycle = firstRow(cycleRows);
  const directive = firstRow(directiveRows);
  const anomaly = firstRow(anomalyRows);
  const dpo = dpoRows;
  const cost = firstRow(costRows);

  const preferredCount = dpo.find((r: any) => r.category === 'preferred')?.cnt ?? 0;
  const rejectedCount = dpo.find((r: any) => r.category === 'rejected')?.cnt ?? 0;

  return {
    date: kstDateLabel(),
    total_cycles: Number(cycle.total_cycles ?? 0),
    success_count: Number(cycle.success_count ?? 0),
    error_count: Number(anomaly.anomaly_count ?? 0),
    directives_issued: Number(directive.total_directives ?? 0),
    directives_applied: Number(directive.dispatched_count ?? 0),
    directives_rejected: Number(directive.blocked_count ?? 0),
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
    `  총 ${stats.total_cycles}회 | 정상 종료 ${stats.success_count} | 완료율 ${successRate}%`,
    `  실행 이상 이벤트 ${stats.error_count}건`,
    ``,
    `📋 Directive 발행`,
    `  발행 ${stats.directives_issued}건 | 전송 성공 ${stats.directives_applied}건 | 차단 ${stats.directives_rejected}건`,
    `  전송률 ${applyRate}%`,
    ``,
    `🧠 Self-Rewarding (DPO)`,
    `  Preferred ${stats.self_rewarding_preferred}건 | Rejected ${stats.self_rewarding_rejected}건`,
    ``,
    `💰 LLM 비용: $${stats.llm_cost_usd} (상한 $10/일)`,
  ].join('\n');
}

async function sendViaTelegramElixir(msg: string): Promise<void> {
  for (const endpoint of sigmaEndpointCandidates()) {
    try {
      const res = await fetch(`${endpoint}/telegram/general`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: msg }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return;
    } catch {
      // Try the next endpoint before Hub fallback.
    }
  }

  await hubAlarm.postAlarm({
    message: msg,
    team: 'sigma',
    fromBot: 'sigma-daily-report',
    alertLevel: 2,
  });
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
