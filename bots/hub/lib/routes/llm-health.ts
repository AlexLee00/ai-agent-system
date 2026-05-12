// @ts-nocheck
const { checkTokenHealth, checkOpenAIOAuthHealth, checkGroqAccounts } = require('../llm/oauth-monitor');
const pgPool = require('../../../../packages/core/lib/pg-pool');
const { BudgetGuardian } = require('../budget-guardian');
const {
  getAllCircuitStatuses,
  resetCircuit,
} = require('../../../../packages/core/lib/local-circuit-breaker');
const { resetProviderCircuit } = require('../llm/provider-registry');

export async function llmHealthRoute(_req: any, res: any) {
  const [claudeOauth, openaiOauth, groq, cacheCheck] = await Promise.all([
    checkTokenHealth(),
    checkOpenAIOAuthHealth(),
    checkGroqAccounts(),
    checkCacheDb(),
  ]);

  const budget = BudgetGuardian.getInstance().getCurrentUsage();
  const overall = claudeOauth.healthy && openaiOauth.healthy && groq.available_accounts > 0 && !budget.emergency;

  res.json({
    ok: overall,
    timestamp: new Date().toISOString(),
    components: {
      claude_oauth: {
        healthy: claudeOauth.healthy,
        expires_in_hours: Math.round(claudeOauth.expires_in_hours * 10) / 10,
        needs_refresh: claudeOauth.needs_refresh,
        auth_method: claudeOauth.auth_method,
        account: claudeOauth.account,
        error: claudeOauth.error,
      },
      openai_oauth: {
        healthy: openaiOauth.healthy,
        token_present: openaiOauth.token_present,
        source: openaiOauth.source,
        model: openaiOauth.model,
        error: openaiOauth.error,
      },
      groq: groq,
      budget: {
        global_used_usd: budget.global_used,
        global_limit_usd: budget.global_limit,
        global_ratio: budget.global_ratio,
        emergency: budget.emergency,
      },
      cache: cacheCheck,
    },
  });
}

// GET /hub/llm/tier-probe
// OPEN/HALF_OPEN 상태의 로컬 프로바이더를 능동 탐지해 회로 복구 시도.
// OAuth 프로바이더는 ai.hub.llm-oauth-monitor에서 처리하므로 여기서는 local/* 전용.
export async function llmTierProbeRoute(_req: any, res: any) {
  const statuses = getAllCircuitStatuses();
  const results: Array<{
    provider: string;
    state: string;
    action: string;
    reason: string;
  }> = [];

  const localBaseUrl = process.env.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:11434';

  for (const [key, status] of Object.entries(statuses) as [string, any][]) {
    if (status.state === 'CLOSED') continue;

    if (key.startsWith('local/')) {
      try {
        const resp = await fetch(`${localBaseUrl}/v1/models`, {
          signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) {
          resetCircuit(key);
          resetProviderCircuit(key);
          results.push({ provider: key, state: status.state, action: 'reset', reason: 'ollama_healthy' });
        } else {
          results.push({ provider: key, state: status.state, action: 'keep_open', reason: `ollama_http_${resp.status}` });
        }
      } catch {
        results.push({ provider: key, state: status.state, action: 'keep_open', reason: 'ollama_unreachable' });
      }
    } else {
      // OAuth/외부 프로바이더: 상태만 보고 (oauth-monitor 담당)
      results.push({ provider: key, state: status.state, action: 'skip', reason: 'handled_by_oauth_monitor' });
    }
  }

  const recovered = results.filter(r => r.action === 'reset').length;
  console.log(`[tier-probe] probed=${results.length} recovered=${recovered}`);

  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    total_circuits: Object.keys(statuses).length,
    non_closed: results.length,
    recovered,
    results,
  });
}

async function checkCacheDb(): Promise<{ connected: boolean; total_entries: number; hit_rate_24h: number }> {
  try {
    const rows = await pgPool.query(
      'public',
      `SELECT COUNT(*) AS n, COALESCE(SUM(hit_count), 0) AS hits
       FROM llm_cache
       WHERE inserted_at > NOW() - INTERVAL '24h'`
    );
    return { connected: true, total_entries: Number(rows[0]?.n || 0), hit_rate_24h: Number(rows[0]?.hits || 0) };
  } catch {
    return { connected: false, total_entries: 0, hit_rate_24h: 0 };
  }
}
