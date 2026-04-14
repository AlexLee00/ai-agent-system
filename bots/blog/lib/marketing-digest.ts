// @ts-nocheck
'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool');
const { senseDailyState } = require('./sense-engine.ts');
const { analyzeMarketingToRevenue } = require('./marketing-revenue-correlation.ts');
const { diagnoseWeeklyPerformance } = require('./performance-diagnostician.ts');

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

    return {
      latestDate: snapshotDate,
      totalChannels: normalized.length,
      activeChannels: normalized.filter((item) => item.status === 'ok').length,
      watchChannels: normalized.filter((item) => item.status === 'watch').length,
      rows: normalized,
    };
  } catch (error) {
    return {
      latestDate: null,
      totalChannels: 0,
      activeChannels: 0,
      watchChannels: 0,
      rows: [],
      error: error.message,
    };
  }
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
    recommendations.push('인스타 실행 결과에 실패가 남아 있어 릴스/캡션 발행보다 실행 안정화와 재시도율 점검을 먼저 보는 편이 좋습니다.');
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

  return {
    generatedAt: new Date().toISOString(),
    health,
    senseSummary,
    revenueCorrelation: revenueCorrelation || null,
    diagnosis: diagnosis || null,
    autonomySummary,
    snapshotTrend,
    channelPerformance,
    recommendations,
  };
}

module.exports = {
  buildMarketingDigest,
  getAutonomySummary,
  getMarketingSnapshotTrend,
  getChannelPerformanceSummary,
};
