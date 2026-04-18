// @ts-nocheck
const { checkTokenHealth, checkGroqAccounts } = require('../llm/oauth-monitor');
const pgPool = require('../../../../packages/core/lib/pg-pool');
const { BudgetGuardian } = require('../budget-guardian');

export async function llmHealthRoute(_req: any, res: any) {
  const [oauth, groq, cacheCheck] = await Promise.all([
    checkTokenHealth(),
    checkGroqAccounts(),
    checkCacheDb(),
  ]);

  const budget = BudgetGuardian.getInstance().getCurrentUsage();
  const overall = oauth.healthy && groq.available_accounts > 0 && !budget.emergency;

  res.json({
    ok: overall,
    timestamp: new Date().toISOString(),
    components: {
      oauth: {
        healthy: oauth.healthy,
        expires_in_hours: Math.round(oauth.expires_in_hours * 10) / 10,
        needs_refresh: oauth.needs_refresh,
        error: oauth.error,
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
    const r = await pgPool.query(`SELECT COUNT(*) AS n, COALESCE(SUM(hit_count), 0) AS hits FROM llm_cache WHERE inserted_at > NOW() - INTERVAL '24h'`);
    return { connected: true, total_entries: Number(r.rows[0]?.n || 0), hit_rate_24h: Number(r.rows[0]?.hits || 0) };
  } catch {
    return { connected: false, total_entries: 0, hit_rate_24h: 0 };
  }
}
