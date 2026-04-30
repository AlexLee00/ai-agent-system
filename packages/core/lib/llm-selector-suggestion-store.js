'use strict';

const pgPool = require('./pg-pool');

const SCHEMA = 'agent';

let ensured = false;

async function ensureSystemPreferencesTable() {
  if (ensured) return;
  await pgPool.run(SCHEMA, `
    CREATE TABLE IF NOT EXISTS llm_selector_override_suggestion_log (
      id BIGSERIAL PRIMARY KEY,
      selector_key TEXT NOT NULL,
      label TEXT,
      decision TEXT NOT NULL,
      candidate_model TEXT,
      config_path TEXT,
      runtime_path TEXT,
      reason TEXT,
      suggested_chain JSONB,
      review_status TEXT NOT NULL DEFAULT 'pending',
      review_note TEXT,
      reviewed_at TIMESTAMPTZ,
      applied_at TIMESTAMPTZ,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_agent_llm_selector_override_suggestion_log_captured_at
    ON llm_selector_override_suggestion_log (captured_at DESC)
  `);
  ensured = true;
}

async function insertSelectorOverrideSuggestionLog(item) {
  await ensureSystemPreferencesTable();
  return pgPool.get(SCHEMA, `
    INSERT INTO llm_selector_override_suggestion_log
      (selector_key, label, decision, candidate_model, config_path, runtime_path, reason, suggested_chain)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    RETURNING id, selector_key, label, decision, candidate_model, config_path, runtime_path, reason,
              suggested_chain, review_status, review_note, reviewed_at, applied_at, captured_at
  `, [
    item.key,
    item.label || null,
    item.decision,
    item.candidate || null,
    item.config || null,
    item.path || null,
    item.reason || null,
    JSON.stringify(item.suggestedChain || []),
  ]);
}

async function getRecentSelectorOverrideSuggestionLogs(limit = 20) {
  await ensureSystemPreferencesTable();
  return pgPool.query(SCHEMA, `
    SELECT id, selector_key, label, decision, candidate_model, config_path, runtime_path, reason,
           suggested_chain, review_status, review_note, reviewed_at, applied_at, captured_at
    FROM llm_selector_override_suggestion_log
    ORDER BY captured_at DESC, id DESC
    LIMIT $1
  `, [limit]);
}

async function getSelectorOverrideSuggestionLogById(id) {
  await ensureSystemPreferencesTable();
  return pgPool.get(SCHEMA, `
    SELECT id, selector_key, label, decision, candidate_model, config_path, runtime_path, reason,
           suggested_chain, review_status, review_note, reviewed_at, applied_at, captured_at
    FROM llm_selector_override_suggestion_log
    WHERE id = $1
  `, [id]);
}

async function updateSelectorOverrideSuggestionLogReview(id, {
  reviewStatus,
  reviewNote = null,
} = {}) {
  await ensureSystemPreferencesTable();
  const normalizedStatus = String(reviewStatus || '').trim().toLowerCase();
  const appliedClause = normalizedStatus === 'applied' ? 'NOW()' : 'NULL';
  return pgPool.get(SCHEMA, `
    UPDATE llm_selector_override_suggestion_log
    SET review_status = $1,
        review_note = $2,
        reviewed_at = NOW(),
        applied_at = ${appliedClause}
    WHERE id = $3
    RETURNING id, selector_key, label, decision, candidate_model, config_path, runtime_path, reason,
              suggested_chain, review_status, review_note, reviewed_at, applied_at, captured_at
  `, [normalizedStatus, reviewNote, id]);
}

module.exports = {
  ensureSystemPreferencesTable,
  insertSelectorOverrideSuggestionLog,
  getRecentSelectorOverrideSuggestionLogs,
  getSelectorOverrideSuggestionLogById,
  updateSelectorOverrideSuggestionLogReview,
};
