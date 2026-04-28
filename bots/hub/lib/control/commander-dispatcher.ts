'use strict';

const pgPool = require('../../../../packages/core/lib/pg-pool');
const {
  validateCommanderTask,
  validateCommanderAdapter,
  normalizeStatus,
} = require('../../../../packages/core/lib/commander-contract.ts');
const { sendAgentMessage, ackAgentMessage } = require('./agent-bus');
const { getCommanderAdapter } = require('../../../orchestrator/lib/commanders/index.ts');
const teamBus = require('../../../orchestrator/lib/jay-team-bus.ts');

const {
  ensureJayTeamBusTables,
  createTeamTask,
  claimTeamTasks,
  updateTeamTaskStatus,
  appendTeamMessage,
} = teamBus;
const TASK_TABLE = teamBus._testOnly.TASK_TABLE;
const MESSAGE_TABLE = teamBus._testOnly.MESSAGE_TABLE;
const INCIDENT_EVENT_TABLE = 'agent.jay_incident_events';
let ensurePromise = null;

function normalizeText(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function normalizeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function parseBoolean(value, fallback = false) {
  const text = normalizeText(value, fallback ? 'true' : 'false').toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(text);
}

function makeId(prefix = 'jtask') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function isRetryableDispatcherError(errorCode) {
  const code = normalizeText(errorCode, '').toLowerCase();
  return [
    'bot_command_timeout',
    'dispatcher_timeout',
    'tool_execution_failed',
    'control_state_store_unavailable',
    'commander_dispatch_failed',
  ].includes(code);
}

function withTimeout(promise, timeoutMs, timeoutError = 'dispatcher_timeout') {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      setTimeout(() => resolve({ ok: false, error: timeoutError }), timeoutMs);
    }),
  ]);
}

function rowToTask(row) {
  if (!row) return null;
  return {
    id: normalizeText(row.id),
    incidentKey: normalizeText(row.incidentKey ?? row.incident_key),
    team: normalizeText(row.team, 'general'),
    stepId: normalizeText(row.stepId ?? row.step_id, 'step'),
    status: normalizeText(row.status, 'queued'),
    payload: normalizeObject(row.payload),
    externalRef: normalizeText(row.externalRef ?? row.external_ref, '') || null,
    attempts: Number(row.attempts || 0),
    lastError: normalizeText(row.lastError ?? row.last_error, '') || null,
    createdAt: normalizeText(row.createdAt ?? row.created_at),
    updatedAt: normalizeText(row.updatedAt ?? row.updated_at),
    completedAt: normalizeText(row.completedAt ?? row.completed_at, '') || null,
  };
}

async function ensureCommanderDispatchTables() {
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    await ensureJayTeamBusTables();
    await pgPool.run('agent', `
      CREATE TABLE IF NOT EXISTS ${INCIDENT_EVENT_TABLE} (
        id TEXT PRIMARY KEY,
        incident_key TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `, []);
  })().catch((error) => {
    ensurePromise = null;
    throw error;
  });
  return ensurePromise;
}

async function appendIncidentEvent(incidentKey, eventType, payload = {}) {
  if (!incidentKey) return;
  await ensureCommanderDispatchTables();
  await pgPool.run('agent', `
    INSERT INTO ${INCIDENT_EVENT_TABLE} (id, incident_key, event_type, payload, created_at)
    VALUES ($1, $2, $3, $4::jsonb, NOW())
  `, [
    makeId('iev'),
    incidentKey,
    normalizeText(eventType, 'commander_event'),
    JSON.stringify(normalizeObject(payload)),
  ]);
}

