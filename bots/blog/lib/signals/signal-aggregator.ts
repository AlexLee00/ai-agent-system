'use strict';

/**
 * bots/blog/lib/signals/signal-aggregator.ts
 * 모든 외부 신호 통합 — 전략 의사결정에 주입
 *
 * Phase 5: 트렌드 + 경쟁사 + 멘션 + SKA 매출 + 내부 성과 통합
 * Kill Switch: BLOG_SIGNAL_COLLECTOR_ENABLED=true
 */

const pgPool = require('../../../../packages/core/lib/pg-pool');
const naverTrendCollector = require('./naver-trend-collector');
const googleTrendCollector = require('./google-trend-collector');
const brandMentionCollector = require('./brand-mention-collector');
const competitorMonitor = require('./competitor-monitor');

function isEnabled() {
  return process.env.BLOG_SIGNAL_COLLECTOR_ENABLED === 'true';
}

const MONITORING_KEYWORDS = [
  '스터디카페', '독서실 카페', '공부 카페', '스터디룸', '독서실 추천',
  'AI 개발', '자동화', '부업', '재테크',
];

async function fetchSkaRevenue7d() {
  if (process.env.BLOG_REVENUE_CORRELATION_ENABLED !== 'true') {
    return { available: false, total_krw: 0, vs_prev_week_pct: 0 };
  }
  try {
    const rows = await pgPool.query(
      'blog',
      `SELECT
         COALESCE(SUM(post_period_revenue_krw), 0) AS total_7d,
         COALESCE(SUM(baseline_revenue_krw), 0) AS prev_7d
       FROM blog.post_revenue_attribution
       WHERE post_published_at > NOW() - INTERVAL '7 days'`
    );
    const r = (rows.rows && rows.rows[0]) || {};
    const total = parseFloat(r.total_7d || '0');
    const prev = parseFloat(r.prev_7d || '0');
    const changePct = prev > 0 ? ((total - prev) / prev) * 100 : 0;
    return { available: true, total_krw: total, vs_prev_week_pct: Math.round(changePct * 10) / 10 };
  } catch {
    return { available: false, total_krw: 0, vs_prev_week_pct: 0 };
  }
}

async function fetchInternalPerformance() {
  try {
    const rows = await pgPool.query(
      'blog',
      `SELECT
         COUNT(*) AS posts_count,
         COALESCE(AVG(views), 0) AS avg_views,
         MODE() WITHIN GROUP (ORDER BY category) AS top_category
       FROM blog.posts
       WHERE published_at > NOW() - INTERVAL '7 days'
         AND status = 'published'`
    );
    const r = (rows.rows && rows.rows[0]) || {};
    return {
      posts_last_7d: parseInt(r.posts_count || '0'),
      avg_views_last_7d: Math.round(parseFloat(r.avg_views || '0')),
      top_category: r.top_category || 'unknown',
    };
  } catch {
    return { posts_last_7d: 0, avg_views_last_7d: 0, top_category: 'unknown' };
  }
}

function generateActionHints(signals) {
  const hints = [];

  if (signals.trends.rising_keywords.length > 0) {
    hints.push(`급상승 키워드 포스팅 우선: ${signals.trends.rising_keywords.slice(0, 3).join(', ')}`);
  }
  if (signals.competitors.viral_detected > 0) {
    hints.push('경쟁사 바이럴 감지 → 차별화 포스팅 즉시 발행 권장');
    if (signals.competitors.top_trending_angles.length > 0) {
      hints.push(`벤치마킹 각도: ${signals.competitors.top_trending_angles.slice(0, 2).join(', ')}`);
    }
  }
  if (signals.brand_mentions.negative > 0) {
    hints.push(`부정 멘션 ${signals.brand_mentions.negative}건 → 긍정 콘텐츠 보강 권장`);
  }
  if (signals.ska_revenue_7d.available && signals.ska_revenue_7d.vs_prev_week_pct < -10) {
    hints.push(`매출 ${Math.abs(signals.ska_revenue_7d.vs_prev_week_pct)}% 하락 → 신규 유입 유도 콘텐츠 강화`);
  }
  if (signals.internal_performance.avg_views_last_7d < 100) {
    hints.push(`평균 조회수 저조(${signals.internal_performance.avg_views_last_7d}회) → 제목 훅 강화`);
  }

  return hints;
}

