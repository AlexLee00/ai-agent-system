// @ts-nocheck
'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool');
const { senseDailyState } = require('./sense-engine.ts');
const { analyzeMarketingToRevenue } = require('./marketing-revenue-correlation.ts');
const { diagnoseWeeklyPerformance } = require('./performance-diagnostician.ts');
const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const { detectTitlePattern } = require('./performance-diagnostician.ts');
const { getNextGeneralCategory } = require('./category-rotation.ts');
const { getRecentPosts, selectAndValidateTopic } = require('./topic-selector.ts');

const STRATEGY_DIR = path.join(env.PROJECT_ROOT, 'bots/blog/output/strategy');
const LATEST_STRATEGY_PATH = path.join(STRATEGY_DIR, 'latest-strategy.json');
const BLOG_OUTPUT_DIR = path.join(env.PROJECT_ROOT, 'bots/blog/output');

async function getAutonomySummary(days = 14) {
  try {
    const rows = await pgPool.query('blog', `
      SELECT
        COALESCE(count(*), 0)::int AS total_count,
        COALESCE(count(*) FILTER (WHERE decision = 'auto_publish'), 0)::int AS auto_publish_count,
        COALESCE(count(*) FILTER (WHERE decision = 'master_review'), 0)::int AS master_review_count
      FROM blog.autonomy_decisions
      WHERE created_at >= NOW() - ($1::text || ' days')::interval
        AND COALESCE(metadata->>'smoke_test', 'false') <> 'true'
        AND title NOT LIKE '[Smoke]%'
    `, [days]);

    const latest = await pgPool.get('blog', `
      SELECT decision, post_type, category, title, created_at
      FROM blog.autonomy_decisions
      WHERE COALESCE(metadata->>'smoke_test', 'false') <> 'true'
        AND title NOT LIKE '[Smoke]%'
      ORDER BY created_at DESC
      LIMIT 1
    `);

    const row = rows?.[0] || {};
    return {
      totalCount: Number(row.total_count || 0),
      autoPublishCount: Number(row.auto_publish_count || 0),
      masterReviewCount: Number(row.master_review_count || 0),
      latestDecision: latest || null,
    };
  } catch (error) {
    return {
      totalCount: 0,
      autoPublishCount: 0,
      masterReviewCount: 0,
      latestDecision: null,
      error: error.message,
    };
  }
}

async function getMarketingSnapshotTrend(days = 7) {
  try {
    const rows = await pgPool.query('agent', `
      SELECT
        count(*)::int AS total_count,
        COALESCE(count(*) FILTER (WHERE metadata->'health'->>'status' = 'ok'), 0)::int AS ok_count,
        COALESCE(count(*) FILTER (WHERE metadata->'health'->>'status' = 'watch'), 0)::int AS watch_count,
        COALESCE(avg(NULLIF(metadata->'senseSummary'->>'signalCount', '')::numeric), 0)::float AS avg_signal_count,
        COALESCE(avg(NULLIF(metadata->'revenueCorrelation'->>'revenueImpactPct', '')::numeric), 0)::float AS avg_revenue_impact_pct,
        max(created_at) AS latest_created_at
      FROM agent.event_lake
      WHERE event_type = 'blog_marketing_snapshot'
        AND team = 'blog'
        AND created_at >= NOW() - ($1::text || ' days')::interval
    `, [days]);

    const latest = await pgPool.get('agent', `
      SELECT
        created_at,
        metadata
      FROM agent.event_lake
      WHERE event_type = 'blog_marketing_snapshot'
        AND team = 'blog'
      ORDER BY created_at DESC
      LIMIT 1
    `);

    const row = rows?.[0] || {};
    const latestMeta = latest?.metadata || {};

    return {
      totalCount: Number(row.total_count || 0),
      okCount: Number(row.ok_count || 0),
      watchCount: Number(row.watch_count || 0),
      avgSignalCount: Number(row.avg_signal_count || 0),
      avgRevenueImpactPct: Number(row.avg_revenue_impact_pct || 0),
      latestCreatedAt: row.latest_created_at || latest?.created_at || null,
      latestStatus: latestMeta?.health?.status || null,
      latestWeakness: latestMeta?.diagnosis?.primaryWeakness?.code || null,
    };
  } catch (error) {
    return {
      totalCount: 0,
      okCount: 0,
      watchCount: 0,
      avgSignalCount: 0,
      avgRevenueImpactPct: 0,
      latestCreatedAt: null,
      latestStatus: null,
      latestWeakness: null,
      error: error.message,
    };
  }
}

