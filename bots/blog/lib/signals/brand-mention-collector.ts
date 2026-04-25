'use strict';

/**
 * bots/blog/lib/signals/brand-mention-collector.ts
 * 브랜드 멘션 모니터링 (네이버 블로그/카페/지식iN)
 *
 * Phase 5: 브랜드 언급 감지 + 감성 분석 + 부정 멘션 긴급 알림
 * Kill Switch: BLOG_SIGNAL_COLLECTOR_ENABLED=true
 */

const { postAlarm } = require('../../../../packages/core/lib/openclaw-client');
const { runIfOps } = require('../../../../packages/core/lib/mode-guard');
const pgPool = require('../../../../packages/core/lib/pg-pool');

function isEnabled() {
  return process.env.BLOG_SIGNAL_COLLECTOR_ENABLED === 'true';
}

// 스터디카페 브랜드 키워드
const BRAND_KEYWORDS = [
  '커피랑도서관',
  '커피랑도서관 분당서현점',
  '분당서현',
  '서현역 스터디카페',
  '승호아빠',
  '스터디카페',
  '독서실 카페',
  '공부 카페',
];

// 부정 키워드 (감성 분석 간이)
const NEGATIVE_KEYWORDS = [
  '불편', '최악', '별로', '실망', '환불', '돌려줘', '후기 나쁨', '가지마',
  '시끄럽', '지저분', '불친절', '비싸', '좁아', '추천 안함',
];

// 긍정 키워드
const POSITIVE_KEYWORDS = [
  '추천', '좋아요', '좋았어', '깔끔', '조용', '집중', '만족', '재방문',
  '최고', '완벽', '쾌적', '넓어', '친절', '가성비',
];

/**
 * 텍스트 감성 분석 (규칙 기반 간이 분류)
 * @param {string} text
 * @returns {'positive'|'neutral'|'negative'}
 */
function analyzeSentiment(text) {
  if (!text) return 'neutral';
  const normalized = text.toLowerCase();
  const negCount = NEGATIVE_KEYWORDS.filter((kw) => normalized.includes(kw)).length;
  const posCount = POSITIVE_KEYWORDS.filter((kw) => normalized.includes(kw)).length;

  if (negCount > posCount) return 'negative';
  if (posCount > negCount) return 'positive';
  return 'neutral';
}

/**
 * 네이버 검색 API로 블로그 멘션 수집
 * @param {string} keyword 검색 키워드
 */
async function searchNaverBlogMentions(keyword) {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;

  if (!clientId || !clientSecret) return [];

  try {
    const query = encodeURIComponent(keyword);
    const response = await fetch(
      `https://openapi.naver.com/v1/search/blog?query=${query}&display=10&sort=date`,
      {
        headers: {
          'X-Naver-Client-Id': clientId,
          'X-Naver-Client-Secret': clientSecret,
        },
      },
    );

    if (!response.ok) return [];

    const data = await response.json();
    return (data.items || []).map((item) => ({
      title: item.title?.replace(/<[^>]+>/g, '') || '',
      description: item.description?.replace(/<[^>]+>/g, '') || '',
      link: item.link || '',
      blog_name: item.bloggername || '',
      post_date: item.postdate || '',
      sentiment: analyzeSentiment((item.title || '') + ' ' + (item.description || '')),
      keyword,
      source: 'naver_blog',
    }));
  } catch {
    return [];
  }
}

/**
 * 브랜드 멘션 수집 + 부정 멘션 긴급 알림
 * @param {string[]} [keywords] 브랜드 키워드 목록 (기본: BRAND_KEYWORDS)
 */
async function collectBrandMentions(keywords = BRAND_KEYWORDS) {
  if (!isEnabled()) return { total: 0, positive: 0, neutral: 0, negative: 0, items: [] };

  const allMentions = [];

  for (const kw of keywords) {
    const mentions = await searchNaverBlogMentions(kw);
    allMentions.push(...mentions);
    if (keywords.length > 1) await new Promise((r) => setTimeout(r, 300));
  }

  // 중복 제거 (link 기준)
  const uniqueMentions = allMentions.filter((m, idx, arr) =>
    idx === arr.findIndex((t) => t.link === m.link),
  );

  const positive = uniqueMentions.filter((m) => m.sentiment === 'positive').length;
  const negative = uniqueMentions.filter((m) => m.sentiment === 'negative');
  const neutral = uniqueMentions.length - positive - negative.length;

  // 부정 멘션 긴급 알림
  if (negative.length > 0) {
    const sample = negative[0];
    const msg = `🚨 [블로팀] 브랜드 부정 멘션 ${negative.length}건 감지\n`
      + `출처: ${sample.blog_name}\n`
      + `제목: ${sample.title}\n`
      + `내용: ${sample.description?.slice(0, 100)}`;

    await runIfOps(
      'blog-brand-negative',
      () => postAlarm({ message: msg, team: 'blog', bot: 'brand-mention', level: 'critical' }),
      () => console.warn('[DEV] 부정 멘션:', msg),
    ).catch(() => {});
  }

  // DB 저장
  try {
    for (const mention of uniqueMentions.slice(0, 20)) {
      await pgPool.query('blog', `
        INSERT INTO blog.brand_mentions
          (keyword, title, description, link, blog_name, post_date, sentiment, source, collected_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        ON CONFLICT (link) DO NOTHING
      `, [
        mention.keyword, mention.title, mention.description,
        mention.link, mention.blog_name, mention.post_date,
        mention.sentiment, mention.source,
      ]).catch(() => {});
    }
  } catch {
    // DB 실패 무시
  }

  return {
    total: uniqueMentions.length,
    positive,
    neutral,
    negative: negative.length,
    items: uniqueMentions,
  };
}

/**
 * 최근 24시간 브랜드 멘션 요약 (evolution-cycle에서 호출)
 */
async function getBrandMentionSummary(hours = 24) {
  try {
    const rows = await pgPool.query('blog', `
      SELECT
        sentiment,
        COUNT(*) AS cnt
      FROM blog.brand_mentions
      WHERE collected_at > NOW() - ($1::text || ' hours')::interval
      GROUP BY sentiment
    `, [hours]);

    const result = { positive: 0, neutral: 0, negative: 0 };
    for (const r of (rows || [])) {
      if (result[r.sentiment] !== undefined) {
        result[r.sentiment] = Number(r.cnt || 0);
      }
    }
    return result;
  } catch {
    return { positive: 0, neutral: 0, negative: 0 };
  }
}

module.exports = {
  isEnabled,
  analyzeSentiment,
  collectBrandMentions,
  searchNaverBlogMentions,
  getBrandMentionSummary,
  BRAND_KEYWORDS,
};