async function queueCommanderTask(input) {
  await ensureCommanderDispatchTables();
  const incidentKey = normalizeText(input?.incidentKey);
  const team = normalizeText(input?.team, 'general').toLowerCase();
  const stepId = normalizeText(input?.stepId, 'step');
  const payload = normalizeObject(input?.payload);
  if (!incidentKey) return { ok: false, error: 'incident_key_required' };
  const created = await createTeamTask({
    incidentKey,
    team,
    stepId,
    payload,
  });
  if (!created?.ok) return created;
  await appendIncidentEvent(incidentKey, 'commander_task_queued', {
    team,
    stepId,
    taskId: created.task?.id,
  });
  return { ok: true, task: rowToTask(created.task) };
}

async function claimCommanderTasks(limit = 4) {
  await ensureCommanderDispatchTables();
  return claimTeamTasks(limit);
}

async function updateCommanderTaskStatus(input) {
  await ensureCommanderDispatchTables();
  const taskId = normalizeText(input?.id);
  const status = normalizeStatus(input?.status, 'failed');
  const externalRef = normalizeText(input?.externalRef, '') || null;
  const lastError = normalizeText(input?.lastError, '') || null;
  if (!taskId) return { ok: false, error: 'task_id_required' };
  const updated = await updateTeamTaskStatus({
    id: taskId,
    status,
    externalRef,
    lastError,
  });
  const task = rowToTask(updated?.task);
  if (!updated?.ok || !task) return { ok: false, error: updated?.error || 'task_not_found' };
  await appendIncidentEvent(task.incidentKey, `commander_task_${status}`, {
    team: task.team,
    stepId: task.stepId,
    taskId: task.id,
    externalRef: task.externalRef || undefined,
    lastError: task.lastError || undefined,
  });
  return { ok: true, task };
}

async function dispatchCommanderTask(task, options = {}) {
  const normalizedTask = rowToTask(task);
  if (!normalizedTask) return { ok: false, error: 'task_required' };
  const maxRetry = Math.max(1, Number(options.maxRetry || process.env.JAY_COMMANDER_MAX_RETRY || 3) || 3);
  const timeoutMs = Math.max(15_000, Number(options.timeoutMs || process.env.JAY_COMMANDER_TIMEOUT_MS || 300_000) || 300_000);
  const adapter = getCommanderAdapter(normalizedTask.team);
  const adapterCheck = validateCommanderAdapter(adapter, normalizedTask.team);
  if (!adapterCheck.ok) {
    await updateCommanderTaskStatus({
      id: normalizedTask.id,
      status: 'dead_letter',
      lastError: adapterCheck.error,
    });
    return { ok: false, error: adapterCheck.error, task: normalizedTask };
  }
  if (adapter.mode === 'virtual' && !parseBoolean(process.env.JAY_COMMANDER_ALLOW_VIRTUAL, false)) {
    const error = `commander_adapter_virtual_disabled:${normalizedTask.team}`;
    await updateCommanderTaskStatus({
      id: normalizedTask.id,
      status: 'dead_letter',
      lastError: error,
    });
    return { ok: false, error, task: normalizedTask };
  }

  const payload = normalizeObject(normalizedTask.payload);
  const taskInput = {
    incidentKey: normalizedTask.incidentKey,
    team: normalizedTask.team,
    stepId: normalizedTask.stepId,
    goal: normalizeText(payload.goal || payload.objective || '', 'incident_task'),
    planStep: normalizeObject(payload.planStep),
    payload,
    deadlineAt: normalizeText(payload.deadlineAt, '') || null,
  };
  const taskValidation = validateCommanderTask(taskInput);
  if (!taskValidation.ok) {
    await updateCommanderTaskStatus({
      id: normalizedTask.id,
      status: 'dead_letter',
      lastError: taskValidation.error,
    });
    return { ok: false, error: taskValidation.error, task: normalizedTask };
  }

  let busMessageId = null;
  try {
    const busSend = await sendAgentMessage({
      incidentKey: normalizedTask.incidentKey,
      from: 'jay',
      to: normalizedTask.team,
      role: 'dispatcher',
      phase: 'plan',
      visibility: 'internal',
      payload: {
        taskId: normalizedTask.id,
        stepId: normalizedTask.stepId,
      },
      ackRequired: true,
    });
    busMessageId = busSend?.message?.id || null;
  } catch {
    // no-op
  }

  const accepted = await withTimeout(adapter.acceptIncidentTask(taskValidation.data), timeoutMs);
  if (!accepted?.ok) {
    const failureCode = normalizeText(accepted?.error || 'commander_dispatch_failed');
    const shouldRetry = normalizedTask.attempts < maxRetry && isRetryableDispatcherError(failureCode);
    await updateCommanderTaskStatus({
      id: normalizedTask.id,
      status: shouldRetry ? 'retrying' : 'dead_letter',
      lastError: failureCode,
    });
    if (busMessageId) {
      await ackAgentMessage({
        messageId: busMessageId,
        ackedBy: 'jay-dispatcher',
      }).catch(() => {});
    }
    return { ok: false, error: failureCode, retrying: shouldRetry, task: normalizedTask };
  }

  const final = await withTimeout(adapter.finalSummary({
    ...taskValidation.data,
    commandId: accepted?.commandId || accepted?.result?.commandId || null,
  }), timeoutMs);

  if (final?.ok) {
    await updateCommanderTaskStatus({
      id: normalizedTask.id,
      status: normalizeStatus(final.status, 'completed'),
      externalRef: normalizeText(String(final?.commandId || ''), '') || null,
    });
    if (busMessageId) {
      await ackAgentMessage({
        messageId: busMessageId,
        ackedBy: 'jay-dispatcher',
      }).catch(() => {});
    }
    return { ok: true, task: normalizedTask, accepted, final };
  }

  const finalError = normalizeText(final?.error || 'commander_dispatch_failed');
  const retrying = normalizedTask.attempts < maxRetry && isRetryableDispatcherError(finalError);
  await updateCommanderTaskStatus({
    id: normalizedTask.id,
    status: retrying ? 'retrying' : 'dead_letter',
    lastError: finalError,
  });
  if (busMessageId) {
    await ackAgentMessage({
      messageId: busMessageId,
      ackedBy: 'jay-dispatcher',
    }).catch(() => {});
  }
  return { ok: false, error: finalError, retrying, task: normalizedTask };
}

