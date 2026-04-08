'use strict';

const pgPool = require('./pg-pool');
const rag = require('./rag');

const SCHEMA = 'reservation';
const EXPERIENCE_TABLE = `${SCHEMA}.rag_experience`;

async function ensureExperienceSchema() {
  await rag.initSchema();
}

async function storeExperience(params) {
  await ensureExperienceSchema();
  return rag.storeExperience(params);
}

async function searchExperience(query, opts = {}) {
  await ensureExperienceSchema();
  return rag.searchExperience(query, opts);
}

async function getIntentStats(intent) {
  if (!intent) throw new Error('getIntentStats: intent is required');
  await ensureExperienceSchema();
  const rows = await pgPool.query(SCHEMA, `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE metadata->>'result' = 'success')::int AS success,
      COUNT(*) FILTER (WHERE metadata->>'result' = 'fail')::int AS fail
    FROM ${EXPERIENCE_TABLE}
    WHERE metadata->>'intent' = $1
  `, [intent]);
  const row = rows[0] || { total: 0, success: 0, fail: 0 };
  const total = Number(row.total || 0);
  const success = Number(row.success || 0);
  const fail = Number(row.fail || 0);
  return {
    intent,
    total,
    success,
    fail,
    successRate: total > 0 ? `${((success / total) * 100).toFixed(1)}%` : 'N/A',
  };
}

async function getPromotionCandidates(limit = 20) {
  await ensureExperienceSchema();
  return pgPool.query(SCHEMA, `
    SELECT
      metadata->>'intent' AS intent,
      content AS pattern,
      COUNT(*)::int AS success_count,
      MAX(created_at) AS last_seen
    FROM ${EXPERIENCE_TABLE}
    WHERE metadata->>'result' = 'success'
      AND created_at > NOW() - INTERVAL '30 days'
    GROUP BY metadata->>'intent', content
    HAVING COUNT(*) >= 3
    ORDER BY success_count DESC, last_seen DESC
    LIMIT $1
  `, [limit]);
}

module.exports = {
  ensureExperienceSchema,
  storeExperience,
  searchExperience,
  getIntentStats,
  getPromotionCandidates,
};
