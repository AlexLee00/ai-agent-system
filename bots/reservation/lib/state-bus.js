'use strict';

/**
 * lib/state-bus.js — 에이전트 간 상태 공유 버스 (Phase 3: PostgreSQL reservation 스키마)
 *
 * agent_state / pickko_lock / pending_blocks / agent_events / agent_tasks 테이블 사용
 */

const pgPool = require('../../../packages/core/lib/pg-pool');

const SCHEMA = 'reservation';

const PRIORITY_ORDER = `CASE priority
  WHEN 'critical' THEN 0 WHEN 'high' THEN 1
  WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END`;

// ─── 에이전트 상태 ──────────────────────────────────────────────────

async function updateAgentState(agent, status, currentTask = null, errorMsg = null) {
  const now = new Date().toISOString();
  const lastSuccess = (status === 'idle') ? now : null;

  try {
    if (lastSuccess !== null) {
      await pgPool.run(SCHEMA, `
        INSERT INTO agent_state (agent, status, current_task, last_success_at, last_error, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT(agent) DO UPDATE SET
          status          = EXCLUDED.status,
          current_task    = EXCLUDED.current_task,
          last_success_at = EXCLUDED.last_success_at,
          last_error      = EXCLUDED.last_error,
          updated_at      = EXCLUDED.updated_at
      `, [agent, status, currentTask, now, errorMsg, now]);
    } else {
      await pgPool.run(SCHEMA, `
        INSERT INTO agent_state (agent, status, current_task, last_success_at, last_error, updated_at)
        VALUES ($1,$2,$3,NULL,$4,$5)
        ON CONFLICT(agent) DO UPDATE SET
          status       = EXCLUDED.status,
          current_task = EXCLUDED.current_task,
          last_error   = EXCLUDED.last_error,
          updated_at   = EXCLUDED.updated_at
      `, [agent, status, currentTask, errorMsg, now]);
    }
  } catch (e) {
    console.error('[state-bus] updateAgentState 실패:', e.message);
  }
}

async function getAgentState(agent) {
  try {
    return pgPool.get(SCHEMA, 'SELECT * FROM agent_state WHERE agent = $1', [agent]);
  } catch (e) {
    console.error('[state-bus] getAgentState 실패:', e.message);
    return null;
  }
}

async function getAllAgentStates() {
  try {
    return pgPool.query(SCHEMA, 'SELECT * FROM agent_state ORDER BY agent');
  } catch (e) {
    console.error('[state-bus] getAllAgentStates 실패:', e.message);
    return [];
  }
}

// ─── 픽코 락 ────────────────────────────────────────────────────────

async function acquirePickkoLock(agentName, ttlMs = 5 * 60 * 1000) {
  try {
    await cleanupExpiredLock();

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const nowStr = now.toISOString();

    const result = await pgPool.run(SCHEMA, `
      UPDATE pickko_lock
      SET locked_by = $1, locked_at = $2, expires_at = $3
      WHERE id = 1 AND locked_by IS NULL
    `, [agentName, nowStr, expiresAt]);

    return result.rowCount === 1;
  } catch (e) {
    console.error('[state-bus] acquirePickkoLock 실패:', e.message);
    return false;
  }
}

async function releasePickkoLock(agentName) {
  try {
    const result = await pgPool.run(SCHEMA, `
      UPDATE pickko_lock
      SET locked_by = NULL, locked_at = NULL, expires_at = NULL
      WHERE id = 1 AND locked_by = $1
    `, [agentName]);
    return result.rowCount === 1;
  } catch (e) {
    console.error('[state-bus] releasePickkoLock 실패:', e.message);
    return false;
  }
}

async function isPickkoLocked() {
  try {
    const row = await pgPool.get(SCHEMA, 'SELECT * FROM pickko_lock WHERE id = 1');
    if (!row || !row.locked_by) return { locked: false, by: null, expiresAt: null };
    return {
      locked: true,
      by: row.locked_by,
      expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    };
  } catch (e) {
    console.error('[state-bus] isPickkoLocked 실패:', e.message);
    return { locked: false, by: null, expiresAt: null };
  }
}

async function cleanupExpiredLock() {
  try {
    const now = new Date().toISOString();
    await pgPool.run(SCHEMA, `
      UPDATE pickko_lock
      SET locked_by = NULL, locked_at = NULL, expires_at = NULL
      WHERE id = 1 AND expires_at IS NOT NULL AND expires_at < $1
    `, [now]);
  } catch (e) {
    console.error('[state-bus] cleanupExpiredLock 실패:', e.message);
  }
}

// ─── 블록 요청 큐 (앤디→지미) ──────────────────────────────────────

