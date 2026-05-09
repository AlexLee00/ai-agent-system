/**
 * sigma-weekly-review.ts
 * 매주 일요일 19:00 KST 실행 — ai.sigma.weekly-review launchd plist
 *
 * 7일간 통합 통계 수집:
 * - Pod 성과 비교 (Trend/Growth/Risk)
 * - Self-Rewarding DPO 주간 집계
 * - Directive 발행/전송 추세 분석
 * - LLM 비용 주간 합계
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

const SIGMA_HTTP_PORT = process.env.SIGMA_HTTP_PORT || '4010';
const SIGMA_V2_ENDPOINT =
  process.env.SIGMA_V2_ENDPOINT || `http://127.0.0.1:${SIGMA_HTTP_PORT}/sigma/v2`;
const FAILURE_OUTCOMES = ['failure', 'failed', 'rejected', 'error', 'blocked'];
const SUCCESS_ISSUED_STATUSES = ['ok'];

async function queryPublic<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  return query('public', sql, params);
}

function firstRow<T extends Record<string, any>>(rows: T[]): T {
  return rows[0] ?? ({} as T);
}

async function collectWeeklyStats() {
  const [cycleRows, podRows, dpoRows, directiveRows, costRows, banditRows, anomalyRows] = await Promise.allSettled([
    queryPublic(`
      SELECT
        COUNT(DISTINCT cycle_id) AS total_cycles,
        COUNT(DISTINCT cycle_id) FILTER (WHERE issued_status = ANY($1::text[])) AS success_count
      FROM public.sigma_directive_tracking
      WHERE issued_at >= NOW() - INTERVAL '7 days'
    `, [SUCCESS_ISSUED_STATUSES]),
    queryPublic(`
      SELECT analyst, category, COUNT(*) AS cnt, AVG(score) AS avg_score
      FROM public.sigma_dpo_preference_pairs
      WHERE inserted_at >= NOW() - INTERVAL '7 days'
      GROUP BY analyst, category
      ORDER BY analyst, category
    `),
    queryPublic(`
      SELECT
        COUNT(*) FILTER (WHERE category = 'preferred') AS preferred_count,
        COUNT(*) FILTER (WHERE category = 'rejected') AS rejected_count,
        COUNT(*) FILTER (WHERE category = 'neutral') AS neutral_count,
        AVG(score) AS avg_score
      FROM public.sigma_dpo_preference_pairs
      WHERE inserted_at >= NOW() - INTERVAL '7 days'
    `),
    queryPublic(`
      SELECT
        team,
        COUNT(*) AS total_directives,
        COUNT(*) FILTER (WHERE issued_status = ANY($1::text[])) AS dispatched_count,
        COUNT(*) FILTER (WHERE issued_status <> ALL($1::text[])) AS blocked_count
      FROM public.sigma_directive_tracking
      WHERE issued_at >= NOW() - INTERVAL '7 days'
      GROUP BY team
      ORDER BY dispatched_count DESC, total_directives DESC
    `, [SUCCESS_ISSUED_STATUSES]),
    queryPublic(`
      SELECT COALESCE(SUM(cost_usd), 0) AS weekly_cost
      FROM public.sigma_llm_cost_tracking
      WHERE inserted_at >= NOW() - INTERVAL '7 days'
    `),
    queryPublic(`
      SELECT pod_name, avg_reward, trials
      FROM public.sigma_pod_bandit_stats
      ORDER BY avg_reward DESC
    `),
    queryPublic(`
      SELECT COUNT(*) AS anomaly_count
      FROM public.sigma_v2_directive_audit
      WHERE executed_at >= NOW() - INTERVAL '7 days'
        AND outcome = ANY($1::text[])
    `, [FAILURE_OUTCOMES]),
  ]);

  const cycle = cycleRows.status === 'fulfilled' ? firstRow(cycleRows.value) : {};
  const podPerf = podRows.status === 'fulfilled' ? podRows.value ?? [] : [];
  const dpo = dpoRows.status === 'fulfilled' ? firstRow(dpoRows.value) : {};
  const directive = directiveRows.status === 'fulfilled' ? directiveRows.value ?? [] : [];
  const cost = costRows.status === 'fulfilled' ? firstRow(costRows.value) : {};
  const bandit = banditRows.status === 'fulfilled' ? banditRows.value ?? [] : [];
  const anomaly = anomalyRows.status === 'fulfilled' ? firstRow(anomalyRows.value) : {};

  return {
    week_end: new Date().toISOString().slice(0, 10),
    total_cycles: Number(cycle.total_cycles ?? 0),
    success_count: Number(cycle.success_count ?? 0),
    error_count: Number(anomaly.anomaly_count ?? 0),
    pod_performance: podPerf,
    dpo_preferred: Number(dpo?.preferred_count ?? 0),
    dpo_rejected: Number(dpo?.rejected_count ?? 0),
    dpo_avg_score: Number(dpo?.avg_score ?? 0).toFixed(3),
    directive_by_team: directive,
    weekly_cost_usd: Number(cost?.weekly_cost ?? 0).toFixed(4),
    pod_bandit: bandit,
  };
}

function formatReport(stats: any): string {
  const successRate = stats.total_cycles > 0
    ? ((stats.success_count / stats.total_cycles) * 100).toFixed(1)
    : 'N/A';

  const podBanditLines = stats.pod_bandit.length > 0
    ? stats.pod_bandit.map((p: any) =>
        `  ${p.pod_name}: avg_reward=${Number(p.avg_reward ?? 0).toFixed(3)}, trials=${p.trials}`
      ).join('\n')
    : '  (데이터 없음)';

  const directiveLines = stats.directive_by_team.length > 0
    ? stats.directive_by_team.map((d: any) =>
        `  ${d.team}: 전송 성공 ${d.dispatched_count}/${d.total_directives}건, 차단 ${d.blocked_count}건`
      ).join('\n')
    : '  (데이터 없음)';

  return [
    `🔮 시그마 주간 리뷰 (~${stats.week_end})`,
    ``,
    `📊 MAPE-K 사이클 (7일)`,
    `  총 ${stats.total_cycles}회 | 정상 종료 ${stats.success_count} | 완료율 ${successRate}%`,
    `  실행 이상 이벤트 ${stats.error_count}건`,
    ``,
    `🎯 Pod Bandit 통계 (UCB1/Thompson)`,
    podBanditLines,
    ``,
    `🧠 Self-Rewarding DPO`,
    `  Preferred ${stats.dpo_preferred}건 | Rejected ${stats.dpo_rejected}건`,
    `  평균 점수: ${stats.dpo_avg_score}`,
    ``,
    `📋 팀별 Directive 전송`,
    directiveLines,
    ``,
    `💰 주간 LLM 비용: $${stats.weekly_cost_usd}`,
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
    // fallback
  }

  await hubAlarm.postAlarm({
    message: msg,
    team: 'sigma',
    fromBot: 'sigma-weekly-review',
    alertLevel: 2,
  });
}

async function main() {
  console.log('[sigma-weekly-review] 시작');

  try {
    const stats = await collectWeeklyStats();
    const msg = formatReport(stats);

    console.log(msg);

    if (process.env.SIGMA_TELEGRAM_ENHANCED === 'true') {
      await sendViaTelegramElixir(msg);
      console.log('[sigma-weekly-review] Telegram 발송 완료');
    } else {
      console.log('[sigma-weekly-review] SIGMA_TELEGRAM_ENHANCED=false — 발송 스킵 (Shadow 모드)');
    }
  } catch (e: any) {
    console.error('[sigma-weekly-review] 오류:', e.message);
    process.exit(1);
  }
}

main();
