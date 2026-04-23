// @ts-nocheck
const { checkTokenHealth, checkOpenAIOAuthHealth, checkGroqAccounts } = require('../llm/oauth-monitor');
const pgPool = require('../../../../packages/core/lib/pg-pool');
const { BudgetGuardian } = require('../budget-guardian');

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
