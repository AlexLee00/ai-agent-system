// @ts-nocheck
'use strict';

/**
 * bots/blog/lib/marketing-revenue-correlation.ts
 * 마케팅 활동 → 스카팀 매출 상관분석
 */

const pgPool = require('../../../packages/core/lib/pg-pool');

async function getTableColumns(dbName, schemaName, tableName) {
  try {
    const rows = await pgPool.query(dbName, `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = $2
    `, [schemaName, tableName]);
    return new Set((rows || []).map((row) => row.column_name));
  } catch {
    return new Set();
  }
}

async function analyzeMarketingToRevenue(window = 14) {
  try {
    const [blogColumns, skaColumns] = await Promise.all([
      getTableColumns('blog', 'blog', 'posts'),
      getTableColumns('ska', 'public', 'revenue_daily'),
    ]);
    const publishedExpr = blogColumns.has('published_at')
      ? 'published_at'
      : blogColumns.has('publish_date')
        ? 'publish_date'
        : 'created_at';
    const entryExpr = skaColumns.has('entries_count')
      ? 'entries_count'
      : skaColumns.has('entry_count')
        ? 'entry_count'
        : skaColumns.has('total_reservations')
          ? 'total_reservations'
          : '0';

    // 1. 블로그 게시일 vs 매출 변화
    const correlation = await pgPool.query('blog', `
      WITH blog_days AS (
        SELECT DISTINCT DATE(${publishedExpr}) as pub_date
        FROM blog.posts
        WHERE ${publishedExpr} >= CURRENT_DATE - ($1::text || ' days')::interval AND status = 'published'
      ),
      revenue AS (
        SELECT date, actual_revenue, occupancy_rate, ${entryExpr} AS entries_count
        FROM ska.revenue_daily
        WHERE date >= CURRENT_DATE - ($1::text || ' days')::interval
      )
      SELECT
        CASE WHEN bd.pub_date IS NOT NULL THEN true ELSE false END as has_marketing,
        AVG(r.actual_revenue) as avg_revenue,
        AVG(r.occupancy_rate) as avg_occupancy,
        AVG(r.entries_count) as avg_entries,
        COUNT(*) as day_count
      FROM revenue r
      LEFT JOIN blog_days bd ON r.date = bd.pub_date
      GROUP BY CASE WHEN bd.pub_date IS NOT NULL THEN true ELSE false END
    `, [window]);

    const active = correlation.find(r => r.has_marketing === true) || {};
    const inactive = correlation.find(r => r.has_marketing === false) || {};

    const revenueImpact = (Number(active.avg_revenue || 0) - Number(inactive.avg_revenue || 0));
    const revenueImpactPct = Number(inactive.avg_revenue || 0) > 0
      ? revenueImpact / Number(inactive.avg_revenue) : 0;

    // 2. 고조회수 포스트 다음날 매출 변화
    const highViewImpact = blogColumns.has('views')
      ? await pgPool.query('blog', `
          WITH high_view_days AS (
            SELECT DATE(${publishedExpr}) as pub_date, views
            FROM blog.posts
            WHERE ${publishedExpr} >= CURRENT_DATE - ($1::text || ' days')::interval AND status = 'published'
            ORDER BY views DESC
            LIMIT 5
          )
          SELECT
            AVG(r.actual_revenue) as avg_revenue_after_high_views
          FROM high_view_days hvd
          JOIN ska.revenue_daily r ON r.date = hvd.pub_date + 1
        `, [window])
      : [];

    return {
      period: window,
      activeDay: {
        avgRevenue: Number(active.avg_revenue || 0),
        avgOccupancy: Number(active.avg_occupancy || 0),
        avgEntries: Number(active.avg_entries || 0),
        dayCount: Number(active.day_count || 0),
      },
      inactiveDay: {
        avgRevenue: Number(inactive.avg_revenue || 0),
        avgOccupancy: Number(inactive.avg_occupancy || 0),
        avgEntries: Number(inactive.avg_entries || 0),
        dayCount: Number(inactive.day_count || 0),
      },
      revenueImpact,
      revenueImpactPct,
      highViewRevenueAfter: Number(highViewImpact?.[0]?.avg_revenue_after_high_views || 0),
    };
  } catch (err) {
    console.warn('[revenue-correlation] 상관분석 실패:', err.message);
    return null;
  }
}

module.exports = { analyzeMarketingToRevenue };
