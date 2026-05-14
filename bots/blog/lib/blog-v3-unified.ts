// @ts-nocheck
'use strict';

/**
 * Blog V3 unified shadow utilities.
 *
 * This module keeps V3 scoring/evidence logic out of live publish paths unless
 * callers explicitly persist evidence. Dry-run callers must not write DB state.
 */

const pgPool = require('../../../packages/core/lib/pg-pool');
const kst = require('../../../packages/core/lib/kst');

const SOURCE_WEIGHTS = {
  naver: 0.40,
  naver_datalab: 0.40,
  naver_home_feed: 0.40,
  reddit: 0.35,
  bestseller: 0.25,
};

const SOURCE_LABELS = {
  naver: 'Naver',
  naver_datalab: 'Naver DataLab',
  naver_home_feed: 'Naver HomeFeed',
  reddit: 'Reddit',
  bestseller: 'Aladin Bestseller',
};

const NAVER_TREND_FIXTURES = [
  { keyword: 'AI 도구', trend_score: 82, growth_rate_week: 34 },
  { keyword: '독서 루틴', trend_score: 76, growth_rate_week: 28 },
  { keyword: '개발 자동화', trend_score: 71, growth_rate_week: 22 },
];

function clampNumber(value, min = 0, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
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

function normalizeSource(source) {
  const raw = String(source || '').toLowerCase();
  if (raw.includes('naver')) return 'naver';
  if (raw.includes('reddit')) return 'reddit';
  if (raw.includes('bestseller') || raw.includes('aladin')) return 'bestseller';
  return raw || 'unknown';
}

function sourceWeightFor(source) {
  return SOURCE_WEIGHTS[normalizeSource(source)] || 0.20;
}

function dateAgeDays(value) {
  if (!value) return 0;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 0;
  const now = new Date();
  return Math.max(0, Math.floor((now.getTime() - d.getTime()) / 86_400_000));
}

function calculateTrendFusionScore(row = {}) {
  const meta = safeJson(row.meta);
  const source = normalizeSource(row.source);
  const trendScore = clampNumber(row.trend_score);
  const koreaRelevance = clampNumber(row.korea_relevance);
  const sourceWeight = sourceWeightFor(source);
  const sourceCount = Math.max(
    1,
    Number(meta.source_count || 0),
    Array.isArray(meta.sources) ? meta.sources.length : 0,
  );
  const diversityBonus = Math.min(10, (sourceCount - 1) * 5);
  const recencyBonus = dateAgeDays(row.date || row.created_at) <= 1 ? 8 : dateAgeDays(row.date || row.created_at) <= 7 ? 4 : 0;
  const bookBonus = row.is_book_topic ? 3 : 0;

  const weighted =
    (trendScore * 0.42)
    + (koreaRelevance * 0.28)
    + (sourceWeight * 100 * 0.20)
    + diversityBonus
    + recencyBonus
    + bookBonus;

  return {
    score: Math.round(clampNumber(weighted, 0, 100)),
    source,
    sourceWeight,
    diversityBonus,
    recencyBonus,
    bookBonus,
    components: {
      trendScore,
      koreaRelevance,
      sourceWeight,
      sourceCount,
    },
  };
}

function buildNaverTrendTopics(trends = NAVER_TREND_FIXTURES) {
  return (trends || []).slice(0, 10).map((trend) => {
    const keyword = trend.keyword || trend.topic_ko || trend.title;
    const growth = Number(trend.growth_rate_week || 0);
    const score = clampNumber(trend.trend_score || 60 + Math.min(30, Math.max(0, growth)));
    return {
      topic_ko: `${keyword} 흐름에서 지금 확인할 실행 기준`,
      category: /AI|개발|자동화|기술/i.test(keyword) ? '최신IT트렌드' : /독서|책|루틴/i.test(keyword) ? '자기계발' : 'IT정보와분석',
      keywords: [keyword],
      trend_score: score,
      korea_relevance: Math.max(65, Math.min(100, score + Math.round(growth / 2))),
      is_book_topic: /독서|책|도서/i.test(keyword),
      reason: `Naver trend growth ${growth}% 기반 V3 후보`,
      naver_source: 'datalab',
    };
  });
}

async function ensureBlogV3Tables() {
  await pgPool.run('blog', `
    CREATE SCHEMA IF NOT EXISTS blog;

    CREATE TABLE IF NOT EXISTS blog.trend_topics (
      id          SERIAL PRIMARY KEY,
      date        DATE NOT NULL DEFAULT CURRENT_DATE,
      source      TEXT NOT NULL,
      topic_ko    TEXT NOT NULL,
      category    TEXT,
      keywords    JSONB,
      trend_score INTEGER DEFAULT 0,
      korea_relevance INTEGER DEFAULT 0,
      is_book_topic BOOLEAN DEFAULT false,
      used        BOOLEAN DEFAULT false,
      meta        JSONB,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE blog.trend_topics ADD COLUMN IF NOT EXISTS fusion_score INTEGER DEFAULT 0;
    ALTER TABLE blog.trend_topics ADD COLUMN IF NOT EXISTS source_weight NUMERIC DEFAULT 0;
    ALTER TABLE blog.trend_topics ADD COLUMN IF NOT EXISTS evidence JSONB DEFAULT '{}'::jsonb;
    CREATE INDEX IF NOT EXISTS idx_trend_topics_date ON blog.trend_topics(date);
    CREATE INDEX IF NOT EXISTS idx_trend_topics_source ON blog.trend_topics(source, date DESC);
    CREATE INDEX IF NOT EXISTS idx_trend_topics_used ON blog.trend_topics(used) WHERE used = false;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trend_topics_uniq ON blog.trend_topics(date, source, topic_ko);

    CREATE TABLE IF NOT EXISTS blog.naver_exposure_audits (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NULL,
      title TEXT NOT NULL,
      category TEXT,
      overall_score INTEGER NOT NULL DEFAULT 0,
      title_score INTEGER NOT NULL DEFAULT 0,
      hook_score INTEGER NOT NULL DEFAULT 0,
      dwell_seconds INTEGER NOT NULL DEFAULT 0,
      channels JSONB NOT NULL DEFAULT '[]'::jsonb,
      top_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
      shadow_only BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_naver_exposure_audits_created ON blog.naver_exposure_audits(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_naver_exposure_audits_post ON blog.naver_exposure_audits(post_id);

    CREATE TABLE IF NOT EXISTS blog.humanize_audits (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NULL,
      title TEXT,
      before_score INTEGER NOT NULL DEFAULT 0,
      after_score INTEGER NOT NULL DEFAULT 0,
      sentence_score INTEGER NOT NULL DEFAULT 0,
      signal_count INTEGER NOT NULL DEFAULT 0,
      improved BOOLEAN NOT NULL DEFAULT false,
      shadow_only BOOLEAN NOT NULL DEFAULT true,
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_humanize_audits_created ON blog.humanize_audits(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_humanize_audits_post ON blog.humanize_audits(post_id);

    CREATE TABLE IF NOT EXISTS blog.blog_v3_shadow_evidence (
      id SERIAL PRIMARY KEY,
      evidence_type TEXT NOT NULL,
      ok BOOLEAN NOT NULL DEFAULT true,
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_blog_v3_shadow_evidence_type ON blog.blog_v3_shadow_evidence(evidence_type, created_at DESC);
  `);
}

async function saveTrendTopics(topics, source, options = {}) {
  const dryRun = !!options.dryRun;
  const today = options.date || kst.today();
  const normalizedSource = normalizeSource(source);
  const rows = (topics || []).filter(Boolean);
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      source: normalizedSource,
      inserted: 0,
      candidates: rows.length,
    };
  }
  if (rows.length === 0) return { ok: true, dryRun: false, source: normalizedSource, inserted: 0, candidates: 0 };

  await ensureBlogV3Tables();
  let inserted = 0;
  for (const topic of rows) {
    const fusion = calculateTrendFusionScore({ ...topic, source: normalizedSource, date: today });
    const meta = {
      reason: topic.reason || null,
      reddit_source: topic.reddit_source || null,
      naver_source: topic.naver_source || null,
      source_count: topic.source_count || 1,
      sources: topic.sources || [normalizedSource],
      added_by: options.addedBy || `${normalizedSource}-collector`,
      raw: topic.meta || null,
    };
    const result = await pgPool.run('blog', `
      INSERT INTO blog.trend_topics
        (date, source, topic_ko, category, keywords, trend_score, korea_relevance, is_book_topic, meta, fusion_score, source_weight, evidence)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (date, source, topic_ko) DO UPDATE SET
        category = EXCLUDED.category,
        keywords = EXCLUDED.keywords,
        trend_score = EXCLUDED.trend_score,
        korea_relevance = EXCLUDED.korea_relevance,
        is_book_topic = EXCLUDED.is_book_topic,
        meta = EXCLUDED.meta,
        fusion_score = EXCLUDED.fusion_score,
        source_weight = EXCLUDED.source_weight,
        evidence = EXCLUDED.evidence
      RETURNING id
    `, [
      today,
      normalizedSource,
      topic.topic_ko || topic.title,
      topic.category || null,
      JSON.stringify(topic.keywords || []),
      Math.round(clampNumber(topic.trend_score)),
      Math.round(clampNumber(topic.korea_relevance)),
      !!topic.is_book_topic,
      JSON.stringify(meta),
      fusion.score,
      fusion.sourceWeight,
      JSON.stringify({ fusion, shadowMode: true }),
    ]);
    if (result?.rowCount > 0) inserted++;
  }
  return { ok: true, dryRun: false, source: normalizedSource, inserted, candidates: rows.length };
}

