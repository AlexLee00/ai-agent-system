'use strict';

/**
 * bots/blog/lib/ska-revenue-bridge.ts
 * 스카팀 매출 데이터를 블로팀 분석에 주입하는 브릿지 모듈
 *
 * Phase 2: 블로 활동 → 스카 매출 상관분석 파이프라인
 * Kill Switch: BLOG_REVENUE_CORRELATION_ENABLED=true 일 때만 활성
 */

const pgPool = require('../../../packages/core/lib/pg-pool');

function isEnabled() {
  return process.env.BLOG_REVENUE_CORRELATION_ENABLED === 'true';
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function subtractDays(dateStr, days) {
  return addDays(dateStr, -days);
}

/**
 * 기간별 스카팀 매출 조회 (ska.revenue_daily 스키마)
 */
async function fetchSkaRevenueByPeriod(startDate, endDate) {
  try {
    const rows = await pgPool.query('blog', `
      SELECT
        date::text AS date,
        COALESCE(actual_revenue, 0) AS total_revenue_krw,
        COALESCE(reservation_count, 0) AS reservation_count,
        COALESCE(occupancy_rate, 0) AS occupancy_rate,
        COALESCE(entries_count, total_reservations, 0) AS entries_count
      FROM ska.revenue_daily
      WHERE date BETWEEN $1 AND $2
      ORDER BY date DESC
    `, [startDate, endDate]);
    return (rows || []).map((r) => ({
      date: r.date,
      total_revenue_krw: Number(r.total_revenue_krw || 0),
      reservation_count: Number(r.reservation_count || 0),
      occupancy_rate: Number(r.occupancy_rate || 0),
      entries_count: Number(r.entries_count || 0),
    }));
  } catch (err) {
    console.warn('[ska-revenue-bridge] revenue_daily 조회 실패:', err.message);
    return [];
  }
}

/**
 * 특정 날짜 이전 N일 평균 매출 (베이스라인)
 */
async function getBaselineRevenue(referenceDate, lookbackDays = 7) {
  try {
    const start = subtractDays(referenceDate, lookbackDays);
    const rows = await pgPool.query('blog', `
      SELECT AVG(COALESCE(actual_revenue, 0)) AS avg_rev
      FROM ska.revenue_daily
      WHERE date >= $1 AND date < $2
    `, [start, referenceDate]);
    return Number(rows?.[0]?.avg_rev || 0);
  } catch {
    return 0;
  }
}

/**
 * 포스팅 발행 → 매출 증가 상관관계 계산
 */
async function correlateBlogPostsToRevenue(postDate, lookAheadDays = 7) {
  if (!isEnabled()) return null;
  try {
    const postEndDate = addDays(postDate, lookAheadDays);
    const [signals, baseline] = await Promise.all([
      fetchSkaRevenueByPeriod(postDate, postEndDate),
      getBaselineRevenue(postDate, 7),
    ]);

    if (signals.length === 0) return null;

    const postPeriodRevenue = signals.reduce((sum, s) => sum + s.total_revenue_krw, 0)
      / Math.max(signals.length, 1);
    const uplift = postPeriodRevenue - baseline;
    const confidence = baseline > 0
      ? Math.min(Math.abs(uplift / baseline), 1.0)
      : 0.0;

    return {
      post_date: postDate,
      baseline_revenue_krw: Math.round(baseline),
      post_period_revenue_krw: Math.round(postPeriodRevenue),
      uplift_krw: Math.round(uplift),
      attribution_confidence: Number(confidence.toFixed(2)),
    };
  } catch (err) {
    console.warn('[ska-revenue-bridge] 상관분석 실패:', err.message);
    return null;
  }
}

/**
 * 최근 N일 카테고리별 매출 기여도 상위 카테고리 조회
 * topic-selector Revenue-Driven 강화에 사용
 */
async function getTopRevenueCategories(days = 30) {
  if (!isEnabled()) return [];
  try {
    const rows = await pgPool.query('blog', `
      SELECT category, avg_uplift_krw, post_count
      FROM blog.category_revenue_performance
      WHERE period_days = $1 AND computed_at > NOW() - INTERVAL '2 days'
      ORDER BY avg_uplift_krw DESC
      LIMIT 5
    `, [days]);
    return (rows || []).map((r) => ({
      category: r.category,
      avg_uplift_krw: Number(r.avg_uplift_krw || 0),
      post_count: Number(r.post_count || 0),
    }));
  } catch {
    return [];
  }
}

/**
 * 카테고리별 매출 기여도를 blog.category_revenue_performance에 업데이트
 */
async function updateCategoryRevenuePerformance(days = 30) {
  if (!isEnabled()) return;
  try {
    await pgPool.query('blog', `
      INSERT INTO blog.category_revenue_performance
        (category, period_days, avg_uplift_krw, post_count, avg_confidence, computed_at)
      SELECT
        p.category,
        $1 AS period_days,
        AVG(a.uplift_krw) AS avg_uplift_krw,
        COUNT(*) AS post_count,
        AVG(a.attribution_confidence) AS avg_confidence,
        NOW()
      FROM blog.post_revenue_attribution a
      JOIN blog.posts p ON p.id::text = a.post_id
      WHERE a.post_published_at > NOW() - ($1::text || ' days')::interval
        AND p.category IS NOT NULL
      GROUP BY p.category
      ON CONFLICT (category, period_days)
      DO UPDATE SET
        avg_uplift_krw = EXCLUDED.avg_uplift_krw,
        post_count = EXCLUDED.post_count,
        avg_confidence = EXCLUDED.avg_confidence,
        computed_at = NOW()
    `, [days]);
    console.log('[ska-revenue-bridge] 카테고리별 매출 성과 업데이트 완료');
  } catch (err) {
    console.warn('[ska-revenue-bridge] 카테고리 성과 업데이트 실패:', err.message);
  }
}

/**
 * 미계산 포스팅 attribution 일괄 계산 + DB 저장
 */
async function computePendingAttributions(lookAheadDays = 7) {
  if (!isEnabled()) return 0;
  let processed = 0;
  try {
    const posts = await pgPool.query('blog', `
      SELECT
        p.id::text AS post_id,
        p.title,
        p.url,
        p.category,
        COALESCE(p.published_at, p.publish_date, p.created_at)::date::text AS pub_date,
        COALESCE(p.published_at, p.publish_date, p.created_at) AS published_at
      FROM blog.posts p
      LEFT JOIN blog.post_revenue_attribution a ON a.post_id = p.id::text AND a.post_platform = 'naver'
      WHERE p.status = 'published'
        AND COALESCE(p.published_at, p.publish_date, p.created_at) < NOW() - ($1::text || ' days')::interval
        AND COALESCE(p.published_at, p.publish_date, p.created_at) > NOW() - '60 days'::interval
        AND a.id IS NULL
      ORDER BY published_at DESC
      LIMIT 30
    `, [lookAheadDays + 1]);

    for (const post of (posts || [])) {
      const uplift = await correlateBlogPostsToRevenue(post.pub_date, lookAheadDays);
      if (!uplift) continue;
      try {
        await pgPool.query('blog', `
          INSERT INTO blog.post_revenue_attribution
            (post_id, post_url, post_title, post_platform,
             post_published_at, baseline_revenue_krw, post_period_revenue_krw,
             uplift_krw, attribution_confidence, attribution_method, computed_at)
          VALUES ($1, $2, $3, 'naver', $4, $5, $6, $7, $8, 'temporal', NOW())
          ON CONFLICT DO NOTHING
        `, [
          post.post_id, post.url, post.title, post.published_at,
          uplift.baseline_revenue_krw, uplift.post_period_revenue_krw,
          uplift.uplift_krw, uplift.attribution_confidence,
        ]);
        processed++;
      } catch {
        // 개별 실패는 무시
      }
    }
    console.log(`[ska-revenue-bridge] attribution 계산 완료: ${processed}건`);
  } catch (err) {
    console.warn('[ska-revenue-bridge] 일괄 attribution 실패:', err.message);
  }
  return processed;
}

/**
 * ROI 요약 (대시보드용)
 */
async function getRoiSummary(days = 30) {
  if (!isEnabled()) {
    return { enabled: false };
  }
  try {
    const [rows, byCategoryRows] = await Promise.all([
      pgPool.query('blog', `
        SELECT
          post_platform,
          COUNT(*) AS posts_count,
          SUM(uplift_krw) AS total_uplift_krw,
          AVG(uplift_krw) AS avg_uplift_krw,
          AVG(attribution_confidence) AS avg_confidence,
          SUM(utm_visits) AS total_utm_visits,
          SUM(direct_conversion_count) AS total_conversions
        FROM blog.post_revenue_attribution
        WHERE post_published_at > NOW() - ($1::text || ' days')::interval
        GROUP BY post_platform
      `, [days]),
      pgPool.query('blog', `
        SELECT category, avg_uplift_krw, post_count
        FROM blog.category_revenue_performance
        WHERE period_days = $1 AND computed_at > NOW() - INTERVAL '7 days'
        ORDER BY avg_uplift_krw DESC
      `, [days]),
    ]);

    return {
      enabled: true,
      period_days: days,
      by_platform: (rows || []).map((r) => ({
        platform: r.post_platform,
        posts_count: Number(r.posts_count),
        total_uplift_krw: Math.round(Number(r.total_uplift_krw || 0)),
        avg_uplift_krw: Math.round(Number(r.avg_uplift_krw || 0)),
        avg_confidence: Number(Number(r.avg_confidence || 0).toFixed(2)),
        utm_visits: Number(r.total_utm_visits || 0),
        conversions: Number(r.total_conversions || 0),
      })),
      by_category: (byCategoryRows || []).map((r) => ({
        category: r.category,
        avg_uplift_krw: Math.round(Number(r.avg_uplift_krw || 0)),
        post_count: Number(r.post_count || 0),
      })),
    };
  } catch (err) {
    console.warn('[ska-revenue-bridge] ROI 요약 실패:', err.message);
    return { enabled: false, error: err.message };
  }
}

module.exports = {
  isEnabled,
  fetchSkaRevenueByPeriod,
  getBaselineRevenue,
  correlateBlogPostsToRevenue,
  getTopRevenueCategories,
  updateCategoryRevenuePerformance,
  computePendingAttributions,
  getRoiSummary,
};
