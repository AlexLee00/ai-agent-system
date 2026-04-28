'use strict';

const pgPool = require('../../../../packages/core/lib/pg-pool');
const checkpoint = require('./session-checkpoint.ts');
const { callWithFallback } = require('../llm/unified-caller');

const COMPACTION_TABLE = 'agent.jay_session_compactions';
const CONTROL_RUN_TABLE = 'agent.hub_control_runs';
const BUS_MESSAGE_TABLE = 'agent.hub_agent_bus_messages';
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

function makeId(prefix = 'jcompact') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function ensureSessionCompactionTable() {
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    await pgPool.run('agent', `
      CREATE TABLE IF NOT EXISTS ${COMPACTION_TABLE} (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL,
        checkpoint_kind TEXT NOT NULL DEFAULT 'checkpoint',
        trigger_reason TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        token_estimate INTEGER NOT NULL DEFAULT 0,
        summary TEXT NOT NULL DEFAULT '',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `, []);
    await pgPool.run('agent', `
      CREATE INDEX IF NOT EXISTS jay_session_compactions_session_idx
      ON ${COMPACTION_TABLE} (session_id, created_at DESC)
    `, []);
  })().catch((error) => {
    ensurePromise = null;
    throw error;
  });
  return ensurePromise;
}

async function estimateSessionRuntime(sessionId) {
  const normalizedSessionId = normalizeText(sessionId, '');
  if (!normalizedSessionId) {
    return { messageCount: 0, tokenEstimate: 0 };
  }
  try {
    const busRow = await pgPool.get('agent', `
      SELECT COUNT(*)::int AS count
      FROM ${BUS_MESSAGE_TABLE}
      WHERE incident_key = $1 OR run_id = $1 OR trace_id = $1
    `, [normalizedSessionId]);
    const runRows = await pgPool.query('agent', `
      SELECT plan, result
      FROM ${CONTROL_RUN_TABLE}
      WHERE run_id = $1 OR trace_id = $1
      ORDER BY updated_at DESC
      LIMIT 50
    `, [normalizedSessionId]);
    const tokenEstimate = runRows.reduce((sum, row) => {
      const payload = `${JSON.stringify(row?.plan || {})} ${JSON.stringify(row?.result || {})}`;
      return sum + Math.ceil(payload.length / 4);
    }, 0);
    return {
      messageCount: Number(busRow?.count || 0),
      tokenEstimate,
    };
  } catch {
    return { messageCount: 0, tokenEstimate: 0 };
  }
}

function resolveThresholds(input = {}) {
  const messageThreshold = Math.max(
    50,
    Number(input.messageThreshold || process.env.HUB_SESSION_COMPACTION_MESSAGE_THRESHOLD || 200) || 200,
  );
  const tokenThreshold = Math.max(
    10_000,
    Number(input.tokenThreshold || process.env.HUB_SESSION_COMPACTION_TOKEN_THRESHOLD || 50_000) || 50_000,
  );
  return { messageThreshold, tokenThreshold };
}

async function buildCompactionSummary(input = {}, observed = {}) {
  const provided = normalizeText(input?.summary, '');
  if (provided) return { ok: true, summary: provided, source: 'provided' };

  const sessionId = normalizeText(input?.sessionId || input?.runId || input?.incidentKey, 'unknown-session');
  const triggerReason = normalizeText(input?.triggerReason, 'threshold');
  const fallbackSummary = `session ${sessionId} compacted (${triggerReason}, messages=${Number(observed.messageCount || 0)}, tokens≈${Number(observed.tokenEstimate || 0)})`;
  const useLlm = parseBoolean(process.env.HUB_SESSION_COMPACTION_LLM_SUMMARY, false) || input?.useLlmSummary === true;
  if (!useLlm) return { ok: true, summary: fallbackSummary, source: 'heuristic' };

  const recentMessages = Array.isArray(input?.recentMessages)
    ? input.recentMessages.slice(-12).map((message) => String(message || '').slice(0, 1000))
    : [];
  const prompt = [
    'Summarize this Jay orchestration session for safe handoff.',
    `sessionId: ${sessionId}`,
    `triggerReason: ${triggerReason}`,
    `messageCount: ${Number(observed.messageCount || 0)}`,
    `tokenEstimate: ${Number(observed.tokenEstimate || 0)}`,
    'Return concise Korean bullet notes with decisions, open risks, and next actions.',
    recentMessages.length ? `Recent messages:\n${recentMessages.join('\n---\n')}` : 'Recent messages: unavailable',
  ].join('\n');
  const response = await callWithFallback({
    prompt,
    selectorKey: 'hub.session.compaction',
    callerTeam: 'hub',
    agent: 'session-compaction',
    maxTokens: 700,
    temperature: 0.1,
    maxBudgetUsd: 0.05,
  }).catch((error) => ({ ok: false, error: String(error?.message || error || 'llm_summary_failed') }));

  if (response?.ok && normalizeText(response.result || response.text, '')) {
    return {
      ok: true,
      summary: normalizeText(response.result || response.text),
      source: 'llm',
      provider: response.provider || null,
      model: response.model || null,
    };
  }
  if (parseBoolean(process.env.HUB_SESSION_COMPACTION_REQUIRE_LLM, false)) {
    return { ok: false, error: response?.error || 'llm_summary_failed' };
  }
  return {
    ok: true,
    summary: fallbackSummary,
    source: 'heuristic_after_llm_failure',
    error: response?.error || 'llm_summary_failed',
  };
}

