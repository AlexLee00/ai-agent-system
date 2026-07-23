// @ts-nocheck
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const env = require('../../../packages/core/lib/env');
const pgPool = require('../../../packages/core/lib/pg-pool');
const { isTooCloseToRecentTitle, mergeRecentTitles } = require('./topic-title-guard.ts');

const DEFAULT_HISTORY_DAYS = 30;
const DEFAULT_OUTPUT_DIR = path.join(env.PROJECT_ROOT, 'bots', 'blog', 'output');

async function loadDbTitleHistory({ pool = pgPool, days = DEFAULT_HISTORY_DAYS } = {}) {
  try {
    const rows = await pool.query('blog', `
      SELECT title
      FROM blog.posts
      WHERE post_type = 'general'
        AND status IN ('ready', 'published')
        AND COALESCE(publish_date::timestamptz, created_at) >= NOW() - ($1::text || ' days')::interval
        AND COALESCE(title, '') <> ''
      ORDER BY COALESCE(publish_date::timestamptz, created_at) DESC, id DESC
      LIMIT 200
    `, [Math.max(1, Number(days || DEFAULT_HISTORY_DAYS))]);
    return {
      available: true,
      titles: (rows || []).map((row) => String(row.title || '').trim()).filter(Boolean),
      error: null,
    };
  } catch (error) {
    return { available: false, titles: [], error: String(error?.message || error) };
  }
}

function loadOutputTitleHistory({
  outputDir = DEFAULT_OUTPUT_DIR,
  days = DEFAULT_HISTORY_DAYS,
  now = new Date(),
  fsModule = fs,
} = {}) {
  try {
    const cutoff = new Date(now.getTime() - Math.max(1, Number(days || DEFAULT_HISTORY_DAYS)) * 86_400_000);
    const titles = fsModule.readdirSync(outputDir)
      .map((filename) => {
        const match = String(filename).match(/^(\d{4}-\d{2}-\d{2})_general_(.+)\.html$/);
        if (!match) return null;
        const observedAt = new Date(`${match[1]}T00:00:00+09:00`);
        if (Number.isNaN(observedAt.getTime()) || observedAt < cutoff) return null;
        return String(match[2] || '').trim();
      })
      .filter(Boolean);
    return { available: true, titles, error: null };
  } catch (error) {
    return { available: false, titles: [], error: String(error?.message || error) };
  }
}

async function assertFinalGeneralTitle(title, options = {}) {
  const loadDb = options.loadDbTitleHistory || loadDbTitleHistory;
  const loadOutput = options.loadOutputTitleHistory || loadOutputTitleHistory;
  const [dbHistory, outputHistory] = await Promise.all([
    loadDb(options),
    Promise.resolve(loadOutput(options)),
  ]);

  if (!dbHistory?.available && !outputHistory?.available) {
    const error = new Error('최종 제목 이력을 조회할 수 없어 발행을 보류합니다.');
    error.code = 'title_history_unavailable';
    error.details = { dbError: dbHistory?.error || null, outputError: outputHistory?.error || null };
    throw error;
  }

  const recentTitles = mergeRecentTitles(dbHistory?.titles, outputHistory?.titles);
  const conflict = recentTitles.find((recentTitle) => isTooCloseToRecentTitle(title, [recentTitle])) || null;
  if (conflict) {
    const error = new Error(`30일 이력과 제목 구조가 겹쳐 발행을 보류합니다: ${conflict}`);
    error.code = 'final_title_overlap';
    error.details = { title, conflict };
    throw error;
  }

  return {
    ok: true,
    historyCount: recentTitles.length,
    sources: {
      db: Boolean(dbHistory?.available),
      output: Boolean(outputHistory?.available),
    },
    degraded: !dbHistory?.available || !outputHistory?.available,
  };
}

module.exports = {
  DEFAULT_HISTORY_DAYS,
  loadDbTitleHistory,
  loadOutputTitleHistory,
  assertFinalGeneralTitle,
};
