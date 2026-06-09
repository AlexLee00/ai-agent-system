/**
 * LLM Routing 일일 리포트 — 매일 KST 06:00 자동 실행
 * launchd ai.llm.daily-report.plist로 트리거됨
 */

import { createRequire } from 'module';
const require = createRequire(__filename);
let telegramSender = require('../../../packages/core/lib/telegram-sender');
let pgPool = require('../../../packages/core/lib/pg-pool');
let fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);

const HUB_BASE = process.env.HUB_BASE_URL || 'http://localhost:7788';
const HUB_TOKEN = process.env.HUB_AUTH_TOKEN || '';
const FETCH_TIMEOUT_MS = Math.max(1000, Number(process.env.LLM_DAILY_REPORT_FETCH_TIMEOUT_MS || 8000) || 8000);

async function fetchStats(hours: number, team?: string): Promise<any> {
  const url = team
    ? `${HUB_BASE}/hub/llm/stats?hours=${hours}&team=${team}`
    : `${HUB_BASE}/hub/llm/stats?hours=${hours}`;
  try {
    const resp = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${HUB_TOKEN}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`Hub stats ${resp.status}`);
    const body = await resp.json();
    if (!body?.ok) throw new Error(`Hub stats ${body?.error || 'not_ok'}`);
    return { ...body, stats_source: 'hub_http' };
  } catch (error) {
    const fallback = await fetchStatsFromDb(hours, team);
    return {
      ...fallback,
      stats_source: 'db_fallback',
      stats_source_error: String((error as Error)?.message || error),
    };
  }
}

async function fetchStatsFromDb(hours: number, team?: string): Promise<any> {
  const teamFilter = team ? 'AND caller_team = $2' : '';
  const params = team ? [hours, team] : [hours];
  const [summary, byAgent, byHour] = await Promise.all([
    pgPool.query('public', `
      SELECT
        provider,
        caller_team,
        COUNT(*)                                                AS total_calls,
        SUM(CASE WHEN success THEN 1 ELSE 0 END)               AS success_count,
        ROUND(AVG(duration_ms))::integer                       AS avg_duration_ms,
        MAX(duration_ms)                                       AS max_duration_ms,
        ROUND(SUM(cost_usd)::numeric, 6)                       AS total_cost_usd,
        COUNT(DISTINCT agent)                                  AS unique_agents,
        SUM(fallback_count)                                    AS total_fallbacks
      FROM llm_routing_log
      WHERE created_at > NOW() - ($1 || ' hours')::interval ${teamFilter}
      GROUP BY provider, caller_team
      ORDER BY total_calls DESC
    `, params),
    pgPool.query('public', `
      SELECT agent, provider,
        COUNT(*)                                               AS calls,
        ROUND(AVG(duration_ms))::integer                      AS avg_ms,
        ROUND(SUM(cost_usd)::numeric, 6)                      AS cost
      FROM llm_routing_log
      WHERE created_at > NOW() - ($1 || ' hours')::interval ${teamFilter}
        AND agent IS NOT NULL
      GROUP BY agent, provider
      ORDER BY calls DESC
      LIMIT 20
    `, params),
    pgPool.query('public', `
      SELECT
        date_trunc('hour', created_at)                        AS hour,
        provider,
        COUNT(*)                                              AS calls,
        ROUND(SUM(cost_usd)::numeric, 6)                     AS cost
      FROM llm_routing_log
      WHERE created_at > NOW() - ($1 || ' hours')::interval ${teamFilter}
      GROUP BY hour, provider
      ORDER BY hour DESC
    `, params),
  ]);
  const totalCalls = summary.reduce((s: number, r: any) => s + Number(r.total_calls || 0), 0);
  const totalCost = summary.reduce((s: number, r: any) => s + Number(r.total_cost_usd || 0), 0);
  const totalSuccess = summary.reduce((s: number, r: any) => s + Number(r.success_count || 0), 0);
  const providerShare: Record<string, number> = {};
  for (const row of summary) {
    const provider = String(row.provider || 'unknown');
    providerShare[provider] = totalCalls > 0 ? Number((Number(row.total_calls || 0) / totalCalls).toFixed(4)) : 0;
  }
  return {
    ok: true,
    hours,
    team: team || 'all',
    groq_pool_size: null,
    summary,
    by_agent: byAgent,
    by_hour: byHour,
    totals: {
      total_calls: totalCalls,
      total_cost_usd: totalCost,
      success_rate: totalCalls > 0 ? totalSuccess / totalCalls : 0,
      provider_share: providerShare,
    },
  };
}