async function dispatchCommanderQueue(input = {}) {
  const limit = Math.max(1, Number(input?.limit || 3) || 3);
  const tasks = await claimCommanderTasks(limit);
  const results = [];
  for (const task of tasks) {
    // sequential by default for safety
    // eslint-disable-next-line no-await-in-loop
    const result = await dispatchCommanderTask(task, input);
    results.push(result);
  }
  return {
    ok: true,
    claimed: tasks.length,
    results,
  };
}

async function getCommanderDispatchStats() {
  await ensureCommanderDispatchTables();
  const row = await pgPool.get('agent', `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
      COUNT(*) FILTER (WHERE status = 'running')::int AS running,
      COUNT(*) FILTER (WHERE status = 'retrying')::int AS retrying,
      COUNT(*) FILTER (WHERE status = 'dead_letter')::int AS dead_letter,
      COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
    FROM ${TASK_TABLE}
  `, []);
  return {
    ok: true,
    stats: {
      total: Number(row?.total || 0),
      queued: Number(row?.queued || 0),
      running: Number(row?.running || 0),
      retrying: Number(row?.retrying || 0),
      deadLetter: Number(row?.dead_letter || 0),
      completed: Number(row?.completed || 0),
    },
  };
}

module.exports = {
  ensureCommanderDispatchTables,
  queueCommanderTask,
  claimCommanderTasks,
  updateCommanderTaskStatus,
  dispatchCommanderTask,
  dispatchCommanderQueue,
  getCommanderDispatchStats,
  _testOnly: {
    TASK_TABLE,
    MESSAGE_TABLE,
    INCIDENT_EVENT_TABLE,
    isRetryableDispatcherError,
  },
};
