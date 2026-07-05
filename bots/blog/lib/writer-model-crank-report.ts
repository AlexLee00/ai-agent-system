// @ts-nocheck
'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool');
const { DEFAULT_BLOG_WRITER_MODEL } = require('./writer-model-policy.ts');

function normalizeRows(rows) {
  return Array.isArray(rows) ? rows : rows?.rows || [];
}

function normalizeWriterModel(value = '') {
  const raw = String(value || '').trim();
  return raw || DEFAULT_BLOG_WRITER_MODEL;
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function buildWriterModelCrankComparison(rows = [], { minSamples = 5 } = {}) {
  const grouped = new Map();
  for (const row of normalizeRows(rows)) {
    const overall = Number(row.overall);
    if (!Number.isFinite(overall)) continue;
    const writerModel = normalizeWriterModel(row.writer_model || row.writerModel);
    const current = grouped.get(writerModel) || {
      writerModel,
      sample: 0,
      totalOverall: 0,
      postTypes: {},
    };
    current.sample += 1;
    current.totalOverall += overall;
    const postType = String(row.post_type || row.postType || 'unknown');
    current.postTypes[postType] = Number(current.postTypes[postType] || 0) + 1;
    grouped.set(writerModel, current);
  }

  const models = [...grouped.values()]
    .map((item) => ({
      writerModel: item.writerModel,
      sample: item.sample,
      avgOverall: item.sample > 0 ? round2(item.totalOverall / item.sample) : null,
      postTypes: item.postTypes,
      verdict: item.sample >= Number(minSamples || 5) ? 'comparable' : '판정 불가',
    }))
    .sort((left, right) => Number(right.sample || 0) - Number(left.sample || 0) || String(left.writerModel).localeCompare(String(right.writerModel)));

  return {
    ok: true,
    source: 'blog.crank_scores+blog.posts.metadata.writer_model',
    minSamples: Number(minSamples || 5),
    totalSamples: models.reduce((sum, item) => sum + Number(item.sample || 0), 0),
    models,
  };
}

async function fetchWriterModelCrankRows({ days = 30, limit = 300, pool = pgPool } = {}) {
  const rows = await pool.query('blog', `
    WITH latest AS (
      SELECT DISTINCT ON (cs.post_id)
        cs.post_id,
        p.post_type,
        COALESCE(NULLIF(p.metadata->>'writer_model', ''), $3) AS writer_model,
        cs.scored_date,
        cs.overall
      FROM blog.crank_scores cs
      JOIN blog.posts p ON p.id = cs.post_id
      WHERE cs.scored_date >= CURRENT_DATE - ($1::text || ' days')::interval
      ORDER BY cs.post_id, cs.scored_date DESC, cs.id DESC
    )
    SELECT *
    FROM latest
    ORDER BY scored_date DESC, post_id DESC
    LIMIT $2
  `, [
    Math.max(1, Number(days || 30)),
    Math.max(1, Number(limit || 300)),
    DEFAULT_BLOG_WRITER_MODEL,
  ]);
  return normalizeRows(rows);
}

async function buildWriterModelCrankComparisonFromDb(options = {}) {
  try {
    const rows = options.rows || await fetchWriterModelCrankRows(options);
    return buildWriterModelCrankComparison(rows, options);
  } catch (error) {
    return {
      ok: false,
      source: 'blog.crank_scores+blog.posts.metadata.writer_model',
      error: error?.message || String(error),
      minSamples: Number(options.minSamples || 5),
      totalSamples: 0,
      models: [],
    };
  }
}

module.exports = {
  normalizeWriterModel,
  buildWriterModelCrankComparison,
  fetchWriterModelCrankRows,
  buildWriterModelCrankComparisonFromDb,
};
