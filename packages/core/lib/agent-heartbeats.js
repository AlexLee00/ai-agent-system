'use strict';

const pgPool = require('./pg-pool');

const SCHEMA = 'claude';

async function ensureHeartbeatTable() {
  await pgPool.run(SCHEMA, `
    CREATE TABLE IF NOT EXISTS agent_heartbeats (
      agent_name TEXT PRIMARY KEY,
      last_heartbeat TIMESTAMP DEFAULT NOW(),
      status TEXT DEFAULT 'ok',
      meta JSONB DEFAULT '{}'::jsonb
    )
  `);
}

async function writeHeartbeat(agentName, status = 'ok', meta = {}) {
  if (!agentName) return;
  await ensureHeartbeatTable();
  await pgPool.run(SCHEMA, `
    INSERT INTO agent_heartbeats (agent_name, last_heartbeat, status, meta)
    VALUES ($1, NOW(), $2, $3::jsonb)
    ON CONFLICT (agent_name) DO UPDATE SET
      last_heartbeat = NOW(),
      status = EXCLUDED.status,
      meta = EXCLUDED.meta
  `, [agentName, status, JSON.stringify(meta || {})]);
}

async function listHeartbeats() {
  await ensureHeartbeatTable();
  return pgPool.query(SCHEMA, `
    SELECT agent_name, last_heartbeat, status, meta
    FROM agent_heartbeats
    ORDER BY agent_name ASC
  `);
}

module.exports = {
  ensureHeartbeatTable,
  writeHeartbeat,
  listHeartbeats,
};
