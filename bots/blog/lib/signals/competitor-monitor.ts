'use strict';

/**
 * bots/blog/lib/signals/competitor-monitor.ts
 * 경쟁사 모니터링 강화 (competitor-analyzer.ts 확장)
 *
 * Phase 5: 플랫폼별 경쟁사 스냅샷 + 바이럴 감지 + 벤치마킹
 * Kill Switch: BLOG_SIGNAL_COLLECTOR_ENABLED=true
 */

const pgPool = require('../../../../packages/core/lib/pg-pool');
const { postAlarm } = require('../../../../packages/core/lib/hub-alarm-client');
const { runIfOps } = require('../../../../packages/core/lib/mode-guard');

function isEnabled() {
  return process.env.BLOG_SIGNAL_COLLECTOR_ENABLED === 'true';
}

// 기본 모니터링 대상 (DB 없을 시 폴백)
const DEFAULT_COMPETITORS = [
  { name: '스터디카페A', category: 'study_cafe', keywords: ['스터디카페 추천', '독서실 카페'] },
  { name: '스터디카페B', category: 'study_cafe', keywords: ['공부 카페', '열람실 카페'] },
];

/**
 * DB에서 경쟁사 목록 조회 (없으면 기본값)
 */
async function loadCompetitors() {
  try {
    const rows = await pgPool.query(
      'blog',
      `SELECT name, category,
              metadata->>'naver_blog_url' AS naver_blog_url,
              metadata->>'naver_blog_id' AS naver_blog_id,
              metadata->>'instagram_handle' AS instagram_handle,
              metadata->'keywords' AS keywords
       FROM blog.competitors
       WHERE monitoring_enabled = true`
    );
    if (!rows.rows || rows.rows.length === 0) return DEFAULT_COMPETITORS;
    return rows.rows.map((r) => ({
      name: r.name,
      category: r.category,
      naver_blog_url: r.naver_blog_url,
      naver_blog_id: r.naver_blog_id,
      instagram_handle: r.instagram_handle,
      keywords: Array.isArray(r.keywords) ? r.keywords : DEFAULT_COMPETITORS[0].keywords,
    }));
  } catch {
    return DEFAULT_COMPETITORS;
  }
}

/**
 * 네이버 검색 API로 경쟁사 블로그 포스팅 수집
 */
async function fetchNaverBlogPosts(keywords) {
  const clientId = process.env.NAVER_CLIENT_ID || '';
  const clientSecret = process.env.NAVER_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) return [];

  const https = require('https');
  /** @type {{ title?: string, description?: string, postdate?: string }[]} */
  const allPosts = [];

  for (const kw of keywords.slice(0, 3)) {
    await new Promise((r) => setTimeout(r, 500));
    const encoded = encodeURIComponent(kw);

    await new Promise((resolve) => {
      const req = https.request(
        {
          hostname: 'openapi.naver.com',
          path: `/v1/search/blog?query=${encoded}&display=10&sort=date`,
          method: 'GET',
          headers: {
            'X-Naver-Client-Id': clientId,
            'X-Naver-Client-Secret': clientSecret,
          },
        },
        (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => {
            try {
              const data = JSON.parse(body);
              allPosts.push(...(data.items || []));
            } catch {}
            resolve(undefined);
          });
        }
      );
      req.on('error', () => resolve(undefined));
      req.end();
    });
  }

  return allPosts;
}

function extractTopKeywords(posts) {
  /** @type {Record<string, number>} */
  const freq = {};
  const stopwords = new Set([
    '이', '가', '을', '를', '은', '는', '에', '의', '과', '와', '로', '한',
    '하다', '있다', '없다', '되다', '합니다', '있습니다', '됩니다', '것', '수',
  ]);

  for (const post of posts) {
    const text = (post.title + ' ' + (post.description || ''))
      .replace(/<[^>]+>/g, '')
      .replace(/[^\w가-힣\s]/g, '');

    for (const word of text.split(/\s+/)) {
      if (word.length < 2 || stopwords.has(word)) continue;
      freq[word] = (freq[word] || 0) + 1;
    }
  }

  return Object.entries(freq)
    .sort(([, a], [, b]) => Number(b) - Number(a))
    .slice(0, 10)
    .map(([w]) => w);
}

