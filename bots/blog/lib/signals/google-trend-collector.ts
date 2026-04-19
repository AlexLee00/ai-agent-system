'use strict';

/**
 * bots/blog/lib/signals/google-trend-collector.ts
 * 구글 트렌드 수집 (google-trends-api npm)
 *
 * Phase 5: 글로벌/국내 검색 트렌드 수집 + 급상승 키워드 감지
 * Kill Switch: BLOG_SIGNAL_COLLECTOR_ENABLED=true
 */

const pgPool = require('../../../../packages/core/lib/pg-pool');

function isEnabled() {
  return process.env.BLOG_SIGNAL_COLLECTOR_ENABLED === 'true';
}

async function loadGoogleTrendsApi() {
  try {
    return require('google-trends-api');
  } catch {
    return null;
  }
}

async function fetchSingleKeywordTrend(googleTrends, keyword, geo) {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 14);

  let trendScore = 50;
  let growthRateWeek = 0;
  let risingQueries = [];
  let topQueries = [];

  try {
    const interestRaw = await googleTrends.interestOverTime({
      keyword,
      geo,
      startTime: startDate,
      endTime: endDate,
    });
    const interestData = JSON.parse(interestRaw);
    const timeline = (interestData && interestData.default && interestData.default.timelineData) || [];

    if (timeline.length > 0) {
      const values = timeline.map((p) => (p.value && p.value[0]) || 0);
      trendScore = values[values.length - 1];

      const half = Math.floor(values.length / 2);
      const prevWeekAvg = values.slice(0, half).reduce((s, v) => s + v, 0) / (half || 1);
      const thisWeekAvg = values.slice(half).reduce((s, v) => s + v, 0) / ((values.length - half) || 1);
      growthRateWeek = prevWeekAvg > 0 ? ((thisWeekAvg - prevWeekAvg) / prevWeekAvg) * 100 : 0;
    }
  } catch {}

  try {
    const relatedRaw = await googleTrends.relatedQueries({ keyword, geo });
    const relatedData = JSON.parse(relatedRaw);
    const rising = (relatedData && relatedData.default && relatedData.default.rankedList && relatedData.default.rankedList[0] && relatedData.default.rankedList[0].rankedKeyword) || [];
    const top = (relatedData && relatedData.default && relatedData.default.rankedList && relatedData.default.rankedList[1] && relatedData.default.rankedList[1].rankedKeyword) || [];

    risingQueries = rising.slice(0, 5).map((r) => r.query || '');
    topQueries = top.slice(0, 5).map((r) => r.query || '');
  } catch {}

  return {
    keyword,
    geo,
    trend_score: Math.round(trendScore),
    growth_rate_week: Math.round(growthRateWeek * 10) / 10,
    related_queries_rising: risingQueries.filter(Boolean),
    related_queries_top: topQueries.filter(Boolean),
    collected_at: new Date().toISOString(),
  };
}

async function collectGoogleTrends(keywords, geo) {
  if (!isEnabled()) return [];
  const geoCode = geo || 'KR';

  const googleTrends = await loadGoogleTrendsApi();
  if (!googleTrends) {
    console.warn('[구글트렌드] google-trends-api 패키지 미설치 — 스킵');
    return [];
  }

  const results = [];

  for (const keyword of keywords) {
    try {
      await new Promise((r) => setTimeout(r, 1500));
      const result = await fetchSingleKeywordTrend(googleTrends, keyword, geoCode);
      results.push(result);
    } catch (e) {
      console.warn(`[구글트렌드] ${keyword} 수집 실패:`, e.message);
    }
  }

  if (results.length > 0) {
    await saveGoogleTrends(results);
  }

  console.log(`[구글트렌드] ${results.length}/${keywords.length}개 수집 완료`);
  return results;
}

async function detectGoogleRisingTopics(keywords, geo) {
  const trends = await collectGoogleTrends(keywords, geo);
  const rising = trends
    .filter((t) => t.growth_rate_week > 50 && t.trend_score > 30)
    .sort((a, b) => b.growth_rate_week - a.growth_rate_week);

  return rising.map((r) => r.keyword);
}

async function saveGoogleTrends(results) {
  try {
    for (const r of results) {
      await pgPool.query(
        'blog',
        `INSERT INTO blog.keyword_trends
           (keyword, source, trend_score, growth_rate_week, metadata, collected_at)
         VALUES ($1, 'google', $2, $3, $4, NOW())
         ON CONFLICT (keyword, source, DATE(collected_at))
         DO UPDATE SET
           trend_score = EXCLUDED.trend_score,
           growth_rate_week = EXCLUDED.growth_rate_week,
           metadata = EXCLUDED.metadata`,
        [r.keyword, r.trend_score, r.growth_rate_week, JSON.stringify({ geo: r.geo, related_queries_rising: r.related_queries_rising, related_queries_top: r.related_queries_top })]
      );
    }
  } catch (e) {
    console.warn('[구글트렌드] DB 저장 실패:', e.message);
  }
}

module.exports = { collectGoogleTrends, detectGoogleRisingTopics };
