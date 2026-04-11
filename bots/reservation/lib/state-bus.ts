const pgPool = require('../../../packages/core/lib/pg-pool');

const SCHEMA = 'reservation';

const PRIORITY_ORDER = `CASE priority
  WHEN 'critical' THEN 0 WHEN 'high' THEN 1
  WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END`;

const MANUAL_PICKKO_AGENT = 'manual_pickko';
const MANUAL_PICKKO_ACTIVE_MS = 20 * 60 * 1000;

export type AgentStatus = 'idle' | 'running' | 'error' | 'starting';
export type Priority = 'critical' | 'high' | 'normal' | 'low';

export interface AgentStateRow {
  agent?: string;
  status?: string;
  current_task?: string | null;
  last_success_at?: string | null;
  last_error?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
}

export interface PickkoLockState {
  locked: boolean;
  by: string | null;
  expiresAt: Date | null;
}

async function run(sql: string, params: unknown[] = []) {
  return pgPool.run(SCHEMA, sql, params);
}

async function query(sql: string, params: unknown[] = []) {
  return pgPool.query(SCHEMA, sql, params);
}

async function get(sql: string, params: unknown[] = []) {
  return pgPool.get(SCHEMA, sql, params);
}

export async function updateAgentState(
  agent: string,
  status: AgentStatus | string,
  currentTask: string | null = null,
  errorMsg: string | null = null,
): Promise<void> {
  const now = new Date().toISOString();
  const lastSuccess = status === 'idle' ? now : null;

  try {
    if (lastSuccess !== null) {
      await run(`
        INSERT INTO agent_state (agent, status, current_task, last_success_at, last_error, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT(agent) DO UPDATE SET
          status          = EXCLUDED.status,
          current_task    = EXCLUDED.current_task,
          last_success_at = EXCLUDED.last_success_at,
          last_error      = EXCLUDED.last_error,
          updated_at      = EXCLUDED.updated_at
      `, [agent, status, currentTask, now, errorMsg, now]);
      return;
    }

    await run(`
      INSERT INTO agent_state (agent, status, current_task, last_success_at, last_error, updated_at)
      VALUES ($1,$2,$3,NULL,$4,$5)
      ON CONFLICT(agent) DO UPDATE SET
        status       = EXCLUDED.status,
        current_task = EXCLUDED.current_task,
        last_error   = EXCLUDED.last_error,
        updated_at   = EXCLUDED.updated_at
    `, [agent, status, currentTask, errorMsg, now]);
  } catch (error) {
    console.error('[state-bus] updateAgentState 실패:', (error as Error).message);
  }
}

export async function getAgentState(agent: string): Promise<AgentStateRow | null> {
  try {
    return await get('SELECT * FROM agent_state WHERE agent = $1', [agent]);
  } catch (error) {
    console.error('[state-bus] getAgentState 실패:', (error as Error).message);
    return null;
  }
}

export async function getAllAgentStates(): Promise<AgentStateRow[]> {
  try {
    return await query('SELECT * FROM agent_state ORDER BY agent');
  } catch (error) {
    console.error('[state-bus] getAllAgentStates 실패:', (error as Error).message);
    return [];
  }
}

export async function cleanupExpiredLock(): Promise<void> {
  try {
    const now = new Date().toISOString();
    await run(`
      UPDATE pickko_lock
      SET locked_by = NULL, locked_at = NULL, expires_at = NULL
      WHERE id = 1 AND expires_at IS NOT NULL AND expires_at < $1
    `, [now]);
  } catch (error) {
    console.error('[state-bus] cleanupExpiredLock 실패:', (error as Error).message);
  }
}

export async function acquirePickkoLock(agentName: string, ttlMs = 5 * 60 * 1000): Promise<boolean> {
  try {
    await cleanupExpiredLock();

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const nowStr = now.toISOString();

    const result = await run(`
      UPDATE pickko_lock
      SET locked_by = $1, locked_at = $2, expires_at = $3
      WHERE id = 1 AND locked_by IS NULL
    `, [agentName, nowStr, expiresAt]);

    return result.rowCount === 1;
  } catch (error) {
    console.error('[state-bus] acquirePickkoLock 실패:', (error as Error).message);
    return false;
  }
}

export async function releasePickkoLock(agentName: string): Promise<boolean> {
  try {
    const result = await run(`
      UPDATE pickko_lock
      SET locked_by = NULL, locked_at = NULL, expires_at = NULL
      WHERE id = 1 AND locked_by = $1
    `, [agentName]);
    return result.rowCount === 1;
  } catch (error) {
    console.error('[state-bus] releasePickkoLock 실패:', (error as Error).message);
    return false;
  }
}

export async function isPickkoLocked(): Promise<PickkoLockState> {
  try {
    const row = await get('SELECT * FROM pickko_lock WHERE id = 1');
    if (!row || !row.locked_by) return { locked: false, by: null, expiresAt: null };
    return {
      locked: true,
      by: row.locked_by as string,
      expiresAt: row.expires_at ? new Date(String(row.expires_at)) : null,
    };
  } catch (error) {
    console.error('[state-bus] isPickkoLocked 실패:', (error as Error).message);
    return { locked: false, by: null, expiresAt: null };
  }
}

export async function setManualPickkoPriority(currentTask = 'manual_reservation'): Promise<void> {
  await updateAgentState(MANUAL_PICKKO_AGENT, 'running', currentTask, null);
}

export async function clearManualPickkoPriority(): Promise<void> {
  await updateAgentState(MANUAL_PICKKO_AGENT, 'idle', null, null);
}

