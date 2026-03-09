'use strict';
const fs   = require('fs');
const path = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));

async function run() {
  const sql = fs.readFileSync(path.join(__dirname, '009-trace-id.sql'), 'utf-8');

  // worker 스키마 DDL (audit_log)
  await pgPool.query('worker', `
    ALTER TABLE worker.audit_log
    ADD COLUMN IF NOT EXISTS trace_id UUID DEFAULT NULL;
  `);
  await pgPool.query('worker', `
    CREATE INDEX IF NOT EXISTS idx_audit_log_trace_id
    ON worker.audit_log (trace_id) WHERE trace_id IS NOT NULL;
  `);
  await pgPool.query('worker', `
    COMMENT ON COLUMN worker.audit_log.trace_id IS
    '통합 추적 ID — HTTP 요청과 연결된 추적 ID';
  `);

  // reservation 스키마 DDL (agent_events, agent_tasks, tool_calls)
  await pgPool.query('reservation', `
    ALTER TABLE reservation.agent_events
    ADD COLUMN IF NOT EXISTS trace_id UUID DEFAULT NULL;
  `);
  await pgPool.query('reservation', `
    ALTER TABLE reservation.agent_tasks
    ADD COLUMN IF NOT EXISTS trace_id UUID DEFAULT NULL;
  `);
  await pgPool.query('reservation', `
    CREATE TABLE IF NOT EXISTS reservation.tool_calls (
      id            BIGSERIAL PRIMARY KEY,
      trace_id      UUID DEFAULT NULL,
      bot           TEXT NOT NULL DEFAULT 'unknown',
      tool_name     TEXT NOT NULL,
      action        TEXT NOT NULL,
      success       BOOLEAN NOT NULL DEFAULT true,
      duration_ms   INTEGER DEFAULT 0,
      error         TEXT DEFAULT NULL,
      metadata      JSONB NOT NULL DEFAULT '{}',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pgPool.query('reservation', `
    CREATE INDEX IF NOT EXISTS idx_agent_events_trace_id
    ON reservation.agent_events (trace_id) WHERE trace_id IS NOT NULL;
  `);
  await pgPool.query('reservation', `
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_trace_id
    ON reservation.agent_tasks (trace_id) WHERE trace_id IS NOT NULL;
  `);
  await pgPool.query('reservation', `
    CREATE INDEX IF NOT EXISTS idx_tool_calls_trace_id
    ON reservation.tool_calls (trace_id) WHERE trace_id IS NOT NULL;
  `);
  await pgPool.query('reservation', `
    CREATE INDEX IF NOT EXISTS idx_tool_calls_bot_tool
    ON reservation.tool_calls (bot, tool_name, created_at);
  `);
  await pgPool.query('reservation', `
    CREATE INDEX IF NOT EXISTS idx_tool_calls_created_at
    ON reservation.tool_calls (created_at DESC);
  `);

  console.log('✅ 009-trace-id 마이그레이션 완료');
}

run().catch(e => { console.error('❌ 마이그레이션 실패:', e.message); process.exit(1); });
