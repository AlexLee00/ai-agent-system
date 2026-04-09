'use strict';

const pgPool = require('../../../../packages/core/lib/pg-pool');
const { validateSchema, validateSql } = require('../sql-guard');

async function pgQueryRoute(req, res) {
  const started = Date.now();
  const { sql, schema = 'public', params = [] } = req.body || {};

  const schemaCheck = validateSchema(schema);
  if (!schemaCheck.ok) {
    return res.status(400).json({ error: 'query rejected', reason: schemaCheck.reason });
  }

  const sqlCheck = validateSql(sql);
  if (!sqlCheck.ok) {
    return res.status(400).json({ error: 'query rejected', reason: sqlCheck.reason });
  }

  if (!Array.isArray(params)) {
    return res.status(400).json({ error: 'query rejected', reason: 'params must be an array' });
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
  } catch (error) {
    return res.status(500).json({
      error: 'query failed',
      reason: String(error?.message || 'pg_query_failed'),
      duration_ms: Date.now() - started,
    });
  }
}

module.exports = {
  pgQueryRoute,
};
