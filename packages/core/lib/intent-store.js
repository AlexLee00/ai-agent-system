'use strict';

const {
  buildPromotionCandidateWhere,
  buildPromotionEventWhere,
  buildUnrecognizedReportQueries,
} = require('./intent-core');

async function ensureIntentTables(pgPool, {
  schema = 'claude',
} = {}) {
  if (!pgPool) return;
  await pgPool.run(schema, `
    CREATE TABLE IF NOT EXISTS unrecognized_intents (
      id           SERIAL PRIMARY KEY,
      text         TEXT NOT NULL,
      parse_source TEXT,
      llm_intent   TEXT,
      promoted_to  TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgPool.run(schema, `
    CREATE INDEX IF NOT EXISTS idx_unrec_created ON unrecognized_intents(created_at DESC)
  `);
  await pgPool.run(schema, `
    CREATE TABLE IF NOT EXISTS intent_promotion_candidates (
      id               SERIAL PRIMARY KEY,
      normalized_text  TEXT NOT NULL UNIQUE,
      sample_text      TEXT NOT NULL,
      suggested_intent TEXT NOT NULL,
      occurrence_count INTEGER NOT NULL DEFAULT 0,
      confidence       NUMERIC(5,4) NOT NULL DEFAULT 0,
      auto_applied     BOOLEAN NOT NULL DEFAULT FALSE,
      learned_pattern  TEXT,
      first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgPool.run(schema, `
    CREATE INDEX IF NOT EXISTS idx_promotion_candidates_last_seen
    ON intent_promotion_candidates(last_seen_at DESC)
  `);
  await pgPool.run(schema, `
    CREATE TABLE IF NOT EXISTS intent_promotion_events (
      id               SERIAL PRIMARY KEY,
      candidate_id     INTEGER,
      normalized_text  TEXT,
      sample_text      TEXT,
      suggested_intent TEXT,
      event_type       TEXT NOT NULL,
      learned_pattern  TEXT,
      actor            TEXT NOT NULL DEFAULT 'system',
      metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgPool.run(schema, `
    CREATE INDEX IF NOT EXISTS idx_promotion_events_created
    ON intent_promotion_events(created_at DESC)
  `);
}

async function logPromotionEvent(pgPool, {
  schema = 'claude',
  candidateId = null,
  normalizedText = null,
  sampleText = null,
  suggestedIntent = null,
  eventType,
  learnedPattern = null,
  actor = 'system',
  metadata = {},
} = {}) {
  if (!pgPool || !eventType) return;
  await pgPool.run(schema, `
    INSERT INTO intent_promotion_events (
      candidate_id, normalized_text, sample_text, suggested_intent,
      event_type, learned_pattern, actor, metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
  `, [
    candidateId,
    normalizedText,
    sampleText,
    suggestedIntent,
    eventType,
    learnedPattern,
    actor,
    JSON.stringify(metadata || {}),
  ]);
}

async function upsertPromotionCandidate(pgPool, {
  schema = 'claude',
  normalizedText,
  sampleText,
  suggestedIntent,
  occurrenceCount,
  confidence,
  autoApplied,
  learnedPattern,
} = {}) {
  if (!pgPool || !normalizedText || !suggestedIntent) return;
  await pgPool.run(schema, `
    INSERT INTO intent_promotion_candidates (
      normalized_text, sample_text, suggested_intent, occurrence_count,
      confidence, auto_applied, learned_pattern, first_seen_at, last_seen_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), NOW())
    ON CONFLICT (normalized_text) DO UPDATE
    SET sample_text      = EXCLUDED.sample_text,
        suggested_intent = EXCLUDED.suggested_intent,
        occurrence_count = EXCLUDED.occurrence_count,
        confidence       = EXCLUDED.confidence,
        auto_applied     = intent_promotion_candidates.auto_applied OR EXCLUDED.auto_applied,
        learned_pattern  = COALESCE(intent_promotion_candidates.learned_pattern, EXCLUDED.learned_pattern),
        last_seen_at     = NOW(),
        updated_at       = NOW()
  `, [
    normalizedText,
    sampleText,
    suggestedIntent,
    occurrenceCount,
    confidence,
    !!autoApplied,
    learnedPattern || null,
  ]);
}

async function insertUnrecognizedIntent(pgPool, {
  schema = 'claude',
  text,
  parseSource,
  llmIntent,
} = {}) {
  if (!pgPool || !text) return;
  await pgPool.run(schema, `
    INSERT INTO unrecognized_intents (text, parse_source, llm_intent)
    VALUES ($1, $2, $3)
  `, [
    String(text).slice(0, 500),
    parseSource || 'unknown',
    llmIntent || null,
  ]);
}

async function getPromotionSummary(pgPool, {
  schema = 'claude',
  filters = {},
} = {}) {
  const candidateWhere = buildPromotionCandidateWhere(filters);
  return pgPool.get(schema, `
    SELECT
      COUNT(*)::int AS total_count,
      COUNT(*) FILTER (WHERE auto_applied = true)::int AS applied_count,
      COUNT(*) FILTER (WHERE auto_applied = false)::int AS pending_count
    FROM intent_promotion_candidates
    ${candidateWhere.whereSql}
  `, candidateWhere.params);
}

async function getPromotionRows(pgPool, {
  schema = 'claude',
  filters = {},
  limit = 20,
} = {}) {
  const candidateWhere = buildPromotionCandidateWhere(filters, { tableAlias: 'c' });
  return pgPool.query(schema, `
    SELECT
      c.id,
      c.sample_text,
      c.suggested_intent,
      c.occurrence_count,
      c.confidence,
      c.auto_applied,
      c.updated_at,
      e.event_type AS latest_event_type,
      e.metadata AS latest_event_metadata
    FROM intent_promotion_candidates c
    LEFT JOIN LATERAL (
      SELECT event_type, metadata
      FROM intent_promotion_events
      WHERE candidate_id = c.id
      ORDER BY created_at DESC
      LIMIT 1
    ) e ON true
    ${candidateWhere.whereSql}
    ORDER BY c.auto_applied DESC, c.updated_at DESC
    LIMIT ${Number(limit)}
  `, candidateWhere.params);
}

async function getPromotionFamilyRows(pgPool, {
  schema = 'claude',
  filters = {},
  limit = 200,
} = {}) {
  const candidateWhere = buildPromotionCandidateWhere(filters);
  return pgPool.query(schema, `
    SELECT suggested_intent, auto_applied, occurrence_count
    FROM intent_promotion_candidates
    ${candidateWhere.whereSql}
    ORDER BY updated_at DESC
    LIMIT ${Number(limit)}
  `, candidateWhere.params);
}

async function getPromotionEvents(pgPool, {
  schema = 'claude',
  filters = {},
  limit = 10,
} = {}) {
  const eventWhere = buildPromotionEventWhere(filters);
  return pgPool.query(schema, `
    SELECT event_type, sample_text, suggested_intent, actor, created_at
    FROM intent_promotion_events
    ${eventWhere.whereSql}
    ORDER BY created_at DESC
    LIMIT ${Number(limit)}
  `, eventWhere.params);
}

async function findPromotionCandidate(pgPool, {
  schema = 'claude',
  candidateId,
  normalizedText,
  rawText,
} = {}) {
  if (Number.isFinite(candidateId)) {
    return pgPool.get(schema, `
      SELECT id, normalized_text, sample_text, suggested_intent, learned_pattern, auto_applied
      FROM intent_promotion_candidates
      WHERE id = $1
      LIMIT 1
    `, [candidateId]);
  }
  return pgPool.get(schema, `
    SELECT id, normalized_text, sample_text, suggested_intent, learned_pattern, auto_applied
    FROM intent_promotion_candidates
    WHERE normalized_text = $1 OR sample_text = $2
    LIMIT 1
  `, [normalizedText, rawText]);
}

async function getUnrecognizedReportRows(pgPool, {
  schema = 'claude',
  days = 7,
  candidateLimit = 20,
} = {}) {
  const queries = buildUnrecognizedReportQueries({ days, candidateLimit });
  const [rows, candidates] = await Promise.all([
    pgPool.query(schema, queries.unrecognizedSql),
    pgPool.query(schema, queries.candidatesSql),
  ]);
  return { rows, candidates };
}

async function clearPromotedUnrecognized(pgPool, {
  schema = 'claude',
  suggestedIntent,
  normalizedText,
} = {}) {
  if (!pgPool || !suggestedIntent || !normalizedText) return;
  await pgPool.run(schema, `
    UPDATE unrecognized_intents
    SET promoted_to = NULL
    WHERE promoted_to = $1
      AND lower(regexp_replace(text, '[^[:alnum:][:space:]]', ' ', 'g')) LIKE '%' || $2 || '%'
  `, [suggestedIntent, normalizedText]);
}

async function clearPromotionCandidateState(pgPool, {
  schema = 'claude',
  candidateId,
} = {}) {
  if (!pgPool || !candidateId) return;
  await pgPool.run(schema, `
    UPDATE intent_promotion_candidates
    SET auto_applied = FALSE,
        learned_pattern = NULL,
        updated_at = NOW()
    WHERE id = $1
  `, [candidateId]);
}

async function markUnrecognizedPromoted(pgPool, {
  schema = 'claude',
  intent,
  recordIds = [],
  text,
} = {}) {
  if (!pgPool || !intent) return;
  if (Array.isArray(recordIds) && recordIds.length > 0) {
    await pgPool.run(schema, `
      UPDATE unrecognized_intents
      SET promoted_to = $1
      WHERE id = ANY($2::int[]) AND promoted_to IS NULL
    `, [intent, recordIds]);
    return;
  }
  if (text) {
    await pgPool.run(schema, `
      UPDATE unrecognized_intents
      SET promoted_to = $1
      WHERE text = $2 AND promoted_to IS NULL
    `, [intent, text]);
  }
}

module.exports = {
  ensureIntentTables,
  logPromotionEvent,
  upsertPromotionCandidate,
  insertUnrecognizedIntent,
  getPromotionSummary,
  getPromotionRows,
  getPromotionFamilyRows,
  getPromotionEvents,
  findPromotionCandidate,
  getUnrecognizedReportRows,
  clearPromotedUnrecognized,
  clearPromotionCandidateState,
  markUnrecognizedPromoted,
};
