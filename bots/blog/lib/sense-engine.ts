'use strict';

/**
 * bots/blog/lib/sense-engine.ts — SENSE 모듈
 *
 * 피드백 루프 1단계: 리소스 상태 감지
 * - 트렌드 키워드 크롤링
 * - 스카팀 매출 변동 감지
 * - 채널 건강 상태 확인
 * - 최근 콘텐츠 성과 요약
 */

const pgPool = require('../../../packages/core/lib/pg-pool');
const { loadLatestStrategy } = require('./strategy-loader.ts');

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

/**
 * 스카팀 매출 데이터 조회 (최근 N일)
 */
async function getSkaRevenue(days = 7) {
  try {
    const columns = await getTableColumns('ska', 'public', 'revenue_daily');
    const entryExpr = columns.has('entries_count')
      ? 'entries_count'
      : columns.has('entry_count')
        ? 'entry_count'
        : columns.has('total_reservations')
          ? 'total_reservations'
          : '0';

    const rows = await pgPool.query('ska', `
      SELECT date, actual_revenue, occupancy_rate,
             total_reservations, ${entryExpr} AS entries_count, cancellation_count,
             studyroom_revenue, general_revenue
      FROM revenue_daily
      WHERE date >= CURRENT_DATE - ($1::text || ' days')::interval
      ORDER BY date DESC
    `, [days]);

    if (!rows || rows.length === 0) return null;

    const latest = rows[0];
    const revenues = rows.map(r => Number(r.actual_revenue || 0)).filter(v => v > 0);
    const avg7d = revenues.length > 0
      ? revenues.reduce((a, b) => a + b, 0) / revenues.length
      : 0;

    return {
      today: Number(latest.actual_revenue || 0),
      avg7d,
      ratio: avg7d > 0 ? Number(latest.actual_revenue || 0) / avg7d : 1,
      occupancy: Number(latest.occupancy_rate || 0),
      entries: Number(latest.entries_count || 0),
      reservations: Number(latest.total_reservations || 0),
      anomaly: avg7d > 0 && Math.abs((Number(latest.actual_revenue || 0) / avg7d) - 1) > 0.15,
      trend: revenues.length >= 3
        ? (revenues[0] > revenues[1] && revenues[1] > revenues[2] ? 'up' :
           revenues[0] < revenues[1] && revenues[1] < revenues[2] ? 'down' : 'stable')
        : 'unknown',
      rows,
    };
  } catch (err) {
    console.warn('[sense-engine] 스카팀 매출 조회 실패:', err.message);
    return null;
  }
}

/**
 * 스카팀 환경 변수 조회 (공휴일, 날씨, 시험 등)
 */
async function getSkaEnvironment(date = null) {
  try {
    const targetDate = date || 'CURRENT_DATE';
    const rows = await pgPool.query('ska', `
      SELECT holiday_flag, holiday_name, rain_prob, temperature,
             exam_score, exam_types, vacation_flag, festival_flag,
             festival_name, bridge_holiday_flag
      FROM environment_factors
      WHERE date = ${date ? '$1' : 'CURRENT_DATE'}
    `, date ? [date] : []);

    return rows?.[0] || null;
  } catch {
    return null;
  }
}

/**
 * 최근 블로그 성과 요약
 */
async function getRecentBlogPerformance(days = 7) {
  try {
    const columns = await getTableColumns('blog', 'blog', 'posts');
    const publishedExpr = columns.has('published_at')
      ? 'published_at'
      : columns.has('publish_date')
        ? 'publish_date'
        : 'created_at';

    const rows = await pgPool.query('blog', `
      SELECT id, title, post_type, views, comments, likes,
             ${publishedExpr} AS published_at, naver_url
      FROM blog.posts
      WHERE ${publishedExpr} >= CURRENT_DATE - ($1::text || ' days')::interval
        AND status = 'published'
      ORDER BY ${publishedExpr} DESC
    `, [days]);

    const totalViews = rows.reduce((sum, r) => sum + (Number(r.views) || 0), 0);
    const avgViews = rows.length > 0 ? totalViews / rows.length : 0;
    const best = rows.reduce((a, b) => (Number(a.views) || 0) > (Number(b.views) || 0) ? a : b, rows[0]);
    const worst = rows.reduce((a, b) => (Number(a.views) || 0) < (Number(b.views) || 0) ? a : b, rows[0]);

    return {
      count: rows.length,
      totalViews,
      avgViews,
      best: best ? { title: best.title, views: best.views } : null,
      worst: worst ? { title: worst.title, views: worst.views } : null,
      rows,
    };
  } catch {
    return { count: 0, totalViews: 0, avgViews: 0, best: null, worst: null, rows: [] };
  }
}

/**
 * 일일 SENSE 실행 — 전체 리소스 상태 파악
 */
async function senseDailyState() {
  const [skaRevenue, skaEnv, blogPerf, strategy] = await Promise.all([
    getSkaRevenue(7),
    getSkaEnvironment(),
    getRecentBlogPerformance(7),
    Promise.resolve(loadLatestStrategy()),
  ]);

  const sense = {
    sensedAt: new Date().toISOString(),
    skaRevenue,
    skaEnvironment: skaEnv,
    blogPerformance: blogPerf,
    currentStrategy: strategy,
    signals: [],
  };

  // 신호 생성
  if (skaRevenue?.anomaly) {
    sense.signals.push({
      type: 'revenue_anomaly',
      message: `매출 ${skaRevenue.ratio > 1 ? '급증' : '급감'} 감지 (7일 평균 대비 ${((skaRevenue.ratio - 1) * 100).toFixed(1)}%)`,
      priority: 'high',
    });
  }

  if (skaRevenue?.trend === 'down') {
    sense.signals.push({
      type: 'revenue_decline',
      message: '매출 3일 연속 하락 추세',
      priority: 'medium',
    });
  }

  if (skaEnv?.holiday_flag) {
    sense.signals.push({
      type: 'holiday',
      message: `공휴일 감지: ${skaEnv.holiday_name || '공휴일'}`,
      priority: 'info',
    });
  }

  if (skaEnv?.exam_score > 0) {
    sense.signals.push({
      type: 'exam_period',
      message: `시험 기간 감지 (score: ${skaEnv.exam_score})`,
      priority: 'medium',
    });
  }

  if (blogPerf?.avgViews > 0 && blogPerf?.worst?.views < blogPerf.avgViews * 0.3) {
    sense.signals.push({
      type: 'low_performance_post',
      message: `저성과 포스트 감지: "${blogPerf.worst.title}" (${blogPerf.worst.views}회)`,
      priority: 'low',
    });
  }

  return sense;
}

module.exports = {
  senseDailyState,
  getSkaRevenue,
  getSkaEnvironment,
  getRecentBlogPerformance,
};
