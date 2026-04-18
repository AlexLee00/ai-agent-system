'use strict';

/**
 * bots/blog/lib/time-slot-optimizer.ts
 * 플랫폼별 최적 발행 시간 학습
 *
 * Phase 4: 과거 데이터 기반 engagement 피크 시간대 분석
 */

const pgPool = require('../../../packages/core/lib/pg-pool');

// 플랫폼 기본 최적 시간 (데이터 없을 때 폴백)
const DEFAULT_OPTIMAL_HOURS = {
  naver: [6, 11, 18],
  instagram: [9, 12, 20],
  facebook: [10, 13, 19],
};

/**
 * 플랫폼별 시간대별 engagement 분석
 * @param {string} platform 'naver' | 'instagram' | 'facebook'
 * @param {number} days 분석 기간
 */
async function analyzeHourlyEngagement(platform, days = 30) {
  try {
    const rows = await pgPool.query('blog', `
      SELECT
        EXTRACT(HOUR FROM COALESCE(p.published_at, p.created_at)) AS hour,
        AVG(p.views) AS avg_views,
        AVG(p.likes + p.comments) AS avg_engagement,
        COUNT(*) AS post_count
      FROM blog.posts p
      WHERE p.status = 'published'
        AND COALESCE(p.published_at, p.created_at) > NOW() - ($1::text || ' days')::interval
        AND p.views > 0
      GROUP BY EXTRACT(HOUR FROM COALESCE(p.published_at, p.created_at))
      HAVING COUNT(*) >= 2
      ORDER BY avg_engagement DESC
    `, [days]);

    return (rows || []).map((r) => ({
      hour: Number(r.hour),
      avg_views: Number(Number(r.avg_views || 0).toFixed(1)),
      avg_engagement: Number(Number(r.avg_engagement || 0).toFixed(2)),
      post_count: Number(r.post_count || 0),
    }));
  } catch {
    return [];
  }
}

/**
 * 요일별 engagement 분석
 * @param {string} platform
 * @param {number} days
 */
async function analyzeWeekdayEngagement(platform, days = 30) {
  try {
    const rows = await pgPool.query('blog', `
      SELECT
        EXTRACT(DOW FROM COALESCE(p.published_at, p.created_at)) AS weekday,
        AVG(p.views) AS avg_views,
        AVG(p.likes + p.comments) AS avg_engagement,
        COUNT(*) AS post_count
      FROM blog.posts p
      WHERE p.status = 'published'
        AND COALESCE(p.published_at, p.created_at) > NOW() - ($1::text || ' days')::interval
        AND p.views > 0
      GROUP BY EXTRACT(DOW FROM COALESCE(p.published_at, p.created_at))
      HAVING COUNT(*) >= 1
      ORDER BY avg_engagement DESC
    `, [days]);

    const WEEKDAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
    return (rows || []).map((r) => ({
      weekday: Number(r.weekday),
      weekday_name: WEEKDAY_NAMES[Number(r.weekday)] || '?',
      avg_views: Number(Number(r.avg_views || 0).toFixed(1)),
      avg_engagement: Number(Number(r.avg_engagement || 0).toFixed(2)),
      post_count: Number(r.post_count || 0),
    }));
  } catch {
    return [];
  }
}

/**
 * 플랫폼별 최적 발행 시간 추천
 * @param {string} platform
 * @returns {{ recommended_hours, recommended_weekdays, confidence }}
 */
async function optimizePublishTime(platform = 'naver') {
  const hourlyData = await analyzeHourlyEngagement(platform, 30);
  const weekdayData = await analyzeWeekdayEngagement(platform, 30);

  const topHours = hourlyData.slice(0, 3).map((h) => h.hour);
  const topWeekdays = weekdayData.slice(0, 3).map((w) => w.weekday_name);

  // 데이터 부족 시 기본값 사용
  const recommendedHours = topHours.length >= 2
    ? topHours
    : (DEFAULT_OPTIMAL_HOURS[platform] || [9, 18]);

  const confidence = Math.min(hourlyData.reduce((sum, h) => sum + h.post_count, 0) / 30, 1.0);

  return {
    platform,
    recommended_hours: recommendedHours,
    recommended_weekdays: topWeekdays.length > 0 ? topWeekdays : ['화', '목', '토'],
    confidence: Number(confidence.toFixed(2)),
    data_points: hourlyData.length,
    note: confidence < 0.3 ? '데이터 부족 — 기본값 사용' : '학습 데이터 기반',
  };
}

/**
 * 전체 플랫폼 최적 시간 요약
 */
async function getAllPlatformOptimalTimes() {
  const [naver, instagram, facebook] = await Promise.all([
    optimizePublishTime('naver'),
    optimizePublishTime('instagram'),
    optimizePublishTime('facebook'),
  ]);
  return { naver, instagram, facebook };
}

module.exports = {
  analyzeHourlyEngagement,
  analyzeWeekdayEngagement,
  optimizePublishTime,
  getAllPlatformOptimalTimes,
  DEFAULT_OPTIMAL_HOURS,
};
