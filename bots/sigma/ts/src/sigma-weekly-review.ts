/**
 * sigma-weekly-review.ts
 * 매주 일요일 19:00 KST 실행 — ai.sigma.weekly-review launchd plist
 *
 * 7일간 통합 통계 수집:
 * - Pod 성과 비교 (Trend/Growth/Risk)
 * - Self-Rewarding DPO 주간 집계
 * - Directive 효과성 분석
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

async function collectWeeklyStats() {
  const [cycleRows, podRows, dpoRows, directiveRows, costRows, banditRows] = await Promise.allSettled([
    query(`
      SELECT
        COUNT(*) AS total_cycles,
        COUNT(*) FILTER (WHERE outcome = 'success') AS success_count,
        COUNT(*) FILTER (WHERE outcome = 'failure') AS error_count
      FROM sigma_v2_directive_audit
      WHERE executed_at >= NOW() - INTERVAL '7 days'
    `),
    query(`
      SELECT analyst, category, COUNT(*) AS cnt, AVG(score) AS avg_score
      FROM sigma_dpo_preference_pairs
      WHERE inserted_at >= NOW() - INTERVAL '7 days'
      GROUP BY analyst, category
      ORDER BY analyst, category
    `),
    query(`
      SELECT
        COUNT(*) FILTER (WHERE category = 'preferred') AS preferred_count,
        COUNT(*) FILTER (WHERE category = 'rejected') AS rejected_count,
        COUNT(*) FILTER (WHERE category = 'neutral') AS neutral_count,
        AVG(score) AS avg_score
      FROM sigma_dpo_preference_pairs
      WHERE inserted_at >= NOW() - INTERVAL '7 days'
    `),
    query(`
      SELECT
        team,
        COUNT(*) AS total_directives,
        COUNT(*) FILTER (WHERE outcome = 'success') AS applied_count
      FROM sigma_v2_directive_audit
      WHERE executed_at >= NOW() - INTERVAL '7 days'
      GROUP BY team
      ORDER BY applied_count DESC
    `),
    query(`
      SELECT COALESCE(SUM(cost_usd), 0) AS weekly_cost
      FROM sigma_llm_cost_tracking
      WHERE inserted_at >= NOW() - INTERVAL '7 days'
    `),
    query(`
      SELECT pod_name, avg_reward, trials
      FROM sigma_pod_bandit_stats
      ORDER BY avg_reward DESC
    `),
  ]);

  const cycle = cycleRows.status === 'fulfilled' ? cycleRows.value?.rows?.[0] : {};
  const podPerf = podRows.status === 'fulfilled' ? podRows.value?.rows ?? [] : [];
  const dpo = dpoRows.status === 'fulfilled' ? dpoRows.value?.rows?.[0] : {};
  const directive = directiveRows.status === 'fulfilled' ? directiveRows.value?.rows ?? [] : [];
  const cost = costRows.status === 'fulfilled' ? costRows.value?.rows?.[0] : {};
  const bandit = banditRows.status === 'fulfilled' ? banditRows.value?.rows ?? [] : [];

  return {
    week_end: new Date().toISOString().slice(0, 10),
    total_cycles: Number(cycle.total_cycles ?? 0),
    success_count: Number(cycle.success_count ?? 0),
    error_count: Number(cycle.error_count ?? 0),
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
        `  ${d.team}: ${d.applied_count}/${d.total_directives}건 이행`
      ).join('\n')
    : '  (데이터 없음)';

  return [
    `🔮 시그마 주간 리뷰 (~${stats.week_end})`,
    ``,
    `📊 MAPE-K 사이클 (7일)`,
    `  총 ${stats.total_cycles}회 | 성공 ${stats.success_count} | 실패 ${stats.error_count} | 성공률 ${successRate}%`,
    ``,
    `🎯 Pod Bandit 통계 (UCB1/Thompson)`,
    podBanditLines,
    ``,
    `🧠 Self-Rewarding DPO`,
    `  Preferred ${stats.dpo_preferred}건 | Rejected ${stats.dpo_rejected}건`,
    `  평균 점수: ${stats.dpo_avg_score}`,
    ``,
    `📋 팀별 Directive 이행`,
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
