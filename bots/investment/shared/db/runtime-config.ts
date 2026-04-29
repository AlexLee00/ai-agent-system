// @ts-nocheck
import { query, run, get } from './core.ts';

export async function insertRuntimeConfigSuggestionLog({
  periodDays,
  actionableCount = 0,
  marketSummary,
  suggestions,
  policySnapshot = null,
  reviewStatus = 'pending',
  reviewNote = null,
}) {
  const row = await get(
    `INSERT INTO runtime_config_suggestion_log (
       period_days,
       actionable_count,
       market_summary,
       suggestions,
       policy_snapshot,
       review_status,
       review_note
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, captured_at`,
    [
      periodDays,
      actionableCount,
      JSON.stringify(marketSummary ?? {}),
      JSON.stringify(suggestions ?? []),
      JSON.stringify(policySnapshot ?? {}),
      reviewStatus,
      reviewNote,
    ],
  );
  return row || null;
}

export async function getRecentRuntimeConfigSuggestionLogs(limit = 10) {
  return query(
    `SELECT id, period_days, actionable_count, market_summary, suggestions, policy_snapshot, review_status, review_note, reviewed_at, applied_at, captured_at
     FROM runtime_config_suggestion_log
     ORDER BY captured_at DESC
     LIMIT $1`,
    [limit],
  );
}

export async function getRuntimeConfigSuggestionLogById(id) {
  return get(
    `SELECT id, period_days, actionable_count, market_summary, suggestions, policy_snapshot, review_status, review_note, reviewed_at, applied_at, captured_at
     FROM runtime_config_suggestion_log
     WHERE id = $1`,
    [id],
  );
}

/**
 * @param {string|number} id
 * @param {{ reviewStatus?: string, reviewNote?: string|null }} [input={}]
 * @returns {Promise<any>}
 */
export async function updateRuntimeConfigSuggestionLogReview(id, {
  reviewStatus,
  reviewNote = null,
} = {}) {
  if (!id || !reviewStatus) return null;

  const normalizedStatus = String(reviewStatus).trim().toLowerCase();
  const nowClause = `now()`;
  const appliedClause = normalizedStatus === 'applied' ? nowClause : 'NULL';

  return get(
    `UPDATE runtime_config_suggestion_log
     SET review_status = $1,
         review_note = $2,
         reviewed_at = ${nowClause},
         applied_at = ${appliedClause}
     WHERE id = $3
     RETURNING id, review_status, review_note, reviewed_at, applied_at, captured_at`,
    [normalizedStatus, reviewNote, id],
  );
}
