'use strict';

/**
 * richer.js (리처) — 블로그 작성에 필요한 정보 수집
 *
 * LLM 불필요 — 외부 API 호출만
 * - Hacker News 상위 IT 뉴스
 * - Node.js 최신 릴리스 (GitHub API)
 * - 날씨 정보 (OpenWeatherMap)
 */

const https  = require('https');
const pgPool = require('../../../packages/core/lib/pg-pool');
const rag    = require('../../../packages/core/lib/rag-safe');
const env    = require('../../../packages/core/lib/env');
const { resolveNaverCredentials } = require('../../../packages/core/lib/news-credentials');
const { parseNaverBlogUrl } = require('../../../packages/core/lib/naver-blog-url');

const DEV_HUB_READONLY = env.IS_DEV && !!env.HUB_BASE_URL && !process.env.PG_DIRECT;

// ─── 헬퍼 ────────────────────────────────────────────────────────────

function httpsGet(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'ai-agent-blog/1.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try   { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function httpsGetText(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'ai-agent-blog/1.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function _extractMetric(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match) continue;
    const value = Number(String(match[1] || '').replace(/[^\d]/g, ''));
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function extractNaverBlogStats(html = '') {
  return {
    views: _extractMetric(html, [
      /readCount["'=:\s]+([0-9,]+)/i,
      /viewCount["'=:\s]+([0-9,]+)/i,
      /postViewCount["'=:\s]+([0-9,]+)/i,
      /visitorCount["'=:\s]+([0-9,]+)/i,
    ]),
    comments: _extractMetric(html, [
      /commentCount["'=:\s]+([0-9,]+)/i,
      /comment_cnt["'=:\s]+([0-9,]+)/i,
    ]),
    likes: _extractMetric(html, [
      /sympathyCount["'=:\s]+([0-9,]+)/i,
      /sympathyCnt["'=:\s]+([0-9,]+)/i,
      /likeItCount["'=:\s]+([0-9,]+)/i,
    ]),
  };
}

async function searchNaverBlogByTitle(title) {
  try {
    const { clientId, clientSecret } = await resolveNaverCredentials();
    if (!clientId || !clientSecret || !title) return null;

    const url = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(title)}&display=3&sort=sim`;
    const data = await new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          'User-Agent': 'ai-agent-blog/1.0',
          'X-Naver-Client-Id': clientId,
          'X-Naver-Client-Secret': clientSecret,
        },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      });
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
    });

    const item = Array.isArray(data?.items) ? data.items.find((entry) => parseNaverBlogUrl(entry?.link || '').ok) : null;
    return item?.link || null;
  } catch (e) {
    console.warn('[리처] 네이버 블로그 검색 실패:', e.message);
    return null;
  }
}

async function fetchNaverBlogStats(post = {}) {
  const urlCandidates = [];
  if (post.naver_url) urlCandidates.push(post.naver_url);
  if (post.url) urlCandidates.push(post.url);
  if (post.metadata?.url) urlCandidates.push(post.metadata.url);

  let resolvedUrl = urlCandidates.find(Boolean) || null;
  if (!resolvedUrl && post.title) {
    resolvedUrl = await searchNaverBlogByTitle(post.title);
  }
  if (!resolvedUrl) {
    return { views: 0, comments: 0, likes: 0, source: 'unresolved' };
  }

  const parsed = parseNaverBlogUrl(resolvedUrl);
  const targets = parsed.ok
    ? [parsed.mobileUrl, parsed.canonicalUrl, resolvedUrl].filter(Boolean)
    : [resolvedUrl];

  for (const target of targets) {
    try {
      const html = await httpsGetText(target, 15000);
      const stats = extractNaverBlogStats(html);
      return {
        ...stats,
        url: target,
        source: target.includes('m.blog.naver.com') ? 'mobile_html' : 'html',
      };
    } catch (e) {
      console.warn('[리처] 네이버 블로그 성과 수집 실패:', e.message);
    }
  }

  return { views: 0, comments: 0, likes: 0, url: resolvedUrl, source: 'fallback_zero' };
}

// ─── 데이터 수집 ─────────────────────────────────────────────────────

/**
 * Hacker News 상위 IT 뉴스 수집
 */
async function fetchITNews(limit = 5) {
  try {
    const topIds = await httpsGet('https://hacker-news.firebaseio.com/v0/topstories.json');
    if (!Array.isArray(topIds)) return [];

    const stories = [];
    for (const id of topIds.slice(0, Math.min(limit * 3, 30))) {
      if (stories.length >= limit) break;
      const story = await httpsGet(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
      if (story?.title && story?.url) {
        stories.push({ title: story.title, url: story.url, score: story.score || 0 });
      }
    }
    return stories;
  } catch (e) {
    console.warn('[리처] IT뉴스 수집 실패:', e.message);
    return [];
  }
}

/**
 * Node.js 최신 릴리스 정보 (GitHub API)
 */
async function fetchNodejsUpdates() {
  try {
    const releases = await httpsGet(
      'https://api.github.com/repos/nodejs/node/releases?per_page=3'
    );
    if (!Array.isArray(releases)) return [];
    return releases.map(r => ({
      tag:  r.tag_name,
      name: r.name,
      date: r.published_at?.slice(0, 10),
      body: (r.body || '').slice(0, 300),
    }));
  } catch (e) {
    console.warn('[리처] Node.js 업데이트 수집 실패:', e.message);
    return [];
  }
}

/**
 * 날씨 정보 수집 (OpenWeatherMap — 분당서현 좌표)
 */
async function fetchWeather() {
  try {
    const apiKey = process.env.OPENWEATHERMAP_API_KEY;
    if (!apiKey) return { description: '맑음', temperature: 20, humidity: 50 };

    const data = await httpsGet(
      `https://api.openweathermap.org/data/2.5/weather?lat=37.3845&lon=127.1209&appid=${apiKey}&units=metric&lang=kr`,
      8000
    );
    return {
      description: data?.weather?.[0]?.description || '맑음',
      temperature: data?.main?.temp ?? null,
      feels_like:  data?.main?.feels_like ?? null,
      humidity:    data?.main?.humidity ?? null,
    };
  } catch (e) {
    console.warn('[리처] 날씨 수집 실패:', e.message);
    return { description: '날씨 정보 없음', temperature: null };
  }
}

/**
 * 전체 리서치 실행
 * @param {string} category — 오늘 일반 포스팅 카테고리
 * @param {boolean} needsBookInfo — 도서리뷰 카테고리인지
 */
async function research(category, needsBookInfo = false) {
  console.log('[리처] 수집 시작...');

  const [itNews, nodejsUpdates, weather] = await Promise.all([
    fetchITNews(5),
    fetchNodejsUpdates(),
    fetchWeather(),
  ]);

  const result = {
    timestamp:      new Date().toISOString(),
    it_news:        itNews,
    nodejs_updates: nodejsUpdates,
    weather,
    category,
    book_info:      needsBookInfo
      ? { note: '도서 정보 수집 — 추후 교보/예스24 API 연동 예정' }
      : null,
  };

  // 캐시 저장
  if (!DEV_HUB_READONLY) {
    try {
      await pgPool.run('blog', `
        INSERT INTO blog.research_cache (date, category, data, source)
        VALUES (CURRENT_DATE, $1, $2, 'daily_research')
      `, [category, JSON.stringify(result)]);
    } catch (e) {
      console.warn('[리처] 캐시 저장 실패:', e.message);
    }
  }

  console.log(
    `[리처] 수집 완료: IT뉴스 ${itNews.length}건, Node.js ${nodejsUpdates.length}건, ` +
    `날씨 ${weather.description}${weather.temperature != null ? ` ${weather.temperature}°C` : ''}`
  );
  return result;
}

// ─── RAG 실전 사례 검색 ───────────────────────────────────────────────

/**
 * RAG에서 포스팅 주제와 관련된 실전 에피소드 검색
 * 검색 대상: tech(크래시/버그), operations(장애/복구), blog(과거 포스팅)
 */
async function searchRealExperiences(topic, postType = 'lecture') {
  const episodes = [];
  try {
    if (!DEV_HUB_READONLY) {
      await rag.initSchema();
    }

    // tech — 개발 크래시/오류 수정 사례
    const techHits = await rag.search('tech', topic, { limit: 2, threshold: 0.5 });
    if (techHits?.length) {
      episodes.push(...techHits.map(h => ({
        source: 'tech',
        type:   '기술 이슈/해결 사례',
        content: h.content?.slice(0, 300),
      })));
    }

    // operations — 운영 장애/복구 사례
    const opsHits = await rag.search('operations', topic, { limit: 2, threshold: 0.5 });
    if (opsHits?.length) {
      episodes.push(...opsHits.map(h => ({
        source: 'operations',
        type:   '운영 장애/복구 사례',
        content: h.content?.slice(0, 300),
      })));
    }

    // 강의 포스팅이면 기술 키워드로 추가 검색
    if (postType === 'lecture') {
      const techKws = topic.match(/[A-Za-z]{3,}/g) || [];
      for (const kw of techKws.slice(0, 2)) {
        const kwHits = await rag.search('tech', `${kw} error crash fix`, { limit: 1, threshold: 0.4 });
        if (kwHits?.length) {
          episodes.push({
            source: 'tech',
            type:   `${kw} 크래시/오류 수정 사례`,
            content: kwHits[0].content?.slice(0, 300),
          });
        }
      }
    }

    // blog — 과거 포스팅 연결점
    const blogHits = await rag.search('blog', topic, { limit: 1, threshold: 0.6 });
    if (blogHits?.length) {
      episodes.push({
        source: 'blog',
        type:   '과거 포스팅 연결점',
        content: blogHits[0].content?.slice(0, 200),
      });
    }
  } catch (e) {
    console.warn('[리처] RAG 실전 사례 검색 실패:', e.message);
  }

  console.log(`[리처] 실전 에피소드 ${episodes.length}건 발견`);
  return episodes;
}

/**
 * RAG에서 현재 포스팅 주제와 관련된 과거 포스팅 검색 (내부 링킹용)
 */
/**
 * @param {string} topic
 * @param {number|null} [currentLectureNum] — 강의 포스팅이면 현재 강의 번호 (과거만 필터)
 */
async function searchRelatedPosts(topic, currentLectureNum = null) {
  try {
    if (!DEV_HUB_READONLY) {
      await rag.initSchema();
    }
    const hits = await rag.search('blog', topic, { limit: 5, threshold: 0.5 });
    if (!hits?.length) return [];

    let filtered = hits
      .filter(h => h.content && !h.content.includes(topic.slice(0, 15)))
      .slice(0, 5)
      .map(h => ({
        title:         h.content?.match(/\[.*?\]\s*(.*)/)?.[1]?.slice(0, 60) || '관련 포스팅',
        summary:       h.content?.slice(0, 120),
        meta:          h.metadata,
        lectureNumber: h.metadata?.lecture_number ? Number(h.metadata.lecture_number) : null,
      }));

    // 강의 포스팅이면 현재 강의 번호보다 앞선 것만 (미래 포스팅 404 방지)
    if (currentLectureNum) {
      filtered = filtered.filter(p =>
        !p.lectureNumber || p.lectureNumber < currentLectureNum
      );
    }

    return filtered.slice(0, 3);
  } catch (e) {
    console.warn('[리처] 관련 포스팅 검색 실패:', e.message);
    return [];
  }
}

function _buildPopularPatternQueries(category = 'general') {
  if (category === 'lecture') {
    return ['blog_success Node.js강의', 'blog_success lecture'];
  }
  return [`blog_success ${category}`];
}

async function searchPopularPatterns(category = 'general') {
  try {
    if (!DEV_HUB_READONLY) {
      await rag.initSchema();
    }
    const merged = [];
    for (const query of _buildPopularPatternQueries(category)) {
      const hits = await rag.search('experience', query, {
        limit: 3,
        threshold: 0.35,
        filter: {
          team: 'blog',
          intent: 'blog_success',
        },
      });
      for (const hit of hits || []) {
        const signature = `${hit.content || ''}|${JSON.stringify(hit.metadata || {})}`;
        if (merged.some((item) => item.signature === signature)) continue;
        merged.push({
          signature,
          content: hit.content?.slice(0, 200),
          metadata: hit.metadata || {},
        });
      }
    }
    return merged.slice(0, 3).map(({ signature, ...item }) => item);
  } catch (e) {
    console.warn('[리처] 인기 패턴 검색 실패:', e.message);
    return [];
  }
}

module.exports = {
  research,
  fetchITNews,
  fetchNodejsUpdates,
  fetchWeather,
  extractNaverBlogStats,
  fetchNaverBlogStats,
  searchNaverBlogByTitle,
  searchRealExperiences,
  searchRelatedPosts,
  searchPopularPatterns,
};