function buildEmptySignals() {
  return {
    collected_at: new Date().toISOString(),
    trends: { rising_keywords: [], declining_keywords: [], naver_top: [], google_top: [] },
    competitors: { total_monitored: 0, viral_detected: 0, top_trending_angles: [], alerts: [] },
    brand_mentions: { total_24h: 0, positive: 0, neutral: 0, negative: 0, urgent_count: 0 },
    ska_revenue_7d: { available: false, total_krw: 0, vs_prev_week_pct: 0 },
    internal_performance: { posts_last_7d: 0, avg_views_last_7d: 0, top_category: 'unknown' },
    action_hints: [],
  };
}

async function aggregateAllSignals() {
  if (!isEnabled()) {
    console.log('[신호집계] Kill Switch OFF — 스킵');
    return buildEmptySignals();
  }

  console.log('[신호집계] 전체 신호 수집 시작');

  const [naverTrends, googleTrends, competitorSnaps, brandMentions, skaRevenue, internalPerf] =
    await Promise.allSettled([
      naverTrendCollector.collectNaverTrends(MONITORING_KEYWORDS.slice(0, 5)),
      googleTrendCollector.collectGoogleTrends(MONITORING_KEYWORDS.slice(0, 5)),
      competitorMonitor.monitorCompetitors(),
      brandMentionCollector.collectBrandMentions(['스터디카페', '스터디카페 추천']),
      fetchSkaRevenue7d(),
      fetchInternalPerformance(),
    ]);

  const naver = naverTrends.status === 'fulfilled' ? naverTrends.value : [];
  const google = googleTrends.status === 'fulfilled' ? googleTrends.value : [];
  const competitors = competitorSnaps.status === 'fulfilled' ? competitorSnaps.value : [];
  const mentions = brandMentions.status === 'fulfilled' ? brandMentions.value : null;
  const revenue = skaRevenue.status === 'fulfilled' ? skaRevenue.value : { available: false, total_krw: 0, vs_prev_week_pct: 0 };
  const internal = internalPerf.status === 'fulfilled' ? internalPerf.value : { posts_last_7d: 0, avg_views_last_7d: 0, top_category: 'unknown' };

  const naverRising = naver.filter((t) => t.growth_rate_week > 30).map((t) => t.keyword);
  const googleRising = google.filter((t) => t.growth_rate_week > 50).map((t) => t.keyword);
  const allRising = [...new Set([...naverRising, ...googleRising])];

  const viralComps = competitors.filter((c) => c.is_viral);
  let benchmarkAngles = [];
  if (competitors.length > 0) {
    try {
      const bench = await competitorMonitor.benchmarkCompetitorContent();
      benchmarkAngles = (bench.trending_angles || []).slice(0, 5);
    } catch {}
  }

  const signals = {
    collected_at: new Date().toISOString(),
    trends: {
      rising_keywords: allRising,
      declining_keywords: [],
      naver_top: naver.slice(0, 5).map((t) => ({ keyword: t.keyword, score: t.trend_score, growth: t.growth_rate_week })),
      google_top: google.slice(0, 5).map((t) => ({ keyword: t.keyword, score: t.trend_score, growth: t.growth_rate_week })),
    },
    competitors: {
      total_monitored: competitors.length,
      viral_detected: viralComps.length,
      top_trending_angles: benchmarkAngles,
      alerts: viralComps.map((c) => `${c.competitor_name}: 바이럴 감지`),
    },
    brand_mentions: mentions
      ? { total_24h: mentions.total || 0, positive: mentions.positive || 0, neutral: mentions.neutral || 0, negative: mentions.negative || 0, urgent_count: mentions.urgent || 0 }
      : { total_24h: 0, positive: 0, neutral: 0, negative: 0, urgent_count: 0 },
    ska_revenue_7d: revenue,
    internal_performance: internal,
  };

  const action_hints = generateActionHints(signals);
  const final = { ...signals, action_hints };

  await saveAggregatedSignals(final);
  console.log(`[신호집계] 완료 — 급상승: ${allRising.length}개, 바이럴: ${viralComps.length}개, 힌트: ${action_hints.length}개`);

  return final;
}

async function saveAggregatedSignals(signals) {
  try {
    await pgPool.query(
      'blog',
      `INSERT INTO blog.market_signals_log
         (signal_type, keyword, value, alert_level, collected_at)
       VALUES ('aggregate', 'all', $1, $2, NOW())`,
      [JSON.stringify(signals), signals.competitors.viral_detected > 0 || signals.brand_mentions.urgent_count > 0 ? 'warning' : 'info']
    );
  } catch (e) {
    console.warn('[신호집계] DB 저장 실패:', e.message);
  }
}

module.exports = { aggregateAllSignals };
