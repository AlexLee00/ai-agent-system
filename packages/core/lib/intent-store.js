'use strict';

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

module.exports = {
  logPromotionEvent,
  upsertPromotionCandidate,
  insertUnrecognizedIntent,
};
