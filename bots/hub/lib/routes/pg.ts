const pgPool = require('../../../../packages/core/lib/pg-pool');
const { validateSchema, validateSql } = require('../sql-guard');
const PG_WAITING_LIMIT = 5;
const PG_ACTIVE_LIMIT = 8;

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
    return res.status(400).json({ error: 'query rejected', reason: sqlCheck.reason });
  }

  if (!Array.isArray(params)) {
    console.warn(`[hub/pg] rejected schema=${schemaCheck.schema} reason=params_must_be_array sql=${sqlSnippet}`);
    return res.status(400).json({ error: 'query rejected', reason: 'params must be an array' });
  }

  const poolStats = pgPool.getPoolStats?.(schemaCheck.schema);
  if (poolStats && typeof poolStats === 'object') {
    const waiting = Number(poolStats.waiting || 0);
    const active = Number(poolStats.active || 0);
    if (waiting > PG_WAITING_LIMIT || active >= PG_ACTIVE_LIMIT) {
      res.set('Retry-After', '2');
      return res.status(503).json({
        error: 'query deferred',
        reason: 'pg_pool_overloaded',
        duration_ms: Date.now() - started,
        pool: {
          schema: schemaCheck.schema,
          waiting,
          active,
          total: Number(poolStats.total || 0),
          utilization: String(poolStats.utilization || '0%'),
        },
        retry_after_ms: 1500,
      });
    }
  }

  try {
    const rows = await pgPool.query(schemaCheck.schema, sqlCheck.sql, params);
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
