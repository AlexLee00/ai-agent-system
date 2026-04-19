'use strict';

/**
 * bots/blog/lib/aarrr-metrics.ts
 * AARRR 해적 지표 (Growth Hacking 바이블)
 *
 * Phase 3: Acquisition → Activation → Retention → Referral → Revenue
 * Kill Switch: BLOG_REVENUE_CORRELATION_ENABLED=true (Revenue 지표)
 */

const pgPool = require('../../../packages/core/lib/pg-pool');

function isRevenueEnabled() {
  return process.env.BLOG_REVENUE_CORRELATION_ENABLED === 'true';
}

/**
 * Acquisition: 신규 유입 지표
 */
async function getAcquisitionMetrics(days = 30) {
  try {
    // 블로그 신규 이웃 + 채널별 클릭 합산
    const rows = await pgPool.query('blog', `
      SELECT
        COALESCE(SUM(cp.clicks), 0) AS total_clicks,
        COALESCE(SUM(cp.reach), 0) AS total_reach,
        cp.channel AS top_channel
      FROM blog.channel_performance cp
      WHERE cp.published_at > NOW() - ($1::text || ' days')::interval
      GROUP BY cp.channel
      ORDER BY total_clicks DESC
      LIMIT 1
    `, [days]);

    const row = rows?.[0] || {};
    const total_reach = Number(row.total_reach || 0);
    return {
      total_clicks: Number(row.total_clicks || 0),
      total_reach,
      total_new_visitors: total_reach, // 별칭 (테스트 + 리포트 호환)
      top_channel: row.top_channel || 'naver',
    };
  } catch {
    return { total_clicks: 0, total_reach: 0, total_new_visitors: 0, top_channel: 'naver' };
  }
}

/**
 * Activation: 예약/방문으로 이어진 비율 (스카팀 데이터 기반)
 */
async function getActivationMetrics(days = 30) {
  if (!isRevenueEnabled()) {
    return { activation_rate: null, note: 'BLOG_REVENUE_CORRELATION_ENABLED 비활성' };
  }
  try {
    const rows = await pgPool.query('blog', `
      SELECT
        COUNT(DISTINCT a.post_id) AS posts_with_attribution,
        SUM(a.utm_visits) AS total_utm_visits,
        SUM(a.direct_conversion_count) AS total_conversions
      FROM blog.post_revenue_attribution a
      WHERE a.post_published_at > NOW() - ($1::text || ' days')::interval
    `, [days]);
    const row = rows?.[0] || {};
    const visits = Number(row.total_utm_visits || 0);
    const conversions = Number(row.total_conversions || 0);
    return {
      utm_visits: visits,
      conversions,
      activation_rate: visits > 0 ? Number((conversions / visits).toFixed(4)) : 0,
    };
  } catch {
    return { utm_visits: 0, conversions: 0, activation_rate: 0 };
  }
}

/**
 * Retention: 이웃 유지율 (간이 — 이웃 추가/제거 기반)
 */
async function getRetentionMetrics(days = 30) {
  try {
    // blog.posts 기준 재방문 = 같은 독자가 여러 글 읽음 (댓글 기반 근사)
    const rows = await pgPool.query('blog', `
      SELECT
        COUNT(*) AS total_posts,
        AVG(views) AS avg_views,
        AVG(likes) AS avg_likes
      FROM blog.posts
      WHERE status = 'published'
        AND COALESCE(published_at, created_at) > NOW() - ($1::text || ' days')::interval
        AND views > 0
    `, [days]);
    const row = rows?.[0] || {};
    return {
      total_posts: Number(row.total_posts || 0),
      avg_views: Number(Number(row.avg_views || 0).toFixed(1)),
      avg_likes: Number(Number(row.avg_likes || 0).toFixed(1)),
      note: '이웃 제거율 데이터 미수집 — 향후 네이버 API 연동 필요',
    };
  } catch {
    return { total_posts: 0, avg_views: 0, avg_likes: 0 };
  }
}

/**
 * Referral: 공유/추천 지표
 */
async function getReferralMetrics(days = 30) {
  try {
    const rows = await pgPool.query('blog', `
      SELECT
        COALESCE(SUM(shares), 0) AS total_shares,
        COALESCE(SUM(saves), 0) AS total_saves
      FROM blog.channel_performance
      WHERE published_at > NOW() - ($1::text || ' days')::interval
    `, [days]);
    const row = rows?.[0] || {};
    return {
      total_shares: Number(row.total_shares || 0),
      total_saves: Number(row.total_saves || 0),
    };
  } catch {
    return { total_shares: 0, total_saves: 0 };
  }
}

/**
 * Revenue: 매출 기여 지표 (스카팀 연동)
 */
async function getRevenueMetrics(days = 30) {
  if (!isRevenueEnabled()) {
    return { enabled: false };
  }
  try {
    const rows = await pgPool.query('blog', `
      SELECT
        SUM(uplift_krw) AS total_uplift_krw,
        AVG(uplift_krw) AS avg_uplift_krw,
        COUNT(*) AS attribution_count
      FROM blog.post_revenue_attribution
      WHERE post_published_at > NOW() - ($1::text || ' days')::interval
    `, [days]);
    const row = rows?.[0] || {};
    return {
      enabled: true,
      total_uplift_krw: Math.round(Number(row.total_uplift_krw || 0)),
      avg_uplift_krw: Math.round(Number(row.avg_uplift_krw || 0)),
      attribution_count: Number(row.attribution_count || 0),
    };
  } catch {
    return { enabled: false };
  }
}

/**
 * 전체 AARRR 지표 통합 계산
 */
async function calculateAARRR(period = 30) {
  const [acquisition, activation, retention, referral, revenue] = await Promise.all([
    getAcquisitionMetrics(period),
    getActivationMetrics(period),
    getRetentionMetrics(period),
    getReferralMetrics(period),
    getRevenueMetrics(period),
  ]);

  const result = {
    period_days: period,
    computed_at: new Date().toISOString(),
    acquisition,
    activation,
    retention,
    referral,
    revenue,
  };

  // DB 저장 (오늘 날짜 기준)
  try {
    const today = new Date().toISOString().slice(0, 10);
    await pgPool.query('blog', `
      INSERT INTO blog.aarrr_daily
        (date, platform, new_visitors, top_channel,
         activation_count, activation_rate,
         referral_count,
         total_revenue_krw,
         computed_at)
      VALUES ($1, 'all', $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (date, platform) DO UPDATE SET
        new_visitors = EXCLUDED.new_visitors,
        top_channel = EXCLUDED.top_channel,
        activation_count = EXCLUDED.activation_count,
        activation_rate = EXCLUDED.activation_rate,
        referral_count = EXCLUDED.referral_count,
        total_revenue_krw = EXCLUDED.total_revenue_krw,
        computed_at = NOW()
    `, [
      today,
      acquisition.total_reach,
      acquisition.top_channel,
      activation.conversions || 0,
      activation.activation_rate || 0,
      referral.total_shares,
      revenue.total_uplift_krw || null,
    ]);
  } catch {
    // DB 저장 실패는 무시
  }

  return result;
}

module.exports = {
  calculateAARRR,
  getAcquisitionMetrics,
  getActivationMetrics,
  getRetentionMetrics,
  getReferralMetrics,
  getRevenueMetrics,
};
