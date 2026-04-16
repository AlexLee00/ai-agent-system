// @ts-nocheck
'use strict';

/**
 * 키워드 자기진화 — 최근 고적합 논문 기반 추천
 */

const pgPool = require('../../../../packages/core/lib/pg-pool');

const SCHEMA = 'reservation';
const TABLE = 'rag_research';
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'for', 'and', 'or', 'to', 'with', 'on', 'by', 'is', 'are',
  'from', 'that', 'this', 'using', 'based', 'towards', 'into', 'via', 'llm', 'agent', 'agents',
  'system', 'systems', 'paper', 'study', 'model', 'models',
]);

function _tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word));
}

async function suggestKeywords(domain) {
  const rows = await pgPool.query(SCHEMA, `
    SELECT content, metadata
    FROM ${SCHEMA}.${TABLE}
    WHERE created_at >= now() - interval '7 days'
      AND COALESCE(metadata->>'type', '') != 'daily_metrics'
      AND metadata->>'domain' = $1
      AND COALESCE((metadata->>'relevance_score')::int, 0) >= 7
    ORDER BY created_at DESC
    LIMIT 20
  `, [domain]);

  if (!rows || rows.length < 3) return [];

  const wordCount = {};
  for (const row of rows) {
    const title = String(row.content || '').split('\n')[0];
    for (const word of _tokenize(title)) {
      wordCount[word] = (wordCount[word] || 0) + 1;
    }
  }

  return Object.entries(wordCount)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([word]) => word);
}

module.exports = {
  suggestKeywords,
};
