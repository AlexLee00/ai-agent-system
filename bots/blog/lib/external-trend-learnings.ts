#!/usr/bin/env node
// @ts-nocheck
'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool');
const { classifyTitlePattern, buildTitlePatternSummary } = require('./crank-diagnoser.ts');

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeGenre(value = '') {
  const raw = normalizeText(value).toLowerCase();
  if (raw === 'it') return 'it';
  if (raw === 'book') return 'book';
  return '';
}

function inferGenreFromTrendRow(row = {}) {
  const meta = typeof row.meta === 'string' ? safeJson(row.meta) : (row.meta || {});
  return normalizeGenre(meta?.raw?.genre || meta?.genre || row.genre || '');
}

function safeJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function buildGenreTitlePatternLessons(rows = [], options = {}) {
  const minSamples = Math.max(1, Number(options.minSamples || 2));
  const lessons = [];
  for (const genre of ['it', 'book']) {
    const genreRows = (rows || [])
      .filter((row) => inferGenreFromTrendRow(row) === genre)
      .map((row) => ({
        title: row.title || row.topic_ko || row.review_title || row.book_title,
      }))
      .filter((row) => normalizeText(row.title));
    if (genreRows.length < minSamples) continue;
    const summary = buildTitlePatternSummary(genreRows, { threshold: Number(options.threshold || 0.45) });
    const top = summary.top || null;
    if (!top) continue;
    lessons.push({
      genre,
      axis: 'external_title_pattern',
      count: genreRows.length,
      topPattern: top.key,
      topLabel: top.label,
      topRatio: top.ratio,
      lesson: `${genre} 외부 상위 제목 ${Math.round(Number(top.ratio || 0) * 100)}%가 ${top.label}입니다. 다음 글 제목은 같은 패턴 반복을 피하고 보완 패턴을 섞으세요.`,
      patternSummary: summary,
    });
  }
  return lessons;
}

async function summarizeRecentExternalTrendLearnings({ days = 7, limit = 200, pool = pgPool } = {}) {
  try {
    const rows = await pool.query('blog', `
      SELECT id, source, topic_ko, category, meta, created_at
      FROM blog.trend_topics
      WHERE created_at >= NOW() - ($1::text || ' days')::interval
        AND COALESCE(meta->'raw'->>'genre', meta->>'genre', '') IN ('it', 'book')
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `, [
      Math.max(1, Number(days || 7)),
      Math.max(1, Number(limit || 200)),
    ]);
    const rawRows = Array.isArray(rows) ? rows : rows?.rows || [];
    return {
      ok: true,
      source: 'blog.trend_topics',
      rows: rawRows,
      lessons: buildGenreTitlePatternLessons(rawRows),
    };
  } catch (error) {
    return {
      ok: false,
      source: 'blog.trend_topics',
      rows: [],
      lessons: [],
      error: error?.message || String(error),
    };
  }
}

module.exports = {
  buildGenreTitlePatternLessons,
  classifyTitlePattern,
  inferGenreFromTrendRow,
  summarizeRecentExternalTrendLearnings,
};
