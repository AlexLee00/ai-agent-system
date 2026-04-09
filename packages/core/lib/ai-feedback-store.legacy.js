'use strict';

const {
  sanitizeFeedbackValue,
} = require('./ai-feedback-core');

async function ensureAiFeedbackTables(pgPool, { schema }) {
  await pgPool.run(schema, `
    CREATE TABLE IF NOT EXISTS ${schema}.ai_feedback_sessions (
      id                     BIGSERIAL PRIMARY KEY,
      company_id             TEXT,
      user_id                INTEGER,
      source_type            TEXT NOT NULL,
      source_ref_type        TEXT NOT NULL,
      source_ref_id          TEXT NOT NULL,
      flow_code              TEXT NOT NULL,
      action_code            TEXT NOT NULL,
      proposal_id            TEXT,
      ai_input_text          TEXT,
      ai_input_payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
      ai_output_type         TEXT NOT NULL,
      original_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      feedback_status        TEXT NOT NULL DEFAULT 'pending',
      accepted_without_edit  BOOLEAN NOT NULL DEFAULT FALSE,
      submitted_snapshot_json JSONB,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_${schema}_ai_feedback_sessions_company_status
      ON ${schema}.ai_feedback_sessions(company_id, feedback_status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_${schema}_ai_feedback_sessions_source
      ON ${schema}.ai_feedback_sessions(source_ref_type, source_ref_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS ${schema}.ai_feedback_events (
      id                   BIGSERIAL PRIMARY KEY,
      feedback_session_id  BIGINT NOT NULL REFERENCES ${schema}.ai_feedback_sessions(id) ON DELETE CASCADE,
      event_type           TEXT NOT NULL,
      field_key            TEXT,
      before_value_json    JSONB,
      after_value_json     JSONB,
      event_meta_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_${schema}_ai_feedback_events_session
      ON ${schema}.ai_feedback_events(feedback_session_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_${schema}_ai_feedback_events_type
      ON ${schema}.ai_feedback_events(event_type, created_at DESC);
  `);
}

async function createFeedbackSession(pgPool, { schema, session }) {
  const row = await pgPool.get(schema, `
    INSERT INTO ${schema}.ai_feedback_sessions (
      company_id,
      user_id,
      source_type,
      source_ref_type,
      source_ref_id,
      flow_code,
      action_code,
      proposal_id,
      ai_input_text,
      ai_input_payload,
      ai_output_type,
      original_snapshot_json,
      feedback_status,
      accepted_without_edit,
      submitted_snapshot_json
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13,$14,$15::jsonb
    )
    RETURNING *
  `, [
    session.companyId || null,
    session.userId || null,
    session.sourceType,
    session.sourceRefType,
    String(session.sourceRefId),
    session.flowCode,
    session.actionCode,
    session.proposalId || null,
    session.aiInputText || null,
    JSON.stringify(sanitizeFeedbackValue(session.aiInputPayload || {})),
    session.aiOutputType,
    JSON.stringify(sanitizeFeedbackValue(session.originalSnapshot || {})),
    session.feedbackStatus || 'pending',
    !!session.acceptedWithoutEdit,
    JSON.stringify(sanitizeFeedbackValue(session.submittedSnapshot || null)),
  ]);
  return row;
}

async function updateFeedbackSession(pgPool, { schema, sessionId, patch }) {
  const row = await pgPool.get(schema, `
    UPDATE ${schema}.ai_feedback_sessions
    SET feedback_status = COALESCE($2, feedback_status),
        accepted_without_edit = COALESCE($3, accepted_without_edit),
        submitted_snapshot_json = COALESCE($4::jsonb, submitted_snapshot_json),
        updated_at = NOW()
    WHERE id=$1
    RETURNING *
  `, [
    sessionId,
    patch.feedbackStatus || null,
    typeof patch.acceptedWithoutEdit === 'boolean' ? patch.acceptedWithoutEdit : null,
    patch.submittedSnapshot === undefined ? null : JSON.stringify(sanitizeFeedbackValue(patch.submittedSnapshot)),
  ]);
  return row;
}

async function addFeedbackEvent(pgPool, { schema, event }) {
  const row = await pgPool.get(schema, `
    INSERT INTO ${schema}.ai_feedback_events (
      feedback_session_id,
      event_type,
      field_key,
      before_value_json,
      after_value_json,
      event_meta_json
    ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)
    RETURNING *
  `, [
    event.feedbackSessionId,
    event.eventType,
    event.fieldKey || null,
    JSON.stringify(sanitizeFeedbackValue(event.beforeValue === undefined ? null : event.beforeValue)),
    JSON.stringify(sanitizeFeedbackValue(event.afterValue === undefined ? null : event.afterValue)),
    JSON.stringify(sanitizeFeedbackValue(event.eventMeta || {})),
  ]);
  return row;
}

async function listFeedbackEvents(pgPool, { schema, feedbackSessionId }) {
  return pgPool.query(schema, `
    SELECT *
    FROM ${schema}.ai_feedback_events
    WHERE feedback_session_id=$1
    ORDER BY created_at ASC, id ASC
  `, [feedbackSessionId]);
}

async function clearFeedbackEditEvents(pgPool, { schema, feedbackSessionId }) {
  return pgPool.run(schema, `
    DELETE FROM ${schema}.ai_feedback_events
    WHERE feedback_session_id=$1
      AND event_type IN ('field_edited', 'field_added', 'field_removed')
  `, [feedbackSessionId]);
}

