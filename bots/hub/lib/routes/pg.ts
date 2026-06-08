const pgPool = require('../../../../packages/core/lib/pg-pool');
const { validateSchema, validateSql } = require('../sql-guard');
const { recordHubRuntimeErrorPatternAsync } = require('../autonomy/runtime-error-learning');

function envInt(name: string, fallback: number, min = 0, max = 1000) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function resolvePgWaitingLimit() {
  return envInt('HUB_PG_WAITING_LIMIT', 5, 0, 1000);
}

export function resolvePgActiveLimit() {
  const poolMax = envInt('PG_POOL_MAX', 8, 1, 100);
  return envInt('HUB_PG_ACTIVE_LIMIT', poolMax, 1, 100);
}

export function shouldDeferPgQuery(poolStats: any) {
  const waiting = Number(poolStats?.waiting || 0);
  const active = Number(poolStats?.active || 0);
  const total = Number(poolStats?.total || 0);
  const waitingLimit = resolvePgWaitingLimit();
  const activeLimit = resolvePgActiveLimit();
  if (waiting > waitingLimit) return { defer: true, reason: 'waiting_limit', waiting, active, total, waitingLimit, activeLimit };
  if (active >= activeLimit) return { defer: true, reason: 'active_limit', waiting, active, total, waitingLimit, activeLimit };
  return { defer: false, reason: 'ok', waiting, active, total, waitingLimit, activeLimit };
}

function suggestedPgPoolMax(active: number, waiting: number) {
  const current = envInt('PG_POOL_MAX', 2, 1, 100);
  const demand = Math.max(active + waiting, current + 1);
  return Math.min(16, Math.max(current + 1, demand));
}

export async function pgQueryRoute(req: any, res: any) {
  const started = Date.now();
  const { sql, schema = 'public', params = [] } = req.body || {};
  const sqlSnippet = String(sql || '').trim().replace(/\s+/g, ' ').slice(0, 160);

  const schemaCheck = validateSchema(schema);
  if (!schemaCheck.ok) {
    console.warn(`[hub/pg] rejected schema=${String(schema)} reason=${schemaCheck.reason} sql=${sqlSnippet}`);
    return res.status(400).json({ error: 'query rejected', reason: schemaCheck.reason });
  }

  const sqlCheck = validateSql(sql);
  if (!sqlCheck.ok) {
    console.warn(`[hub/pg] rejected schema=${schemaCheck.schema} reason=${sqlCheck.reason} sql=${sqlSnippet}`);
    if (String(sqlCheck.reason || '').startsWith('blocked keyword:')) {
      recordHubRuntimeErrorPatternAsync({
        errorType: 'readonly_write_rejected',
        route: req.originalUrl || req.path || '/hub/pg/query',
        routeClass: `${schemaCheck.schema}:write`,
        method: req.method || 'POST',
        status: 400,
        currentValue: '/hub/pg/query',
        suggestedValue: schemaCheck.schema === 'blog' && /\btopic_candidates\b/i.test(String(sql || ''))
          ? '/hub/blog/topic-candidates'
          : 'typed_mutation_endpoint',
        rationale: '/hub/pg/query is read-only; repeated write attempts must be routed to typed mutation APIs with validation.',
        traceId: req.hubRequestContext?.traceId || '',
        evidence: {
          schema: schemaCheck.schema,
          reason: sqlCheck.reason,
          sql_snippet: sqlSnippet,
        },
      });
    }
    return res.status(400).json({ error: 'query rejected', reason: sqlCheck.reason });
  }

  if (!Array.isArray(params)) {
    console.warn(`[hub/pg] rejected schema=${schemaCheck.schema} reason=params_must_be_array sql=${sqlSnippet}`);
    return res.status(400).json({ error: 'query rejected', reason: 'params must be an array' });
  }

  const poolStats = pgPool.getReadonlyPoolStats?.(schemaCheck.schema) || pgPool.getPoolStats?.(schemaCheck.schema);
  if (poolStats && typeof poolStats === 'object') {
    const overload = shouldDeferPgQuery(poolStats);
    if (overload.defer) {
      recordHubRuntimeErrorPatternAsync({
        errorType: 'pg_pool_overloaded',
        route: req.originalUrl || req.path || '/hub/pg/query',
        routeClass: `${schemaCheck.schema}:readonly`,
        method: req.method || 'POST',
        status: 503,
        currentValue: `active=${overload.active},waiting=${overload.waiting},active_limit=${overload.activeLimit},waiting_limit=${overload.waitingLimit}`,
        suggestedValue: `PG_POOL_MAX=${suggestedPgPoolMax(overload.active, overload.waiting)}`,
        rationale: 'Repeated pg pool deferrals should tune pool capacity and route-specific query pressure instead of relying on fixed thresholds.',
        traceId: req.hubRequestContext?.traceId || '',
        evidence: {
          schema: schemaCheck.schema,
          reason: overload.reason,
          pool: {
            waiting: overload.waiting,
            active: overload.active,
            total: overload.total,
            utilization: String(poolStats.utilization || '0%'),
          },
          sigma_feedback_loop: true,
          claude_pattern: 'failure_trajectory_runtime_tuning',
        },
      });
      res.set('Retry-After', '2');
      return res.status(503).json({
        error: 'query deferred',
        reason: 'pg_pool_overloaded',
        duration_ms: Date.now() - started,
        pool: {
          schema: schemaCheck.schema,
          waiting: overload.waiting,
          active: overload.active,
          total: overload.total,
          utilization: String(poolStats.utilization || '0%'),
        },
        retry_after_ms: 1500,
      });
    }
  }

  try {
    const rows = await pgPool.queryReadonly
      ? await pgPool.queryReadonly(schemaCheck.schema, sqlCheck.sql, params)
      : await pgPool.query(schemaCheck.schema, sqlCheck.sql, params);
    return res.json({
      ok: true,
      schema: schemaCheck.schema,
      rowCount: rows.length,
      rows,
      duration_ms: Date.now() - started,
    });
  } catch (error: any) {
    console.warn(
      `[hub/pg] query failed schema=${schemaCheck.schema} reason=${String(error?.message || 'pg_query_failed')} sql=${sqlSnippet}`
    );
    return res.status(500).json({
      error: 'query failed',
      reason: String(error?.message || 'pg_query_failed'),
      duration_ms: Date.now() - started,
    });
  }
}
