'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const pgPool = require('../../../packages/core/lib/pg-pool');
const { detectTitlePattern } = require('./performance-diagnostician.ts');

const BLOG_ROOT = path.join(env.PROJECT_ROOT, 'bots', 'blog');
const OPS_DIR = path.join(BLOG_ROOT, 'output', 'ops');
const PLAYBOOK_PATH = path.join(OPS_DIR, 'marketing-experiment-playbook.json');

let _schemaReady = false;
let _postColumns = null;

function ensureOpsDir() {
  if (!fs.existsSync(OPS_DIR)) fs.mkdirSync(OPS_DIR, { recursive: true });
}

async function ensureExperimentSchema() {
  if (_schemaReady) return;

  await pgPool.run('blog', `
    CREATE TABLE IF NOT EXISTS blog.experiment_runs (
      id BIGSERIAL PRIMARY KEY,
      post_id TEXT UNIQUE,
      post_type TEXT NOT NULL,
      category TEXT,
      title TEXT NOT NULL,
      title_pattern TEXT,
      autonomy_lane TEXT,
      published_at TIMESTAMPTZ,
      views INTEGER DEFAULT 0,
      comments INTEGER DEFAULT 0,
      likes INTEGER DEFAULT 0,
      score NUMERIC DEFAULT 0,
      signal_types TEXT[] DEFAULT ARRAY[]::TEXT[],
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgPool.run('blog', `
    CREATE INDEX IF NOT EXISTS idx_blog_experiment_runs_post_type
    ON blog.experiment_runs(post_type, published_at DESC)
  `);
  await pgPool.run('blog', `
    CREATE INDEX IF NOT EXISTS idx_blog_experiment_runs_category
    ON blog.experiment_runs(category, published_at DESC)
  `);
  await pgPool.run('blog', `
    CREATE INDEX IF NOT EXISTS idx_blog_experiment_runs_title_pattern
    ON blog.experiment_runs(title_pattern, published_at DESC)
  `);
  await pgPool.run('blog', `
    CREATE INDEX IF NOT EXISTS idx_blog_experiment_runs_autonomy_lane
    ON blog.experiment_runs(autonomy_lane, published_at DESC)
  `);

  _schemaReady = true;
}

async function getPostColumns() {
  if (_postColumns) return _postColumns;
  try {
    const rows = await pgPool.query('blog', `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'blog'
        AND table_name = 'posts'
    `);
    _postColumns = new Set((rows || []).map((row) => String(row.column_name || '').trim()).filter(Boolean));
  } catch {
    _postColumns = new Set();
  }
  return _postColumns;
}

function normalizeAutonomyLane(rawLane = null) {
  const lane = String(rawLane || '').trim();
  if (!lane) return 'unknown';
  if (lane === 'master_review') return 'auto_publish_guarded';
  return lane;
}

function computeExperimentScore({ views = 0, comments = 0, likes = 0 } = {}) {
  const safeViews = Math.max(0, Number(views || 0));
  const safeComments = Math.max(0, Number(comments || 0));
  const safeLikes = Math.max(0, Number(likes || 0));
  return Number((safeViews + (safeComments * 45) + (safeLikes * 12)).toFixed(2));
}

function buildExperimentRecord(post = {}) {
  const metadata = post.metadata && typeof post.metadata === 'object' ? post.metadata : {};
  const autonomy = metadata.autonomy && typeof metadata.autonomy === 'object' ? metadata.autonomy : {};
  const titleAlignment = metadata.title_alignment && typeof metadata.title_alignment === 'object'
    ? metadata.title_alignment
    : {};
  const title = String(post.title || '').trim();
  const titlePattern = String(titleAlignment.final_pattern || detectTitlePattern(title) || 'unknown').trim() || 'unknown';
  const autonomyLane = normalizeAutonomyLane(autonomy.executionLane || autonomy.decision || null);
  const signalTypes = Array.isArray(autonomy?.senseSummary?.signalTypes)
    ? autonomy.senseSummary.signalTypes.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8)
    : [];
  const views = Number(post.views || 0);
  const comments = Number(post.comments || 0);
  const likes = Number(post.likes || 0);

  return {
    postId: post.id != null ? String(post.id) : '',
    postType: String(post.post_type || 'general'),
    category: post.category ? String(post.category) : null,
    title,
    titlePattern,
    autonomyLane,
    publishedAt: post.published_at || post.publish_date || post.created_at || null,
    views,
    comments,
    likes,
    score: computeExperimentScore({ views, comments, likes }),
    signalTypes,
    metadata,
  };
}

async function upsertExperimentRecord(record = {}) {
  if (!record.postId) return false;
  await ensureExperimentSchema();
  await pgPool.run('blog', `
    INSERT INTO blog.experiment_runs
      (post_id, post_type, category, title, title_pattern, autonomy_lane, published_at, views, comments, likes, score, signal_types, metadata, updated_at)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::text[], $13::jsonb, NOW())
    ON CONFLICT (post_id) DO UPDATE
    SET
      post_type = EXCLUDED.post_type,
      category = EXCLUDED.category,
      title = EXCLUDED.title,
      title_pattern = EXCLUDED.title_pattern,
      autonomy_lane = EXCLUDED.autonomy_lane,
      published_at = EXCLUDED.published_at,
      views = EXCLUDED.views,
      comments = EXCLUDED.comments,
      likes = EXCLUDED.likes,
      score = EXCLUDED.score,
      signal_types = EXCLUDED.signal_types,
      metadata = EXCLUDED.metadata,
      updated_at = NOW()
  `, [
    record.postId,
    record.postType,
    record.category,
    record.title,
    record.titlePattern,
    record.autonomyLane,
    record.publishedAt,
    record.views,
    record.comments,
    record.likes,
    record.score,
    record.signalTypes || [],
    JSON.stringify(record.metadata || {}),
  ]);
  return true;
}

async function recordPublishedExperimentRun(post = {}) {
  const record = buildExperimentRecord(post);
  const saved = await upsertExperimentRecord(record);
  return {
    saved,
    record,
  };
}

async function syncRecentExperimentRuns(days = 30) {
  await ensureExperimentSchema();
  const columns = await getPostColumns();
  const publishedExpr = columns.has('published_at')
    ? 'published_at'
    : columns.has('publish_date')
      ? 'publish_date'
      : 'created_at';
  const viewsExpr = columns.has('views')
    ? 'COALESCE(views, 0)'
    : "COALESCE(NULLIF(metadata->>'views', ''), '0')::int";
  const commentsExpr = columns.has('comments')
    ? 'COALESCE(comments, 0)'
    : "COALESCE(NULLIF(metadata->>'comments', ''), '0')::int";
  const likesExpr = columns.has('likes')
    ? 'COALESCE(likes, 0)'
    : "COALESCE(NULLIF(metadata->>'likes', ''), '0')::int";
  const rows = await pgPool.query('blog', `
    SELECT
      id,
      post_type,
      category,
      title,
      status,
      metadata,
      ${viewsExpr} AS views,
      ${commentsExpr} AS comments,
      ${likesExpr} AS likes,
      ${publishedExpr} AS published_at
    FROM blog.posts
    WHERE status = 'published'
      AND ${publishedExpr} >= NOW() - ($1::text || ' days')::interval
    ORDER BY ${publishedExpr} DESC
  `, [days]);

  let inserted = 0;
  for (const row of (rows || [])) {
    const saved = await upsertExperimentRecord(buildExperimentRecord(row));
    if (saved) inserted += 1;
  }

  return {
    scanned: Array.isArray(rows) ? rows.length : 0,
    upserted: inserted,
  };
}

function average(values = []) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
}

function buildDimensionWinner(rows = [], dimension = '', selector = () => null, minSamples = 2) {
  const usable = rows.filter((row) => selector(row));
  if (usable.length < minSamples) return null;

  const overallAvg = average(usable.map((row) => row.score));
  const grouped = new Map();
  for (const row of usable) {
    const key = String(selector(row) || '').trim();
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  const scored = [...grouped.entries()]
    .map(([variant, items]) => {
      const avgScore = average(items.map((item) => item.score));
      const avgViews = average(items.map((item) => item.views));
      const avgComments = average(items.map((item) => item.comments));
      const avgLikes = average(items.map((item) => item.likes));
      const liftPct = overallAvg > 0 ? Number(((avgScore - overallAvg) / overallAvg).toFixed(4)) : 0;
      return {
        dimension,
        variant,
        sampleCount: items.length,
        avgScore: Number(avgScore.toFixed(2)),
        avgViews: Number(avgViews.toFixed(1)),
        avgComments: Number(avgComments.toFixed(1)),
        avgLikes: Number(avgLikes.toFixed(1)),
        liftPct,
      };
    })
    .filter((item) => item.sampleCount >= minSamples)
    .sort((a, b) => {
      if (b.avgScore !== a.avgScore) return b.avgScore - a.avgScore;
      return b.sampleCount - a.sampleCount;
    });

  const winner = scored[0] || null;
  const loser = scored[scored.length - 1] || null;
  return {
    dimension,
    overallAvg: Number(overallAvg.toFixed(2)),
    variants: scored,
    winner: winner && winner.liftPct > 0 ? winner : null,
    loser: loser && loser.variant !== winner?.variant ? loser : null,
  };
}

function persistPlaybook(payload) {
  ensureOpsDir();
  fs.writeFileSync(PLAYBOOK_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function buildExperimentPlaybook({ days = 30, persist = true } = {}) {
  await ensureExperimentSchema();
  const rows = await pgPool.query('blog', `
    SELECT
      post_id,
      post_type,
      category,
      title,
      title_pattern,
      autonomy_lane,
      published_at,
      views,
      comments,
      likes,
      score,
      signal_types,
      metadata
    FROM blog.experiment_runs
    WHERE published_at >= NOW() - ($1::text || ' days')::interval
    ORDER BY published_at DESC
  `, [days]);

  const generalRows = (rows || [])
    .map((row) => ({
      ...row,
      score: Number(row.score || computeExperimentScore(row)),
      views: Number(row.views || 0),
      comments: Number(row.comments || 0),
      likes: Number(row.likes || 0),
    }))
    .filter((row) => String(row.post_type || '') === 'general');

  const titlePattern = buildDimensionWinner(generalRows, 'title_pattern', (row) => row.title_pattern);
  const category = buildDimensionWinner(generalRows, 'category', (row) => row.category);
  const autonomyLane = buildDimensionWinner(generalRows, 'autonomy_lane', (row) => row.autonomy_lane);
  const candidateWinners = [titlePattern?.winner, category?.winner, autonomyLane?.winner].filter(Boolean);
  const topWinner = candidateWinners.sort((a, b) => {
    if (b.liftPct !== a.liftPct) return b.liftPct - a.liftPct;
    return b.sampleCount - a.sampleCount;
  })[0] || null;

  const payload = {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    sampleCount: generalRows.length,
    scoreFormula: 'views + comments*45 + likes*12',
    topWinner,
    dimensions: {
      titlePattern,
      category,
      autonomyLane,
    },
  };

  if (persist) persistPlaybook(payload);
  return payload;
}

function readExperimentPlaybook() {
  try {
    const raw = fs.readFileSync(PLAYBOOK_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

module.exports = {
  PLAYBOOK_PATH,
  ensureExperimentSchema,
  normalizeAutonomyLane,
  computeExperimentScore,
  buildExperimentRecord,
  recordPublishedExperimentRun,
  syncRecentExperimentRuns,
  buildExperimentPlaybook,
  readExperimentPlaybook,
};
