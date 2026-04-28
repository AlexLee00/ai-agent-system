'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool');

const TASK_TABLE = 'agent.jay_team_tasks';
const MESSAGE_TABLE = 'agent.jay_team_messages';
let ensurePromise = null;

function normalizeText(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function normalizeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function ensureJayTeamBusTables() {
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    await pgPool.run('agent', `
      CREATE TABLE IF NOT EXISTS ${TASK_TABLE} (
        id TEXT PRIMARY KEY,
        incident_key TEXT NOT NULL,
        team TEXT NOT NULL,
        step_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        external_ref TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `, []);
    await pgPool.run('agent', `
      CREATE INDEX IF NOT EXISTS jay_team_tasks_incident_idx
      ON ${TASK_TABLE} (incident_key, created_at DESC)
    `, []);
    await pgPool.run('agent', `
      CREATE INDEX IF NOT EXISTS jay_team_tasks_status_idx
      ON ${TASK_TABLE} (status, updated_at DESC)
    `, []);
    await pgPool.run('agent', `
      CREATE TABLE IF NOT EXISTS ${MESSAGE_TABLE} (
        id TEXT PRIMARY KEY,
        incident_key TEXT NOT NULL,
        team TEXT NOT NULL,
        task_id TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        message TEXT NOT NULL DEFAULT '',
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `, []);
    await pgPool.run('agent', `
      CREATE INDEX IF NOT EXISTS jay_team_messages_incident_idx
      ON ${MESSAGE_TABLE} (incident_key, created_at DESC)
    `, []);
  })().catch((error) => {
    ensurePromise = null;
    throw error;
  });
  return ensurePromise;
}

function rowToTask(row) {
  if (!row) return null;
  return {
    id: normalizeText(row.id),
    incidentKey: normalizeText(row.incident_key),
    team: normalizeText(row.team),
    stepId: normalizeText(row.step_id),
    status: normalizeText(row.status, 'queued'),
    payload: normalizeObject(row.payload),
    externalRef: normalizeText(row.external_ref, '') || null,
    attempts: Number(row.attempts || 0),
    lastError: normalizeText(row.last_error, '') || null,
    createdAt: normalizeText(row.created_at),
    updatedAt: normalizeText(row.updated_at),
    completedAt: normalizeText(row.completed_at, '') || null,
  };
}

async function appendTeamMessage(input) {
  await ensureJayTeamBusTables();
  const id = makeId('jmsg');
  const incidentKey = normalizeText(input?.incidentKey);
  const team = normalizeText(input?.team, 'general');
  const taskId = normalizeText(input?.taskId, '') || null;
  const status = normalizeText(input?.status, 'queued');
  const message = normalizeText(input?.message, '');
  const payload = normalizeObject(input?.payload);

  if (!incidentKey) return { ok: false, error: 'incident_key_required' };
  await pgPool.run('agent', `
    INSERT INTO ${MESSAGE_TABLE} (
      id, incident_key, team, task_id, status, message, payload, created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
  `, [id, incidentKey, team, taskId, status, message, JSON.stringify(payload)]);
  return { ok: true, id };
}

async function createTeamTask(input) {
  await ensureJayTeamBusTables();
  const id = makeId('jtask');
  const incidentKey = normalizeText(input?.incidentKey);
  const team = normalizeText(input?.team, 'general').toLowerCase();
  const stepId = normalizeText(input?.stepId, 'step');
  const payload = normalizeObject(input?.payload);
  if (!incidentKey) return { ok: false, error: 'incident_key_required' };
  const row = await pgPool.get('agent', `
    INSERT INTO ${TASK_TABLE} (
      id, incident_key, team, step_id, status, payload, attempts, created_at, updated_at
    )
    VALUES (
      $1, $2, $3, $4, 'queued', $5::jsonb, 0, NOW(), NOW()
    )
    RETURNING *
  `, [id, incidentKey, team, stepId, JSON.stringify(payload)]);
  await appendTeamMessage({
    incidentKey,
    team,
    taskId: id,
    status: 'queued',
    message: `task queued: ${stepId}`,
    payload: { stepId },
  });
  return { ok: true, task: rowToTask(row) };
}

async function claimTeamTasks(limit = 10) {
  await ensureJayTeamBusTables();
  const count = Math.max(1, Number(limit || 10) || 10);
  const rows = await pgPool.query('agent', `
    WITH picked AS (
      SELECT id
      FROM ${TASK_TABLE}
      WHERE status IN ('queued', 'retrying')
      ORDER BY created_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${TASK_TABLE} dst
    SET
      status = 'running',
      attempts = dst.attempts + 1,
      updated_at = NOW()
    FROM picked
    WHERE dst.id = picked.id
    RETURNING dst.*
  `, [count]);
  return rows.map(rowToTask).filter(Boolean);
}

async function updateTeamTaskStatus(input) {
  await ensureJayTeamBusTables();
  const id = normalizeText(input?.id);
  const status = normalizeText(input?.status, 'queued');
  const externalRef = normalizeText(input?.externalRef, '') || null;
  const lastError = normalizeText(input?.lastError, '') || null;
  if (!id) return { ok: false, error: 'task_id_required' };
  const completed = ['completed', 'failed', 'dead_letter', 'rejected'].includes(status);
  const row = await pgPool.get('agent', `
    UPDATE ${TASK_TABLE}
    SET
      status = $2,
      external_ref = COALESCE($3, external_ref),
      last_error = COALESCE($4, last_error),
      updated_at = NOW(),
      completed_at = CASE WHEN $5 THEN NOW() ELSE completed_at END
    WHERE id = $1
    RETURNING *
  `, [id, status, externalRef, lastError, completed]);
  const task = rowToTask(row);
  if (task) {
    await appendTeamMessage({
      incidentKey: task.incidentKey,
      team: task.team,
      taskId: task.id,
      status: task.status,
      message: `task ${task.status}: ${task.stepId}`,
      payload: {
        externalRef: task.externalRef || undefined,
        lastError: task.lastError || undefined,
      },
    });
  }
  return { ok: Boolean(task), task };
}

module.exports = {
  ensureJayTeamBusTables,
  createTeamTask,
  claimTeamTasks,
  updateTeamTaskStatus,
  appendTeamMessage,
  _testOnly: {
    TASK_TABLE,
    MESSAGE_TABLE,
  },
};
