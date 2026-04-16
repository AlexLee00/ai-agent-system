// @ts-nocheck
'use strict';

/**
 * bots/blog/lib/hashtag-analyzer.ts — Phase 3: 인스타 해시태그 트렌드 분석
 *
 * Instagram Graph API 해시태그 검색 → 참여율 기반 랭킹 → 최적 해시태그 추천
 * 블로그 카테고리별 해시태그 전략 자동화
 */

const pgPool = require('../../../packages/core/lib/pg-pool');
const env = require('../../../packages/core/lib/env');

// 카테고리별 기본 해시태그 시드 (분석 기준점)
const CATEGORY_HASHTAGS: Record<string, string[]> = {
  'Node.js강의': ['nodejs', 'javascript', '개발강의', '프로그래밍', 'typescript', '백엔드'],
  '개발기획과컨설팅': ['IT기획', '개발컨설팅', '스타트업', 'IT프로젝트', '기획자'],
  '홈페이지와App': ['홈페이지제작', '앱개발', '웹개발', '웹사이트', '앱'],
  '성장과성공': ['자기계발', '성장', '성공습관', '동기부여', '목표달성'],
  '도서리뷰': ['책추천', '도서리뷰', 'IT책', '독서', '개발도서'],
  '투자와경제': ['주식', '재테크', '경제공부', '투자', '경제'],
  '커피랑도서관': ['스터디카페', '분당서현', '공부카페', '독서실', '카페공부'],
};

// 인스타 해시태그 참여율 계산 기준
const ENGAGEMENT_WEIGHT = {
  likes: 1.0,
  comments: 2.0,  // 댓글이 좋아요보다 더 높은 참여 가중치
};

interface HashtagMedia {
  id: string;
  like_count: number;
  comments_count: number;
  timestamp: string;
}

interface HashtagScore {
  hashtag: string;
  mediaCount: number;
  avgLikes: number;
  avgComments: number;
  engagementScore: number;
  trend: 'rising' | 'stable' | 'declining';
}

interface HashtagReport {
  category: string;
  analyzedAt: string;
  recommendations: HashtagScore[];
  topHashtags: string[];
  nicheHashtags: string[];
  strategy: string;
}

/**
 * Instagram Graph API 토큰 로드
 */