async function recordShadowEvidence(evidenceType, evidence, options = {}) {
  if (options.dryRun) return { ok: true, dryRun: true, inserted: 0 };
  await ensureBlogV3Tables();
  const result = await pgPool.run('blog', `
    INSERT INTO blog.blog_v3_shadow_evidence (evidence_type, ok, evidence)
    VALUES ($1, $2, $3)
    RETURNING id
  `, [evidenceType, evidence?.ok !== false, JSON.stringify(evidence || {})]);
  return { ok: true, dryRun: false, inserted: result?.rowCount || 0 };
}

async function evaluateBlogV3PromotionGate() {
  const result = {
    ok: true,
    promotionReady: false,
    shadowMode: true,
    checks: {},
    checkedAt: new Date().toISOString(),
  };
  try {
    const rows = await pgPool.run('blog', `
      SELECT
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS evidence_7d,
        COUNT(*) FILTER (WHERE evidence_type = 'topic_fusion' AND created_at > NOW() - INTERVAL '7 days') AS topic_fusion_7d,
        COUNT(*) FILTER (WHERE evidence_type = 'hub_llm_route_audit' AND ok = false AND created_at > NOW() - INTERVAL '7 days') AS llm_violations_7d
      FROM blog.blog_v3_shadow_evidence
    `).catch(() => ({ rows: [] }));
    const audit = rows?.rows?.[0] || {};
    const human = await pgPool.run('blog', `
      SELECT COALESCE(AVG(after_score), 0) AS avg_after
      FROM blog.humanize_audits
      WHERE created_at > NOW() - INTERVAL '7 days'
    `).catch(() => ({ rows: [] }));
    const exposure = await pgPool.run('blog', `
      SELECT COUNT(*) AS count
      FROM blog.naver_exposure_audits
      WHERE created_at > NOW() - INTERVAL '7 days'
    `).catch(() => ({ rows: [] }));
    result.checks = {
      shadowEvidence7d: Number(audit.evidence_7d || 0),
      topicFusion7d: Number(audit.topic_fusion_7d || 0),
      llmViolations7d: Number(audit.llm_violations_7d || 0),
      humanizeAvgAfter: Number(human?.rows?.[0]?.avg_after || 0),
      exposureAudits7d: Number(exposure?.rows?.[0]?.count || 0),
    };
    result.promotionReady =
      result.checks.shadowEvidence7d >= 5
      && result.checks.topicFusion7d >= 1
      && result.checks.llmViolations7d === 0
      && result.checks.humanizeAvgAfter >= 90
      && result.checks.exposureAudits7d >= 1;
  } catch (error) {
    result.ok = false;
    result.error = error.message;
  }
  return result;
}

module.exports = {
  SOURCE_WEIGHTS,
  SOURCE_LABELS,
  NAVER_TREND_FIXTURES,
  buildNaverTrendTopics,
  calculateTrendFusionScore,
  ensureBlogV3Tables,
  evaluateBlogV3PromotionGate,
  normalizeSource,
  recordShadowEvidence,
  saveTrendTopics,
  safeJson,
  sourceWeightFor,
};
