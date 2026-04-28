'use strict';

const crypto = require('node:crypto');
const pgPool = require('../../../packages/core/lib/pg-pool');

const INCIDENT_TABLE = 'agent.jay_incidents';
const EVENT_TABLE = 'agent.jay_incident_events';
let ensurePromise = null;

function normalizeText(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function normalizeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function normalizeSignatureText(value, fallback = '') {
  return normalizeText(value, fallback)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}:._/\- ]+/gu, '')
    .trim();
}

function makeId(prefix = 'incident') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function resolveDedupeWindow(input) {
  const args = normalizeObject(input?.args);
  const explicit = normalizeText(
    input?.dedupeWindow
      || input?.windowKey
      || args.dedupeWindow
      || args.windowKey
      || args.incidentWindow,
    '',
  );
  if (explicit) return explicit.toLowerCase();

  const mode = normalizeText(process.env.JAY_INCIDENT_DEDUPE_WINDOW, 'daily').toLowerCase();
  if (mode === 'none' || mode === 'global') return 'global';
  return new Date().toISOString().slice(0, 10);
}

function resolveIncidentGroup(input) {
  const args = normalizeObject(input?.args);
  return normalizeSignatureText(
    input?.incidentGroupKey
      || input?.groupKey
      || args.incidentGroupKey
      || args.groupKey
      || args.errorCode
      || args.code
      || args.incident
      || '',
    '',
  );
}

function buildIncidentKey(input) {
  const team = normalizeSignatureText(input?.team, 'general') || 'general';
  const intent = normalizeSignatureText(input?.intent, 'incident') || 'incident';
  const message = normalizeSignatureText(input?.message || input?.goal || '', '').slice(0, 280);
  const group = resolveIncidentGroup(input);
  const windowKey = resolveDedupeWindow(input);
  const seed = [
    team,
    intent,
    group || message || 'empty',
    windowKey,
  ].join('|');
  const hash = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12);
  return `${team}:${intent}:${hash}`;
}

async function ensureIncidentTables() {
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    await pgPool.run('agent', `
      CREATE TABLE IF NOT EXISTS ${INCIDENT_TABLE} (
        id TEXT PRIMARY KEY,
        incident_key TEXT UNIQUE NOT NULL,
        source TEXT NOT NULL DEFAULT 'jay',
        team TEXT NOT NULL DEFAULT 'general',
        intent TEXT NOT NULL DEFAULT 'incident',
        message TEXT NOT NULL DEFAULT '',
        args JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'queued',
        run_id TEXT,
        plan JSONB,
        priority TEXT NOT NULL DEFAULT 'normal',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `, []);
    await pgPool.run('agent', `
      CREATE INDEX IF NOT EXISTS jay_incidents_status_idx
      ON ${INCIDENT_TABLE} (status, updated_at DESC)
    `, []);
    await pgPool.run('agent', `
      CREATE INDEX IF NOT EXISTS jay_incidents_team_idx
      ON ${INCIDENT_TABLE} (team, created_at DESC)
    `, []);
    await pgPool.run('agent', `
      CREATE TABLE IF NOT EXISTS ${EVENT_TABLE} (
        id TEXT PRIMARY KEY,
        incident_key TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `, []);
    await pgPool.run('agent', `
      CREATE INDEX IF NOT EXISTS jay_incident_events_incident_idx
      ON ${EVENT_TABLE} (incident_key, created_at DESC)
    `, []);
  })().catch((error) => {
    ensurePromise = null;
    throw error;
  });
  return ensurePromise;
}

function rowToIncident(row) {
  if (!row) return null;
  return {
    id: normalizeText(row.id),
    incidentKey: normalizeText(row.incident_key),
    source: normalizeText(row.source, 'jay'),
    team: normalizeText(row.team, 'general'),
    intent: normalizeText(row.intent, 'incident'),
    message: normalizeText(row.message, ''),
    args: normalizeObject(row.args),
    status: normalizeText(row.status, 'queued'),
    runId: normalizeText(row.run_id, '') || null,
    plan: normalizeObject(row.plan),
    priority: normalizeText(row.priority, 'normal'),
    attempts: Number(row.attempts || 0),
    lastError: normalizeText(row.last_error, '') || null,
    createdAt: normalizeText(row.created_at),
    updatedAt: normalizeText(row.updated_at),
    completedAt: normalizeText(row.completed_at, '') || null,
  };
}

async function appendIncidentEvent(input) {
  const incidentKey = normalizeText(input?.incidentKey);
  const eventType = normalizeText(input?.eventType, 'event');
  const payload = normalizeObject(input?.payload);
  if (!incidentKey) return { ok: false, error: 'incident_key_required' };
  await ensureIncidentTables();
  const id = makeId('iev');
  await pgPool.run('agent', `
    INSERT INTO ${EVENT_TABLE} (id, incident_key, event_type, payload, created_at)
    VALUES ($1, $2, $3, $4::jsonb, NOW())
  `, [id, incidentKey, eventType, JSON.stringify(payload)]);
  return { ok: true, id };
}

async function hasIncidentEvent(input) {
  const incidentKey = normalizeText(input?.incidentKey);
  const eventType = normalizeText(input?.eventType, 'event');
  if (!incidentKey) return false;
  await ensureIncidentTables();
  const row = await pgPool.get('agent', `
    SELECT 1 AS found
    FROM ${EVENT_TABLE}
    WHERE incident_key = $1
      AND event_type = $2
    LIMIT 1
  `, [incidentKey, eventType]);
  return Boolean(row?.found);
}