async function maybeCompactSession(input = {}) {
  const enabled = parseBoolean(process.env.HUB_SESSION_COMPACTION, false) || input?.force === true;
  if (!enabled) return { ok: true, skipped: true, reason: 'session_compaction_disabled' };

  const sessionId = normalizeText(input?.sessionId || input?.runId || input?.incidentKey, '');
  if (!sessionId) return { ok: false, error: 'session_id_required' };
  await ensureSessionCompactionTable();

  const { messageThreshold, tokenThreshold } = resolveThresholds(input);
  const observed = await estimateSessionRuntime(sessionId);
  const messageCount = Number(input?.messageCount ?? observed.messageCount);
  const tokenEstimate = Number(input?.tokenEstimate ?? observed.tokenEstimate);
  const triggerReason = input?.triggerReason
    || (messageCount >= messageThreshold ? 'message_threshold' : tokenEstimate >= tokenThreshold ? 'token_threshold' : '');

  if (!triggerReason) {
    return {
      ok: true,
      skipped: true,
      reason: 'below_threshold',
      messageCount,
      tokenEstimate,
      messageThreshold,
      tokenThreshold,
    };
  }

  const summaryResult = await buildCompactionSummary(input, {
    messageCount,
    tokenEstimate,
  });
  if (!summaryResult?.ok) {
    return { ok: false, error: summaryResult?.error || 'compaction_summary_failed' };
  }
  const summary = summaryResult.summary;
  const state = normalizeObject(input?.state);
  const artifacts = Array.isArray(input?.artifacts) ? input.artifacts.map((v) => String(v || '').trim()).filter(Boolean) : [];
  const recentMessages = Array.isArray(input?.recentMessages)
    ? input.recentMessages.slice(-5).map((message) => String(message || '').slice(0, 2000))
    : [];
  const checkpointRecord = checkpoint.createSessionCheckpoint({
    sessionId,
    label: normalizeText(input?.label, 'auto-compaction'),
    summary,
    state: {
      ...state,
      triggerReason,
      messageCount,
      tokenEstimate,
      thresholds: { messageThreshold, tokenThreshold },
      summarySource: summaryResult.source,
      recentMessages,
    },
    artifacts,
    parentId: normalizeText(input?.parentCheckpointId, '') || null,
  });

  const id = makeId();
  await pgPool.run('agent', `
    INSERT INTO ${COMPACTION_TABLE} (
      id, session_id, checkpoint_id, checkpoint_kind, trigger_reason,
      message_count, token_estimate, summary, metadata, created_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW()
    )
  `, [
    id,
    sessionId,
    checkpointRecord.id,
    checkpointRecord.kind,
    triggerReason,
    messageCount,
    tokenEstimate,
    summary,
    JSON.stringify({
      checkpointCreatedAt: checkpointRecord.createdAt,
      stateKeys: Object.keys(checkpointRecord.state || {}),
      summarySource: summaryResult.source,
      summaryProvider: summaryResult.provider || undefined,
      summaryModel: summaryResult.model || undefined,
    }),
  ]);

  return {
    ok: true,
    compacted: true,
    sessionId,
    checkpointId: checkpointRecord.id,
    triggerReason,
    messageCount,
    tokenEstimate,
    summarySource: summaryResult.source,
  };
}

async function listRecentCompactions(input = {}) {
  await ensureSessionCompactionTable();
  const sessionId = normalizeText(input?.sessionId, '');
  const limit = Math.max(1, Number(input?.limit || 20) || 20);
  const rows = await pgPool.query('agent', `
    SELECT
      id, session_id, checkpoint_id, checkpoint_kind, trigger_reason,
      message_count, token_estimate, summary, metadata,
      to_char(created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS created_at
    FROM ${COMPACTION_TABLE}
    WHERE ($1 = '' OR session_id = $1)
    ORDER BY created_at DESC
    LIMIT $2
  `, [sessionId, limit]);
  return rows;
}

module.exports = {
  ensureSessionCompactionTable,
  maybeCompactSession,
  listRecentCompactions,
  _testOnly: {
    estimateSessionRuntime,
    resolveThresholds,
    buildCompactionSummary,
    COMPACTION_TABLE,
  },
};