async function getChannelPerformanceSummary(days = 7) {
  try {
    const latest = await pgPool.get('blog', `
      SELECT MAX(snapshot_date) AS snapshot_date
      FROM blog.channel_performance
      WHERE snapshot_date >= CURRENT_DATE - ($1::text || ' days')::interval
    `, [days]);

    const snapshotDate = latest?.snapshot_date || null;
    if (!snapshotDate) {
      return {
        latestDate: null,
        totalChannels: 0,
        activeChannels: 0,
        watchChannels: 0,
        rows: [],
      };
    }

    const rows = await pgPool.query('blog', `
      SELECT snapshot_date, channel, source, status, published_count, views, comments, likes, engagement_rate, revenue_signal, metadata
      FROM blog.channel_performance
      WHERE snapshot_date = $1
      ORDER BY channel ASC, source ASC
    `, [snapshotDate]);

    const normalized = (rows || []).map((row) => ({
      snapshotDate: row.snapshot_date,
      channel: row.channel,
      source: row.source,
      status: row.status,
      publishedCount: Number(row.published_count || 0),
      views: Number(row.views || 0),
      comments: Number(row.comments || 0),
      likes: Number(row.likes || 0),
      engagementRate: Number(row.engagement_rate || 0),
      revenueSignal: Number(row.revenue_signal || 0),
      metadata: row.metadata || {},
    }));

    const watchRows = normalized.filter((item) => item.status === 'watch');
    const primaryWatch = watchRows[0] || null;
    const primaryWatchHint = primaryWatch
      ? buildChannelWatchHint(primaryWatch)
      : null;

    return {
      latestDate: snapshotDate,
      totalChannels: normalized.length,
      activeChannels: normalized.filter((item) => item.status === 'ok').length,
      watchChannels: watchRows.length,
      primaryWatchChannel: primaryWatch?.channel || null,
      primaryWatchHint,
      rows: normalized,
    };
  } catch (error) {
    return {
      latestDate: null,
      totalChannels: 0,
      activeChannels: 0,
      watchChannels: 0,
      primaryWatchChannel: null,
      primaryWatchHint: null,
      rows: [],
      error: error.message,
    };
  }
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function extractStrategySummary(payload = {}) {
  const plan = payload?.plan || {};
  return {
    preferredCategory: plan.preferredCategory || null,
    suppressedCategory: plan.suppressedCategory || null,
    preferredTitlePattern: plan.preferredTitlePattern || null,
    suppressedTitlePattern: plan.suppressedTitlePattern || null,
    weakness: plan.weakness || null,
    categoryPatternHotspot: plan.categoryPatternHotspot || null,
    weekOf: plan.weekOf || null,
  };
}

function buildHotspotTrend(current = null, previous = null) {
  const currentHotspot = current?.categoryPatternHotspot || null;
  const previousHotspot = previous?.categoryPatternHotspot || null;

  if (!currentHotspot || !previousHotspot) {
    return {
      status: 'warming_up',
      currentRatio: Number(currentHotspot?.topRatio || 0),
      previousRatio: Number(previousHotspot?.topRatio || 0),
      delta: null,
      previousWeekOf: previous?.weekOf || null,
    };
  }

  const currentRatio = Number(currentHotspot.topRatio || 0);
  const previousRatio = Number(previousHotspot.topRatio || 0);
  const delta = Number((currentRatio - previousRatio).toFixed(4));
  const sameCategory = currentHotspot.category && previousHotspot.category
    && currentHotspot.category === previousHotspot.category;

  let status = 'stable';
  if (sameCategory && delta <= -0.05) status = 'improving';
  else if (sameCategory && delta >= 0.05) status = 'worsening';
  else if (!sameCategory) status = 'shifted';

  return {
    status,
    currentRatio,
    previousRatio,
    delta,
    previousWeekOf: previous?.weekOf || null,
    currentCategory: currentHotspot.category || null,
    previousCategory: previousHotspot.category || null,
  };
}

function getStrategySummary() {
  const latestPayload = readJsonSafe(LATEST_STRATEGY_PATH);
  const latest = extractStrategySummary(latestPayload);

  let previous = null;
  try {
    const candidates = fs.readdirSync(STRATEGY_DIR)
      .filter((name) => /^\d{4}-\d{2}-\d{2}_strategy\.json$/.test(name))
      .sort()
      .reverse();

    for (const name of candidates) {
      const payload = readJsonSafe(path.join(STRATEGY_DIR, name));
      const summary = extractStrategySummary(payload);
      if (!summary.weekOf || summary.weekOf === latest.weekOf) continue;
      previous = summary;
      break;
    }
  } catch {
    previous = null;
  }

  return {
    ...latest,
    hotspotTrend: buildHotspotTrend(latest, previous),
  };
}

function compactPreviewTitle(title = '', maxLength = 42) {
  const text = String(title || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'none';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function normalizeTitleWords(text = '') {
  return String(text || '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 2);
}

function calculateTitleOverlap(a = '', b = '') {
  const first = new Set(normalizeTitleWords(a));
  const second = new Set(normalizeTitleWords(b));
  if (!first.size || !second.size) return 0;
  let matched = 0;
  for (const token of first) {
    if (second.has(token)) matched += 1;
  }
  return Number((matched / Math.max(first.size, second.size)).toFixed(2));
}

async function buildNextGeneralPreview(strategy = {}, sense = null, revenueCorrelation = null) {
  try {
    const next = await getNextGeneralCategory(strategy);
    const category = next?.category || null;
    if (!category) {
      return {
        category: null,
        title: null,
        pattern: null,
        predictedAdoption: 'warming_up',
        compactTitle: 'none',
      };
    }

    const topic = selectAndValidateTopic(
      category,
      getRecentPosts(category, 10),
      strategy,
      sense,
      revenueCorrelation
    );

    const pattern = topic?.pattern || null;
    const categoryAligned = Boolean(strategy?.preferredCategory) && category === strategy.preferredCategory;
    const patternAligned = Boolean(strategy?.preferredTitlePattern) && pattern === strategy.preferredTitlePattern;
    const predictedAdoption = categoryAligned && patternAligned
      ? 'aligned'
      : (categoryAligned || patternAligned)
        ? 'partial'
        : 'off_track';

    return {
      category,
      title: topic?.title || null,
      pattern,
      predictedAdoption,
      compactTitle: compactPreviewTitle(topic?.title || ''),
    };
  } catch (error) {
    return {
      category: null,
      title: null,
      pattern: null,
      predictedAdoption: 'error',
      compactTitle: 'none',
      error: error.message,
    };
  }
}

function parseGeneralOutputFilename(filename = '') {
  const matched = filename.match(/^(\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2} .+?)_general_([^ ]+)\s+(.+)\.html$/);
  if (!matched) return null;
  const [, dateString, category, title] = matched;
  return {
    dateString: String(dateString || '').slice(0, 10),
    category: String(category || '').trim(),
    title: String(title || '').trim(),
    filename,
    pattern: detectTitlePattern(String(title || '').trim()),
  };
}

function getRecentGeneralStrategyAdoption(strategy = {}, nextPreview = null, maxPosts = 5) {
  try {
    const files = fs.readdirSync(BLOG_OUTPUT_DIR)
      .filter((name) => name.includes('_general_') && name.endsWith('.html'))
      .sort()
      .reverse();

    const recentPosts = files
      .map(parseGeneralOutputFilename)
      .filter(Boolean)
      .slice(0, maxPosts);

    const preferredCategory = strategy?.preferredCategory || null;
    const preferredPattern = strategy?.preferredTitlePattern || null;
    const previewCategory = nextPreview?.category || preferredCategory || null;
    const previewPattern = nextPreview?.pattern || preferredPattern || null;
    const previewTitle = nextPreview?.title || null;
    const preferredCategoryPosts = preferredCategory
      ? recentPosts.filter((post) => post.category === preferredCategory)
      : [];
    const patternMatches = preferredPattern
      ? recentPosts.filter((post) => post.pattern === preferredPattern)
      : [];
    const combinedMatches =
      preferredCategory && preferredPattern
        ? recentPosts.filter((post) => post.category === preferredCategory && post.pattern === preferredPattern)
        : [];
    const latestPost = recentPosts[0] || null;
    const latestAligned = Boolean(
      latestPost
      && (!preferredCategory || latestPost.category === preferredCategory)
      && (!preferredPattern || latestPost.pattern === preferredPattern)
    );
    const latestPreviewOverlap = latestPost && previewTitle
      ? calculateTitleOverlap(latestPost.title, previewTitle)
      : 0;
    const previewAligned = Boolean(
      latestPost
      && (!previewCategory || latestPost.category === previewCategory)
      && (!previewPattern || latestPost.pattern === previewPattern)
      && latestPreviewOverlap >= 0.4
    );

    let status = 'warming_up';
    if (recentPosts.length > 0) {
      status = latestAligned || previewAligned
        ? 'aligned'
        : combinedMatches.length > 0 || patternMatches.length > 0 || preferredCategoryPosts.length > 0
          ? 'partial'
          : 'off_track';
    }

    return {
      status,
      recentCount: recentPosts.length,
      preferredCategory,
      preferredPattern,
      previewCategory,
      previewPattern,
      previewTitle,
      preferredCategoryCount: preferredCategoryPosts.length,
      preferredPatternCount: patternMatches.length,
      preferredCategoryPatternCount: combinedMatches.length,
      latestAligned,
      latestPreviewAligned: previewAligned,
      latestPreviewOverlap,
      latestPost,
      sampledPosts: recentPosts.slice(0, 3),
    };
  } catch (error) {
    return {
      status: 'error',
      recentCount: 0,
      preferredCategory: strategy?.preferredCategory || null,
      preferredPattern: strategy?.preferredTitlePattern || null,
      previewCategory: nextPreview?.category || null,
      previewPattern: nextPreview?.pattern || null,
      previewTitle: nextPreview?.title || null,
      preferredCategoryCount: 0,
      preferredPatternCount: 0,
      preferredCategoryPatternCount: 0,
      latestAligned: false,
      latestPreviewAligned: false,
      latestPreviewOverlap: 0,
      latestPost: null,
      sampledPosts: [],
      error: error.message,
    };
  }
}

function buildChannelWatchHint(item = {}) {
  const metadata = item.metadata || {};
  if (item.channel === 'instagram') {
    const failed = Number(metadata.failedCount || 0);
    const events = Number(metadata.eventCount || 0);
    const authFailed = Number(metadata.authFailedCount || 0);
    const uploadFailed = Number(metadata.uploadFailedCount || 0);
    const publishFailed = Number(metadata.publishFailedCount || 0);
    if (failed > 0) {
      if (authFailed > 0) return `instagram auth watch: 최근 ${events}건 중 인증 실패 ${authFailed}건`;
      if (uploadFailed > 0) return `instagram upload watch: 최근 ${events}건 중 업로드 실패 ${uploadFailed}건`;
      if (publishFailed > 0) return `instagram publish watch: 최근 ${events}건 중 게시 실패 ${publishFailed}건`;
      return `instagram watch: 최근 ${events}건 중 실패 ${failed}건`;
    }
    return 'instagram watch: 실행 안정화 점검 필요';
  }

  if (item.channel === 'naver_blog' && Number(item.publishedCount || 0) === 0) {
    return 'naver_blog warming-up: 최근 게시 성과 데이터가 아직 없습니다';
  }

  return `${item.channel} ${item.status}`;
}

function summarizeSense(sense = {}) {
  const signals = Array.isArray(sense.signals) ? sense.signals : [];
  const topSignal = signals[0] || null;
  const skaRevenue = sense.skaRevenue || null;
  const skaEnvironment = sense.skaEnvironment || null;

  return {
    signalCount: signals.length,
    topSignal,
    revenueTrend: skaRevenue?.trend || 'unknown',
    revenueRatio: Number(skaRevenue?.ratio || 0),
    anomaly: Boolean(skaRevenue?.anomaly),
    holiday: Boolean(skaEnvironment?.holiday_flag),
    examScore: Number(skaEnvironment?.exam_score || 0),
  };
}

function buildRecommendations({ senseSummary, revenueCorrelation, diagnosis, autonomySummary, channelPerformance }) {
  const recommendations = [];

  if (senseSummary.anomaly) {
    recommendations.push('매출 이상 신호가 있어 오늘은 예약/전환형 콘텐츠 비중을 높이는 편이 좋습니다.');
  }

  if ((revenueCorrelation?.revenueImpactPct || 0) > 0.05) {
    recommendations.push('마케팅 집행일 매출 우세가 보여, 발행 후 채널 확산을 더 적극적으로 이어가면 좋습니다.');
  } else if ((revenueCorrelation?.revenueImpactPct || 0) < -0.05) {
    recommendations.push('최근 마케팅 집행일 매출 우세가 약해, 제목과 CTA를 다시 점검하는 편이 좋습니다.');
  }

  if (diagnosis?.primaryWeakness?.code && diagnosis.primaryWeakness.code !== 'stable') {
    recommendations.push(`콘텐츠 측면에선 "${diagnosis.primaryWeakness.message}" 보정이 우선입니다.`);
  }

  if (autonomySummary.totalCount > 0 && autonomySummary.autoPublishCount === 0) {
    recommendations.push('자율 판단은 아직 master_review 중심이어서, 자동 게시 확대 전 품질 기준을 더 다듬는 편이 안전합니다.');
  }

  const instagram = Array.isArray(channelPerformance?.rows)
    ? channelPerformance.rows.find((item) => item.channel === 'instagram')
    : null;
  if (instagram?.status === 'watch') {
    recommendations.push(`${buildChannelWatchHint(instagram)} — 릴스/캡션 발행보다 실행 안정화와 재시도율 점검을 먼저 보는 편이 좋습니다.`);
  }

  const naverBlog = Array.isArray(channelPerformance?.rows)
    ? channelPerformance.rows.find((item) => item.channel === 'naver_blog')
    : null;
  if (naverBlog && Number(naverBlog.publishedCount || 0) === 0) {
    recommendations.push('네이버 블로그 채널 성과가 아직 warming-up 상태라 게시 후 조회/공감 수집 루프를 더 쌓는 편이 좋습니다.');
  }

  if (!recommendations.length) {
    recommendations.push('현재 신호는 안정적입니다. 예약 전환형과 신뢰 축적형 포스팅을 균형 있게 유지하면 좋습니다.');
  }

  return recommendations;
}

function buildHealth({ senseSummary, revenueCorrelation, diagnosis, autonomySummary, channelPerformance }) {
  if (senseSummary.signalCount === 0 && diagnosis?.postCount === 0 && autonomySummary.totalCount === 0) {
    return {
      status: 'warming_up',
      reason: '마케팅 신호와 자율 판단 로그가 아직 충분히 축적되지 않았습니다.',
    };
  }

  if (senseSummary.anomaly || (revenueCorrelation?.revenueImpactPct || 0) < -0.1) {
    return {
      status: 'watch',
      reason: '매출/마케팅 신호 변동이 커서 오늘은 실험보다 안정 운영 쪽이 좋습니다.',
    };
  }

  if (Number(channelPerformance?.watchChannels || 0) > 0) {
    return {
      status: 'watch',
      reason: '채널 실행 신호에 watch 상태가 있어 발행 품질보다 채널 안정화 점검이 먼저입니다.',
    };
  }

  return {
    status: 'ok',
    reason: '현재 마케팅 신호는 안정 구간입니다.',
  };
}

async function buildMarketingDigest(options = {}) {
  const revenueWindow = Number(options.revenueWindow || 14);
  const diagnosisWindow = Number(options.diagnosisWindow || 7);
  const autonomyWindow = Number(options.autonomyWindow || 14);

  const [sense, revenueCorrelation, diagnosis, autonomySummary, snapshotTrend, channelPerformance] = await Promise.all([
    senseDailyState().catch((error) => ({ error: error.message, signals: [] })),
    analyzeMarketingToRevenue(revenueWindow).catch((error) => ({ error: error.message })),
    diagnoseWeeklyPerformance(diagnosisWindow).catch((error) => ({ error: error.message })),
    getAutonomySummary(autonomyWindow),
    getMarketingSnapshotTrend(Number(options.snapshotWindow || 7)),
    getChannelPerformanceSummary(Number(options.channelWindow || 7)),
  ]);

  const senseSummary = summarizeSense(sense);
  const health = buildHealth({ senseSummary, revenueCorrelation, diagnosis, autonomySummary, channelPerformance });
  const recommendations = buildRecommendations({ senseSummary, revenueCorrelation, diagnosis, autonomySummary, channelPerformance });
  const strategy = getStrategySummary();
  const nextGeneralPreview = await buildNextGeneralPreview(strategy, sense, revenueCorrelation);
  const strategyAdoption = getRecentGeneralStrategyAdoption(strategy, nextGeneralPreview, Number(options.adoptionWindow || 5));

  return {
    generatedAt: new Date().toISOString(),
    health,
    senseSummary,
    revenueCorrelation: revenueCorrelation || null,
    diagnosis: diagnosis || null,
    autonomySummary,
    snapshotTrend,
    channelPerformance,
    strategy,
    strategyAdoption,
    nextGeneralPreview,
    recommendations,
  };
}

module.exports = {
  buildMarketingDigest,
  getAutonomySummary,
  getMarketingSnapshotTrend,
  getChannelPerformanceSummary,
};