async function loadInstagramToken(): Promise<{ token: string; igUserId: string } | null> {
  try {
    // Hub secrets-store에서 로드 시도
    const hubUrl = env.HUB_BASE_URL || 'http://127.0.0.1:7788';
    const hubToken = process.env.HUB_AUTH_TOKEN || '';

    const resp = await fetch(`${hubUrl}/api/secrets`, {
      headers: { Authorization: `Bearer ${hubToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;

    const data = await resp.json();
    const ig = data?.instagram;
    if (!ig?.access_token || !ig?.ig_user_id) return null;

    return { token: ig.access_token, igUserId: ig.ig_user_id };
  } catch {
    return null;
  }
}

/**
 * Instagram Graph API: 해시태그 ID 검색
 */
async function getHashtagId(
  hashtag: string,
  igUserId: string,
  token: string
): Promise<string | null> {
  try {
    const url = `https://graph.facebook.com/v21.0/ig_hashtag_search`
      + `?q=${encodeURIComponent(hashtag)}`
      + `&user_id=${igUserId}`
      + `&access_token=${token}`;

    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return null;

    const data = await resp.json();
    return data?.data?.[0]?.id || null;
  } catch {
    return null;
  }
}

/**
 * Instagram Graph API: 해시태그 최근 미디어 조회
 */
async function getHashtagRecentMedia(
  hashtagId: string,
  igUserId: string,
  token: string
): Promise<HashtagMedia[]> {
  try {
    const url = `https://graph.facebook.com/v21.0/${hashtagId}/recent_media`
      + `?user_id=${igUserId}`
      + `&fields=id,like_count,comments_count,timestamp`
      + `&limit=20`
      + `&access_token=${token}`;

    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return [];

    const data = await resp.json();
    return Array.isArray(data?.data) ? data.data : [];
  } catch {
    return [];
  }
}

/**
 * 해시태그 참여율 점수 계산
 */
function calcEngagementScore(media: HashtagMedia[]): {
  avgLikes: number;
  avgComments: number;
  engagementScore: number;
} {
  if (media.length === 0) return { avgLikes: 0, avgComments: 0, engagementScore: 0 };

  const avgLikes = media.reduce((s, m) => s + (m.like_count || 0), 0) / media.length;
  const avgComments = media.reduce((s, m) => s + (m.comments_count || 0), 0) / media.length;
  const engagementScore = avgLikes * ENGAGEMENT_WEIGHT.likes + avgComments * ENGAGEMENT_WEIGHT.comments;

  return { avgLikes, avgComments, engagementScore };
}

/**
 * 해시태그 트렌드 추이 분석
 * 최근 10개 vs 이전 10개 참여율 비교
 */
function analyzeTrend(media: HashtagMedia[]): 'rising' | 'stable' | 'declining' {
  if (media.length < 10) return 'stable';

  // 시간순 정렬
  const sorted = [...media].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  const recent = sorted.slice(0, Math.floor(sorted.length / 2));
  const older = sorted.slice(Math.floor(sorted.length / 2));

  const recentAvg = recent.reduce((s, m) => s + (m.like_count || 0) + (m.comments_count || 0) * 2, 0) / recent.length;
  const olderAvg = older.reduce((s, m) => s + (m.like_count || 0) + (m.comments_count || 0) * 2, 0) / older.length;

  if (olderAvg === 0) return 'stable';
  const ratio = recentAvg / olderAvg;

  if (ratio >= 1.15) return 'rising';
  if (ratio <= 0.85) return 'declining';
  return 'stable';
}

/**
 * 해시태그 전략 텍스트 생성
 */
function buildHashtagStrategy(
  category: string,
  topHashtags: string[],
  nicheHashtags: string[]
): string {
  const lines: string[] = [
    `[${category} 해시태그 전략]`,
    `인기 태그 (3~5개): ${topHashtags.slice(0, 5).join(', ')}`,
    `틈새 태그 (5~8개): ${nicheHashtags.slice(0, 8).join(', ')}`,
    `권장: 인기 태그 3개 + 틈새 태그 5개 조합 (총 8개 이내)`,
  ];
  return lines.join('\n');
}

/**
 * DB 저장
 */
async function saveHashtagReport(report: HashtagReport): Promise<void> {
  try {
    await pgPool.run('blog', `
      INSERT INTO blog.hashtag_trends
        (category, analyzed_at, top_hashtags, niche_hashtags, recommendations_json, strategy)
      VALUES ($1, NOW(), $2, $3, $4, $5)
      ON CONFLICT (category, DATE(analyzed_at))
      DO UPDATE SET
        top_hashtags = EXCLUDED.top_hashtags,
        niche_hashtags = EXCLUDED.niche_hashtags,
        recommendations_json = EXCLUDED.recommendations_json,
        strategy = EXCLUDED.strategy,
        analyzed_at = NOW()
    `, [
      report.category,
      JSON.stringify(report.topHashtags),
      JSON.stringify(report.nicheHashtags),
      JSON.stringify(report.recommendations),
      report.strategy,
    ]);
  } catch (e) {
    console.warn('[해시태그분석] DB 저장 실패 (테이블 없을 수 있음):', e.message);
  }
}

/**
 * 메인: 특정 키워드 해시태그 트렌드 분석
 */
export async function analyzeHashtagTrend(keyword: string): Promise<HashtagScore | null> {
  const auth = await loadInstagramToken();
  if (!auth) {
    console.warn('[해시태그분석] 인스타 토큰 없음 — 스킵');
    return null;
  }

  try {
    const hashtagId = await getHashtagId(keyword, auth.igUserId, auth.token);
    if (!hashtagId) {
      console.warn(`[해시태그분석] 해시태그 ID 조회 실패: #${keyword}`);
      return null;
    }

    const media = await getHashtagRecentMedia(hashtagId, auth.igUserId, auth.token);
    const { avgLikes, avgComments, engagementScore } = calcEngagementScore(media);
    const trend = analyzeTrend(media);

    return {
      hashtag: keyword,
      mediaCount: media.length,
      avgLikes,
      avgComments,
      engagementScore,
      trend,
    };
  } catch (e) {
    console.warn(`[해시태그분석] #${keyword} 분석 실패:`, e.message);
    return null;
  }
}

/**
 * 카테고리 전체 해시태그 분석 + 추천
 */
export async function analyzeHashtagsForCategory(category: string): Promise<HashtagReport | null> {
  const seeds = CATEGORY_HASHTAGS[category];
  if (!seeds) {
    console.warn(`[해시태그분석] 지원하지 않는 카테고리: ${category}`);
    return null;
  }

  console.log(`[해시태그분석] 카테고리 분석 시작: ${category} (${seeds.length}개 시드)`);

  const auth = await loadInstagramToken();
  if (!auth) {
    // 토큰 없으면 시드 기반 기본 추천만
    console.warn('[해시태그분석] 인스타 토큰 없음 — 시드 기반 기본 추천 반환');
    const report: HashtagReport = {
      category,
      analyzedAt: new Date().toISOString(),
      recommendations: [],
      topHashtags: seeds.slice(0, 5),
      nicheHashtags: seeds.slice(5),
      strategy: buildHashtagStrategy(category, seeds.slice(0, 5), seeds.slice(5)),
    };
    await saveHashtagReport(report);
    return report;
  }

  // API로 각 해시태그 분석 (순차 — rate limit)
  const scores: HashtagScore[] = [];
  for (const seed of seeds) {
    const score = await analyzeHashtagTrend(seed);
    if (score) scores.push(score);
    // API rate limit: 초당 1개
    await new Promise(r => setTimeout(r, 1100));
  }

  // 참여율 기준 정렬
  const sorted = scores.sort((a, b) => b.engagementScore - a.engagementScore);

  // 인기 태그 (참여율 상위) vs 틈새 태그 (참여율 중간~하위 + rising)
  const topHashtags = sorted.filter(s => s.engagementScore > 0).slice(0, 5).map(s => s.hashtag);
  const nicheHashtags = sorted
    .filter(s => s.trend === 'rising' || (s.engagementScore > 0 && s.mediaCount < 10))
    .slice(0, 8)
    .map(s => s.hashtag);

  // 빈 경우 시드로 폴백
  const finalTop = topHashtags.length > 0 ? topHashtags : seeds.slice(0, 5);
  const finalNiche = nicheHashtags.length > 0 ? nicheHashtags : seeds.slice(5);

  const report: HashtagReport = {
    category,
    analyzedAt: new Date().toISOString(),
    recommendations: sorted,
    topHashtags: finalTop,
    nicheHashtags: finalNiche,
    strategy: buildHashtagStrategy(category, finalTop, finalNiche),
  };

  await saveHashtagReport(report);
  console.log(`[해시태그분석] 완료 — 인기 ${finalTop.length}개, 틈새 ${finalNiche.length}개`);
  return report;
}

/**
 * 최신 해시태그 추천 조회 (social.ts / insta-crosspost.ts에서 활용)
 */
export async function getRecommendedHashtags(category: string): Promise<string[]> {
  try {
    const rows = await pgPool.query('blog', `
      SELECT top_hashtags, niche_hashtags
      FROM blog.hashtag_trends
      WHERE category = $1
        AND analyzed_at >= CURRENT_DATE - INTERVAL '7 days'
      ORDER BY analyzed_at DESC
      LIMIT 1
    `, [category]);

    if (!rows?.length) {
      // DB에 없으면 시드 반환
      return CATEGORY_HASHTAGS[category]?.slice(0, 8) || [];
    }

    const top = rows[0].top_hashtags || [];
    const niche = rows[0].niche_hashtags || [];
    return [...top.slice(0, 3), ...niche.slice(0, 5)];
  } catch {
    return CATEGORY_HASHTAGS[category]?.slice(0, 8) || [];
  }
}

module.exports = {
  analyzeHashtagTrend,
  analyzeHashtagsForCategory,
  getRecommendedHashtags,
};