async function generateReport() {
  const data = await fetchStats(24);
  const { totals = {}, summary = [], by_agent = [], groq_pool_size = 0 } = data;
  const totalCalls = Number(totals.total_calls || 0);
  const groqPoolLabel = groq_pool_size != null && Number.isFinite(Number(groq_pool_size))
    ? `${Number(groq_pool_size)}계정`
    : 'unknown';

  const lines: string[] = [];
  lines.push('📊 *LLM Routing 일일 리포트 (24h)*');
  lines.push('');
  lines.push(`총 호출: ${totalCalls}회`);
  lines.push(`총 비용: $${Number(totals.total_cost_usd ?? 0).toFixed(4)}`);
  lines.push(`성공률: ${((totals.success_rate ?? 0) * 100).toFixed(1)}%`);
  lines.push(`Groq 풀: ${groqPoolLabel}`);
  if (data.stats_source === 'db_fallback') {
    lines.push(`통계 소스: DB fallback (${data.stats_source_error || 'hub_http_unavailable'})`);
  }
  lines.push('');

  if (summary.length > 0) {
    lines.push('*Provider별 분포:*');
    for (const row of summary) {
      const provider = String(row.provider || '');
      const label = provider === 'claude-code-oauth' ? '🧠 Claude Code OAuth'
        : provider === 'openai-oauth' ? '🟩 OpenAI OAuth'
          : provider === 'gemini-cli-oauth' ? '🟦 Gemini CLI OAuth'
            : provider === 'gemini-oauth' ? '🟦 Gemini CLI OAuth'
              : provider === 'groq' ? '⚡ Groq'
                : provider === 'failed' ? '❌ Failed'
                  : `🔹 ${provider || 'unknown'}`;
      const team = row.caller_team ? `[${row.caller_team}]` : '';
      const calls = Number(row.total_calls || 0);
      const sharePct = totalCalls > 0 ? (calls / totalCalls) * 100 : 0;
      const providerSuccessRate = calls > 0 ? (Number(row.success_count || 0) / calls) * 100 : 0;
      lines.push(
        `  ${label}${team}: ${calls}회 (${sharePct.toFixed(1)}%) `
        + `성공률 ${providerSuccessRate.toFixed(1)}% avg ${row.avg_duration_ms}ms `
        + `$${Number(row.total_cost_usd || 0).toFixed(4)}`,
      );
    }
    lines.push('');
  }

  if (by_agent.length > 0) {
    lines.push('*Top 에이전트:*');
    for (const row of by_agent.slice(0, 5)) {
      lines.push(`  \`${row.agent}\` (${row.provider}): ${row.calls}회 avg ${row.avg_ms}ms`);
    }
  }

  const message = lines.join('\n');
  console.log('[llm-daily-report]', message);
  await telegramSender.send('general', message);
  console.log('[llm-daily-report] Telegram 전송 완료');
  return { ok: true, message, statsSource: data.stats_source || 'hub_http' };
}

if (require.main === module) {
  generateReport().catch((err: Error) => {
    console.error('[llm-daily-report] 실패:', err.message);
    process.exit(1);
  });
}

export {
  fetchStats,
  fetchStatsFromDb,
  generateReport,
};

export const _testOnly = {
  setDependencies(deps: { telegramSender?: any; pgPool?: any; fetchImpl?: typeof fetch }) {
    if (deps.telegramSender) telegramSender = deps.telegramSender;
    if (deps.pgPool) pgPool = deps.pgPool;
    if (deps.fetchImpl) fetchImpl = deps.fetchImpl;
  },
};