async function getFeedbackSessionById(pgPool, { schema, id }) {
  return pgPool.get(schema, `
    SELECT *
    FROM ${schema}.ai_feedback_sessions
    WHERE id=$1
  `, [id]);
}

async function getFeedbackSessionBySource(pgPool, {
  schema,
  sourceRefType,
  sourceRefId,
}) {
  return pgPool.get(schema, `
    SELECT *
    FROM ${schema}.ai_feedback_sessions
    WHERE source_ref_type=$1
      AND source_ref_id=$2
    ORDER BY created_at DESC
    LIMIT 1
  `, [sourceRefType, String(sourceRefId)]);
}

async function getFeedbackSessionSummary(pgPool, {
  schema,
  sinceDays = 30,
}) {
  const sessions = await pgPool.get(schema, `
    SELECT
      COUNT(*)::int AS total_sessions,
      COUNT(*) FILTER (WHERE feedback_status='committed')::int AS committed_sessions,
      COUNT(*) FILTER (WHERE feedback_status='confirmed')::int AS confirmed_sessions,
      COUNT(*) FILTER (WHERE feedback_status='rejected')::int AS rejected_sessions,
      COUNT(*) FILTER (WHERE accepted_without_edit=true)::int AS accepted_without_edit_sessions
    FROM ${schema}.ai_feedback_sessions
    WHERE created_at >= NOW() - ($1::text || ' days')::interval
  `, [String(sinceDays)]);

  const byFlow = await pgPool.query(schema, `
    SELECT
      flow_code,
      action_code,
      COUNT(*)::int AS session_count,
      COUNT(*) FILTER (WHERE feedback_status='committed')::int AS committed_count,
      COUNT(*) FILTER (WHERE feedback_status='rejected')::int AS rejected_count,
      COUNT(*) FILTER (WHERE accepted_without_edit=true)::int AS accepted_without_edit_count
    FROM ${schema}.ai_feedback_sessions
    WHERE created_at >= NOW() - ($1::text || ' days')::interval
    GROUP BY flow_code, action_code
    ORDER BY session_count DESC, flow_code ASC, action_code ASC
  `, [String(sinceDays)]);

  return {
    totalSessions: Number(sessions?.total_sessions ?? 0),
    committedSessions: Number(sessions?.committed_sessions ?? 0),
    confirmedSessions: Number(sessions?.confirmed_sessions ?? 0),
    rejectedSessions: Number(sessions?.rejected_sessions ?? 0),
    acceptedWithoutEditSessions: Number(sessions?.accepted_without_edit_sessions ?? 0),
    byFlow,
  };
}

async function getFeedbackFieldStats(pgPool, {
  schema,
  sinceDays = 30,
  limit = 20,
}) {
  return pgPool.query(schema, `
    SELECT
      field_key,
      event_type,
      COUNT(*)::int AS edit_count
    FROM ${schema}.ai_feedback_events
    WHERE created_at >= NOW() - ($1::text || ' days')::interval
      AND event_type IN ('field_edited', 'field_added', 'field_removed')
      AND field_key IS NOT NULL
    GROUP BY field_key, event_type
    ORDER BY edit_count DESC, field_key ASC
    LIMIT $2
  `, [String(sinceDays), Number(limit)]);
}

async function getFeedbackSessions(pgPool, {
  schema,
  sinceDays = 30,
  limit = 50,
}) {
  return pgPool.query(schema, `
    SELECT
      id,
      company_id,
      user_id,
      source_type,
      source_ref_type,
      source_ref_id,
      flow_code,
      action_code,
      feedback_status,
      accepted_without_edit,
      created_at,
      updated_at
    FROM ${schema}.ai_feedback_sessions
    WHERE created_at >= NOW() - ($1::text || ' days')::interval
    ORDER BY created_at DESC, id DESC
    LIMIT $2
  `, [String(sinceDays), Number(limit)]);
}

async function getFeedbackDailyStats(pgPool, {
  schema,
  sinceDays = 30,
}) {
  return pgPool.query(schema, `
    SELECT
      TO_CHAR(DATE_TRUNC('day', created_at), 'YYYY-MM-DD') AS day,
      COUNT(*)::int AS session_count,
      COUNT(*) FILTER (WHERE feedback_status='committed')::int AS committed_count,
      COUNT(*) FILTER (WHERE feedback_status='rejected')::int AS rejected_count,
      COUNT(*) FILTER (WHERE accepted_without_edit=true)::int AS accepted_without_edit_count
    FROM ${schema}.ai_feedback_sessions
    WHERE created_at >= NOW() - ($1::text || ' days')::interval
    GROUP BY DATE_TRUNC('day', created_at)
    ORDER BY DATE_TRUNC('day', created_at) ASC
  `, [String(sinceDays)]);
}

module.exports = {
  ensureAiFeedbackTables,
  createFeedbackSession,
  updateFeedbackSession,
  addFeedbackEvent,
  listFeedbackEvents,
  clearFeedbackEditEvents,
  getFeedbackSessionById,
  getFeedbackSessionBySource,
  getFeedbackSessionSummary,
  getFeedbackFieldStats,
  getFeedbackSessions,
  getFeedbackDailyStats,
};