async function createIncident(input) {
  await ensureIncidentTables();
  const id = makeId('inc');
  const incidentKey = normalizeText(input?.incidentKey) || buildIncidentKey(input);
  const source = normalizeText(input?.source, 'jay');
  const team = normalizeText(input?.team, 'general').toLowerCase();
  const intent = normalizeText(input?.intent, 'incident');
  const message = normalizeText(input?.message || input?.goal || '', '');
  const args = normalizeObject(input?.args);
  const priority = normalizeText(input?.priority, 'normal');
  const row = await pgPool.get('agent', `
    INSERT INTO ${INCIDENT_TABLE} (
      id, incident_key, source, team, intent, message, args, status, priority, attempts, created_at, updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7::jsonb, 'queued', $8, 0, NOW(), NOW()
    )
    ON CONFLICT (incident_key)
    DO UPDATE SET
      source = EXCLUDED.source,
      team = EXCLUDED.team,
      intent = EXCLUDED.intent,
      message = EXCLUDED.message,
      args = EXCLUDED.args,
      priority = EXCLUDED.priority,
      updated_at = NOW()
    RETURNING *
  `, [
    id,
    incidentKey,
    source,
    team,
    intent,
    message,
    JSON.stringify(args),
    priority,
  ]);
  const incident = rowToIncident(row);
  await appendIncidentEvent({
    incidentKey,
    eventType: 'incident_created',
    payload: { team, intent, priority, source },
  });
  return { ok: true, incident };
}

async function getIncidentByKey(incidentKey) {
  await ensureIncidentTables();
  const key = normalizeText(incidentKey);
  if (!key) return null;
  const row = await pgPool.get('agent', `
    SELECT * FROM ${INCIDENT_TABLE}
    WHERE incident_key = $1
  `, [key]);
  return rowToIncident(row);
}

async function listIncidentsByStatus(statuses = ['queued'], limit = 20) {
  await ensureIncidentTables();
  const normalized = (Array.isArray(statuses) ? statuses : [statuses])
    .map((status) => normalizeText(status).toLowerCase())
    .filter(Boolean);
  const rows = await pgPool.query('agent', `
    SELECT * FROM ${INCIDENT_TABLE}
    WHERE status = ANY($1::text[])
    ORDER BY created_at ASC
    LIMIT $2
  `, [normalized, Math.max(1, Number(limit || 20) || 20)]);
  return rows.map(rowToIncident).filter(Boolean);
}

async function updateIncidentStatus(input) {
  await ensureIncidentTables();
  const incidentKey = normalizeText(input?.incidentKey);
  const status = normalizeText(input?.status, 'queued').toLowerCase();
  if (!incidentKey) return { ok: false, error: 'incident_key_required' };

  const runId = normalizeText(input?.runId, '') || null;
  const plan = normalizeObject(input?.plan);
  const lastError = normalizeText(input?.lastError, '') || null;
  const attemptsDelta = Number(input?.attemptsDelta || 0) || 0;
  const completed = ['completed', 'failed', 'rejected', 'dead_letter'].includes(status);
  const row = await pgPool.get('agent', `
    UPDATE ${INCIDENT_TABLE}
    SET
      status = $2,
      run_id = COALESCE($3, run_id),
      plan = CASE WHEN $4::jsonb = '{}'::jsonb THEN plan ELSE $4::jsonb END,
      last_error = COALESCE($5, last_error),
      attempts = GREATEST(0, attempts + $6),
      updated_at = NOW(),
      completed_at = CASE WHEN $7 THEN NOW() ELSE completed_at END
    WHERE incident_key = $1
    RETURNING *
  `, [
    incidentKey,
    status,
    runId,
    JSON.stringify(plan),
    lastError,
    attemptsDelta,
    completed,
  ]);
  const incident = rowToIncident(row);
  await appendIncidentEvent({
    incidentKey,
    eventType: `status_${status}`,
    payload: {
      runId: runId || undefined,
      lastError: lastError || undefined,
      attemptsDelta,
    },
  });
  return { ok: Boolean(incident), incident };
}

async function claimQueuedIncident() {
  await ensureIncidentTables();
  const row = await pgPool.get('agent', `
    WITH picked AS (
      SELECT incident_key
      FROM ${INCIDENT_TABLE}
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${INCIDENT_TABLE} dst
    SET
      status = 'planning',
      attempts = dst.attempts + 1,
      updated_at = NOW()
    FROM picked
    WHERE dst.incident_key = picked.incident_key
    RETURNING dst.*
  `, []);
  if (!row) return null;
  const incident = rowToIncident(row);
  await appendIncidentEvent({
    incidentKey: incident.incidentKey,
    eventType: 'incident_claimed',
    payload: { status: 'planning', attempts: incident.attempts },
  });
  return incident;
}

module.exports = {
  ensureIncidentTables,
  createIncident,
  getIncidentByKey,
  listIncidentsByStatus,
  updateIncidentStatus,
  appendIncidentEvent,
  hasIncidentEvent,
  claimQueuedIncident,
  _testOnly: {
    buildIncidentKey,
    resolveDedupeWindow,
    resolveIncidentGroup,
    INCIDENT_TABLE,
    EVENT_TABLE,
  },
};