async function enqueuePendingBlock(phoneEnc, date, reason = null, requestedBy = 'andy') {
  try {
    const now = new Date().toISOString();
    const rows = await pgPool.query(SCHEMA, `
      INSERT INTO pending_blocks (phone_enc, date, reason, requested_by, status, created_at)
      VALUES ($1,$2,$3,$4,'pending',$5)
      RETURNING id
    `, [phoneEnc, date, reason, requestedBy, now]);
    return rows[0].id;
  } catch (e) {
    console.error('[state-bus] enqueuePendingBlock 실패:', e.message);
    return null;
  }
}

async function dequeuePendingBlocks() {
  try {
    return pgPool.query(SCHEMA,
      "SELECT * FROM pending_blocks WHERE status = 'pending' ORDER BY created_at");
  } catch (e) {
    console.error('[state-bus] dequeuePendingBlocks 실패:', e.message);
    return [];
  }
}

async function markBlockProcessed(id, status = 'done') {
  try {
    const now = new Date().toISOString();
    await pgPool.run(SCHEMA,
      'UPDATE pending_blocks SET status = $1, processed_at = $2 WHERE id = $3',
      [status, now, id]);
  } catch (e) {
    console.error('[state-bus] markBlockProcessed 실패:', e.message);
  }
}

// ─── 이벤트 버스 (팀원 → 팀장) ─────────────────────────────────────

async function emitEvent(fromAgent, toAgent, eventType, payload, priority = 'normal') {
  try {
    const now = new Date().toISOString();
    const rows = await pgPool.query(SCHEMA, `
      INSERT INTO agent_events (from_agent, to_agent, event_type, priority, payload, created_at)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING id
    `, [fromAgent, toAgent, eventType, priority, JSON.stringify(payload ?? null), now]);
    return rows[0].id;
  } catch (e) {
    console.error('[state-bus] emitEvent 실패:', e.message);
    return null;
  }
}

async function getUnprocessedEvents(toAgent, limit = 20) {
  try {
    return pgPool.query(SCHEMA, `
      SELECT * FROM agent_events
      WHERE to_agent = $1 AND processed = 0
      ORDER BY ${PRIORITY_ORDER}, created_at ASC
      LIMIT $2
    `, [toAgent, limit]);
  } catch (e) {
    console.error('[state-bus] getUnprocessedEvents 실패:', e.message);
    return [];
  }
}

async function markEventProcessed(eventId) {
  try {
    const now = new Date().toISOString();
    await pgPool.run(SCHEMA,
      'UPDATE agent_events SET processed = 1, processed_at = $1 WHERE id = $2',
      [now, eventId]);
  } catch (e) {
    console.error('[state-bus] markEventProcessed 실패:', e.message);
  }
}

// ─── 작업 버스 (팀장 → 팀원) ────────────────────────────────────────

async function createTask(fromAgent, toAgent, taskType, payload, priority = 'normal') {
  try {
    const now = new Date().toISOString();
    const rows = await pgPool.query(SCHEMA, `
      INSERT INTO agent_tasks (from_agent, to_agent, task_type, priority, payload, status, created_at)
      VALUES ($1,$2,$3,$4,$5,'pending',$6)
      RETURNING id
    `, [fromAgent, toAgent, taskType, priority, JSON.stringify(payload ?? null), now]);
    return rows[0].id;
  } catch (e) {
    console.error('[state-bus] createTask 실패:', e.message);
    return null;
  }
}

async function getPendingTasks(toAgent) {
  try {
    return pgPool.query(SCHEMA, `
      SELECT * FROM agent_tasks
      WHERE to_agent = $1 AND status = 'pending'
      ORDER BY ${PRIORITY_ORDER}, created_at ASC
    `, [toAgent]);
  } catch (e) {
    console.error('[state-bus] getPendingTasks 실패:', e.message);
    return [];
  }
}

async function completeTask(taskId, result) {
  try {
    const now = new Date().toISOString();
    await pgPool.run(SCHEMA,
      "UPDATE agent_tasks SET status = 'completed', result = $1, completed_at = $2 WHERE id = $3",
      [JSON.stringify(result ?? null), now, taskId]);
  } catch (e) {
    console.error('[state-bus] completeTask 실패:', e.message);
  }
}

async function failTask(taskId, error) {
  try {
    const now = new Date().toISOString();
    await pgPool.run(SCHEMA,
      "UPDATE agent_tasks SET status = 'failed', result = $1, completed_at = $2 WHERE id = $3",
      [JSON.stringify({ error }), now, taskId]);
  } catch (e) {
    console.error('[state-bus] failTask 실패:', e.message);
  }
}

module.exports = {
  updateAgentState,
  getAgentState,
  getAllAgentStates,
  acquirePickkoLock,
  releasePickkoLock,
  isPickkoLocked,
  cleanupExpiredLock,
  enqueuePendingBlock,
  dequeuePendingBlocks,
  markBlockProcessed,
  // 이벤트 버스
  emitEvent,
  getUnprocessedEvents,
  markEventProcessed,
  // 작업 버스
  createTask,
  getPendingTasks,
  completeTask,
  failTask,
};
