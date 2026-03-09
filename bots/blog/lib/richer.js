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
  try {
    await pgPool.run('blog', `
      INSERT INTO blog.research_cache (date, category, data, source)
      VALUES (CURRENT_DATE, $1, $2, 'daily_research')
    `, [category, JSON.stringify(result)]);
  } catch (e) {
    console.warn('[리처] 캐시 저장 실패:', e.message);
  }

  console.log(
    `[리처] 수집 완료: IT뉴스 ${itNews.length}건, Node.js ${nodejsUpdates.length}건, ` +
    `날씨 ${weather.description}${weather.temperature != null ? ` ${weather.temperature}°C` : ''}`
  );
  return result;
}

module.exports = { research, fetchITNews, fetchNodejsUpdates, fetchWeather };