async function snapshotCompetitor(comp) {
  const posts = await fetchNaverBlogPosts(comp.keywords);
  const topKeywords = extractTopKeywords(posts);
  const topTitles = posts.slice(0, 5).map((p) => (p.title || '').replace(/<[^>]+>/g, ''));

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const recentPosts = posts.filter((p) => new Date(p.postdate || '') > sevenDaysAgo);
  const isViral = recentPosts.length >= 3;

  return {
    competitor_name: comp.name,
    platform: 'naver_blog',
    measured_at: new Date().toISOString(),
    posts_found: posts.length,
    top_keywords: topKeywords,
    top_post_titles: topTitles,
    avg_engagement_estimate: 0,
    trending_topics: topKeywords.slice(0, 5),
    is_viral: isViral,
  };
}

/**
 * 이상 신호 감지 (바이럴 경쟁사 목록 반환)
 */
function detectAnomalies(snapshots) {
  return snapshots
    .filter((s) => s.is_viral)
    .map((s) => ({
      competitor_name: s.competitor_name,
      message: `${s.competitor_name}: 최근 7일 포스팅 급증 (바이럴 감지)`,
      trending_topics: s.trending_topics,
    }));
}

/**
 * 모든 경쟁사 모니터링 실행
 */
async function monitorCompetitors() {
  if (!isEnabled()) return [];

  const competitors = await loadCompetitors();
  const snapshots = [];

  for (const comp of competitors) {
    try {
      const snap = await snapshotCompetitor(comp);
      snapshots.push(snap);
      await saveSnapshot(snap);

      if (snap.is_viral) {
        console.log(`[경쟁사] ⚡ 바이럴 감지: ${comp.name}`);
      }
    } catch (e) {
      console.warn(`[경쟁사] ${comp.name} 수집 실패:`, e.message);
    }
  }

  const viralComps = snapshots.filter((s) => s.is_viral);
  if (viralComps.length > 0) {
    const msg = viralComps
      .map((s) => `${s.competitor_name}: ${s.top_post_titles.slice(0, 2).join(', ')}`)
      .join('\n');
    await runIfOps(() => postAlarm({
      message: `🔍 경쟁사 바이럴 감지 (${viralComps.length}개)\n${msg}`,
      team: 'blog',
      fromBot: 'competitor-monitor',
      alertLevel: 2,
      alarmType: 'work',
      eventType: 'competitor_viral_detected',
      incidentKey: `blog:competitor_viral:${new Date().toISOString().slice(0, 10)}`,
    }));
  }

  console.log(`[경쟁사] ${snapshots.length}개 경쟁사 모니터링 완료`);
  return snapshots;
}

/**
 * 경쟁사 콘텐츠 벤치마킹
 */
async function benchmarkCompetitorContent() {
  const competitors = await loadCompetitors();
  const allKeywords = [];
  const allTitles = [];

  for (const comp of competitors) {
    const posts = await fetchNaverBlogPosts(comp.keywords);
    allKeywords.push(...extractTopKeywords(posts));
    allTitles.push(...posts.slice(0, 5).map((p) => (p.title || '').replace(/<[^>]+>/g, '')));
  }

  /** @type {Record<string, number>} */
  const kwFreq = {};
  for (const kw of allKeywords) {
    kwFreq[kw] = (kwFreq[kw] || 0) + 1;
  }
  const topAngles = Object.entries(kwFreq)
    .sort(([, a], [, b]) => Number(b) - Number(a))
    .slice(0, 10)
    .map(([w]) => w);

  const titlePatterns = allTitles.filter((t) => /\d/.test(t) && t.length > 5).slice(0, 5);

  return {
    trending_angles: topAngles,
    effective_title_patterns: titlePatterns,
    successful_hashtags: topAngles.slice(0, 5).map((k) => `#${k}`),
  };
}

async function saveSnapshot(snap) {
  try {
    await pgPool.query(
      'blog',
      `INSERT INTO blog.market_signals_log
         (signal_type, keyword, value, alert_level, collected_at)
       VALUES ('competitor', $1, $2, $3, NOW())`,
      [snap.competitor_name, JSON.stringify(snap), snap.is_viral ? 'warning' : 'info']
    );
  } catch (e) {
    console.warn('[경쟁사] DB 저장 실패:', e.message);
  }
}

module.exports = { monitorCompetitors, benchmarkCompetitorContent, detectAnomalies };
