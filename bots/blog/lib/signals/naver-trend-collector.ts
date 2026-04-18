'use strict';

/**
 * bots/blog/lib/signals/naver-trend-collector.ts
 * 네이버 데이터랩 트렌드 수집
 *
 * Phase 5: 키워드 트렌드 + 급상승 주제 감지
 * Kill Switch: BLOG_SIGNAL_COLLECTOR_ENABLED=true
 *
 * API: https://developers.naver.com/docs/serviceapi/datalab/search/search.md
 */

const pgPool = require('../../../../packages/core/lib/pg-pool');

function isEnabled() {
  return process.env.BLOG_SIGNAL_COLLECTOR_ENABLED === 'true';
}

function getNaverClientId() {
  return process.env.NAVER_CLIENT_ID || '';
}

function getNaverClientSecret() {
  return process.env.NAVER_CLIENT_SECRET || '';
}

function getDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * 네이버 데이터랩 검색어 트렌드 조회
 * @param {string[]} keywords 조회할 키워드 목록
 */
async function fetchNaverTrend(keywords) {
  const clientId = getNaverClientId();
  const clientSecret = getNaverClientSecret();

  if (!clientId || !clientSecret) {
    console.warn('[naver-trend] NAVER_CLIENT_ID/SECRET 미설정');
    return null;
  }

  try {
    const response = await fetch('https://openapi.naver.com/v1/datalab/search', {
      method: 'POST',
      headers: {
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        startDate: getDateDaysAgo(14),
        endDate: getDateDaysAgo(0),
        timeUnit: 'date',
        keywordGroups: keywords.map((kw) => ({ groupName: kw, keywords: [kw] })),
      }),
    });

    if (!response.ok) {
      console.warn('[naver-trend] API 오류:', response.status, response.statusText);
      return null;
    }

    return await response.json();
  } catch (err) {
    console.warn('[naver-trend] 요청 실패:', err.message);
    return null;
  }
}

/**
 * 트렌드 데이터 분석 + 성장률 계산
 */
function analyzeTrend(keyword, datalabData) {
  if (!datalabData?.results?.[0]?.data) {
    return { keyword, trend_score: 0, growth_rate_week: 0, related_keywords: [] };
  }

  const data = datalabData.results[0].data;
  const sorted = data.sort((a, b) => new Date(a.period) - new Date(b.period));
  const recent = sorted.slice(-7);
  const previous = sorted.slice(-14, -7);

  const recentAvg = recent.reduce((sum, d) => sum + Number(d.ratio || 0), 0) / Math.max(recent.length, 1);
  const previousAvg = previous.reduce((sum, d) => sum + Number(d.ratio || 0), 0) / Math.max(previous.length, 1);

  const growthRate = previousAvg > 0
    ? ((recentAvg - previousAvg) / previousAvg) * 100
    : 0;

  return {
    keyword,
    trend_score: Number(recentAvg.toFixed(1)),
    growth_rate_week: Number(growthRate.toFixed(1)),
    related_keywords: [],
  };
}

/**
 * 블로팀 핵심 키워드 트렌드 수집
 */
async function collectBlogKeywordTrends() {
  if (!isEnabled()) return [];

  const blogKeywords = [
    '스터디카페', '공부법', '자기계발', '집중력', '독서',
    'AI 도구', '개발 공부', '성장', '루틴', '시험',
  ];

  const results = [];
  // API 배치 처리 (최대 5개씩)
  for (let i = 0; i < blogKeywords.length; i += 5) {
    const batch = blogKeywords.slice(i, i + 5);
    const data = await fetchNaverTrend(batch);
    if (!data) continue;

    for (const kw of batch) {
      results.push(analyzeTrend(kw, data));
    }

    if (i + 5 < blogKeywords.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // DB 저장
  if (results.length > 0) {
    try {
      for (const trend of results) {
        await pgPool.query('blog', `
          INSERT INTO blog.keyword_trends
            (keyword, trend_score, growth_rate_week, collected_at)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT DO NOTHING
        `, [trend.keyword, trend.trend_score, trend.growth_rate_week]).catch(() => {});
      }
    } catch {
      // DB 저장 실패는 무시
    }
  }

  return results;
}

/**
 * 급상승 트렌드 키워드 감지 (topic-selector 힌트용)
 */
async function detectTrendingTopics() {
  try {
    const rows = await pgPool.query('blog', `
      SELECT keyword, growth_rate_week
      FROM blog.keyword_trends
      WHERE collected_at > NOW() - '1 day'::interval
        AND growth_rate_week > 20
      ORDER BY growth_rate_week DESC
      LIMIT 5
    `);
    return (rows || []).map((r) => r.keyword);
  } catch {
    return [];
  }
}

module.exports = {
  isEnabled,
  fetchNaverTrend,
  analyzeTrend,
  collectBlogKeywordTrends,
  detectTrendingTopics,
};