export async function isManualPickkoPriorityActive(activeMs = MANUAL_PICKKO_ACTIVE_MS) {
  try {
    const row = await getAgentState(MANUAL_PICKKO_AGENT);
    if (!row || row.status !== 'running') return { active: false, task: null, updatedAt: null };
    const updatedAt = row.updated_at ? new Date(String(row.updated_at)) : null;
    if (!updatedAt || Number.isNaN(updatedAt.getTime())) {
      return { active: true, task: row.current_task || null, updatedAt: null };
    }
    const active = Date.now() - updatedAt.getTime() <= activeMs;
    return {
      active,
      task: row.current_task || null,
      updatedAt,
    };
  } catch (error) {
    console.error('[state-bus] isManualPickkoPriorityActive 실패:', (error as Error).message);
    return { active: false, task: null, updatedAt: null };
  }
}

export async function enqueuePendingBlock(
  phoneEnc: string,
  date: string,
  reason: string | null = null,
  requestedBy = 'andy',
): Promise<number | null> {
  try {
    const now = new Date().toISOString();
    const rows = await query(`
      INSERT INTO pending_blocks (phone_enc, date, reason, requested_by, status, created_at)
      VALUES ($1,$2,$3,$4,'pending',$5)
      RETURNING id
    `, [phoneEnc, date, reason, requestedBy, now]);
    return (rows[0]?.id as number) || null;
  } catch (error) {
    console.error('[state-bus] enqueuePendingBlock 실패:', (error as Error).message);
    return null;
  }
}

export async function dequeuePendingBlocks(): Promise<Record<string, unknown>[]> {
  try {
    return await query(`SELECT * FROM pending_blocks WHERE status = 'pending' ORDER BY created_at`);
  } catch (error) {
    console.error('[state-bus] dequeuePendingBlocks 실패:', (error as Error).message);
    return [];
  }
}

export async function markBlockProcessed(id: number | string, status = 'done'): Promise<void> {
  try {
    const now = new Date().toISOString();
    await run(
      'UPDATE pending_blocks SET status = $1, processed_at = $2 WHERE id = $3',
      [status, now, id],
    );
  } catch (error) {
    console.error('[state-bus] markBlockProcessed 실패:', (error as Error).message);
  }
}

export async function emitEvent(
  fromAgent: string,
  toAgent: string,
  eventType: string,
  payload: unknown,
  priority: Priority | string = 'normal',
): Promise<number | null> {
  try {
    const now = new Date().toISOString();
    const rows = await query(`
      INSERT INTO agent_events (from_agent, to_agent, event_type, priority, payload, created_at)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING id
    `, [fromAgent, toAgent, eventType, priority, JSON.stringify(payload ?? null), now]);
    return (rows[0]?.id as number) || null;
  } catch (error) {
    console.error('[state-bus] emitEvent 실패:', (error as Error).message);
    return null;
  }
}

export async function getUnprocessedEvents(toAgent: string, limit = 20): Promise<Record<string, unknown>[]> {
  try {
    return await query(`
      SELECT * FROM agent_events
      WHERE to_agent = $1 AND processed = 0
      ORDER BY ${PRIORITY_ORDER}, created_at ASC
      LIMIT $2
    `, [toAgent, limit]);
  } catch (error) {
    console.error('[state-bus] getUnprocessedEvents 실패:', (error as Error).message);
    return [];
  }
}

export async function markEventProcessed(eventId: number | string): Promise<void> {
  try {
    const now = new Date().toISOString();
    await run(
      'UPDATE agent_events SET processed = 1, processed_at = $1 WHERE id = $2',
      [now, eventId],
    );
  } catch (error) {
    console.error('[state-bus] markEventProcessed 실패:', (error as Error).message);
  }
}

export async function createTask(
  fromAgent: string,
  toAgent: string,
  taskType: string,
  payload: unknown,
  priority: Priority | string = 'normal',
): Promise<number | null> {
  try {
    const now = new Date().toISOString();
    const rows = await query(`
      INSERT INTO agent_tasks (from_agent, to_agent, task_type, priority, payload, status, created_at)
      VALUES ($1,$2,$3,$4,$5,'pending',$6)
      RETURNING id
    `, [fromAgent, toAgent, taskType, priority, JSON.stringify(payload ?? null), now]);
    return (rows[0]?.id as number) || null;
  } catch (error) {
    console.error('[state-bus] createTask 실패:', (error as Error).message);
    return null;
  }
}

export async function getPendingTasks(toAgent: string): Promise<Record<string, unknown>[]> {
  try {
    return await query(`
      SELECT * FROM agent_tasks
      WHERE to_agent = $1 AND status = 'pending'
      ORDER BY ${PRIORITY_ORDER}, created_at ASC
    `, [toAgent]);
  } catch (error) {
    console.error('[state-bus] getPendingTasks 실패:', (error as Error).message);
    return [];
  }
}

export async function completeTask(taskId: number | string, result: unknown): Promise<void> {
  try {
    const now = new Date().toISOString();
    await run(
      "UPDATE agent_tasks SET status = 'completed', result = $1, completed_at = $2 WHERE id = $3",
      [JSON.stringify(result ?? null), now, taskId],
    );
  } catch (error) {
    console.error('[state-bus] completeTask 실패:', (error as Error).message);
  }
}

export async function failTask(taskId: number | string, error: unknown): Promise<void> {
  try {
    const now = new Date().toISOString();
    await run(
      "UPDATE agent_tasks SET status = 'failed', result = $1, completed_at = $2 WHERE id = $3",
      [JSON.stringify({ error }), now, taskId],
    );
  } catch (caughtError) {
    console.error('[state-bus] failTask 실패:', (caughtError as Error).message);
  }
}
