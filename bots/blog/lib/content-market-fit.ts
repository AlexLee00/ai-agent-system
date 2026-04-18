'use strict';

/**
 * bots/blog/lib/content-market-fit.ts
 * Content-Market Fit 측정 (Animalz 프레임워크)
 *
 * Phase 3: Reach × Resonance × Retention 지표
 * - Reach    (30%): 조회수 / 팔로워 * 100
 * - Resonance(50%): (좋아요+댓글+공유) / 조회수 * 100
 * - Retention(20%): 이웃 증가율 + 재방문율
 */

const pgPool = require('../../../packages/core/lib/pg-pool');

const GRADE_THRESHOLDS = { A: 80, B: 60, C: 40, D: 20 };

function scoreToGrade(score) {
  if (score >= GRADE_THRESHOLDS.A) return 'A';
  if (score >= GRADE_THRESHOLDS.B) return 'B';
  if (score >= GRADE_THRESHOLDS.C) return 'C';
  if (score >= GRADE_THRESHOLDS.D) return 'D';
  return 'F';
}

function generateHints(reach, resonance, retention) {
  const hints = [];
  if (reach < 20) hints.push('조회수 확대: 제목 SEO 강화 또는 발행 시간 최적화 필요');
  if (resonance < 5) hints.push('참여도 향상: 질문형 CTA, 댓글 유도, 공유 버튼 노출 강화');
  if (retention < 10) hints.push('재방문 유도: 시리즈 콘텐츠, 이웃 추가 유도 강화');
  if (hints.length === 0) hints.push('전체 지표 양호 — 현재 전략 유지');
  return hints;
}

/**
 * 특정 포스팅의 Content-Market Fit 점수 계산
 * @param {string} postId blog.posts.id
 * @param {number} daysAfter 측정 기간
 */
async function calculateContentMarketFit(postId, daysAfter = 14) {
  try {
    const post = await pgPool.get('blog', `
      SELECT id, views, likes, comments, ctr,
             COALESCE(published_at, publish_date, created_at) AS published_at
      FROM blog.posts
      WHERE id = $1 OR id::text = $1
    `, [postId]);

    if (!post) return null;

    const followerCount = await getApproxFollowerCount();
    const views = Number(post.views || 0);
    const likes = Number(post.likes || 0);
    const comments = Number(post.comments || 0);

    // 채널별 공유 수 (channel_performance)
    const channelRow = await pgPool.query('blog', `
      SELECT COALESCE(SUM(shares), 0) AS total_shares
      FROM blog.channel_performance
      WHERE post_id = $1
    `, [post.id]);
    const shares = Number(channelRow?.[0]?.total_shares || 0);

    // Reach: 조회수 / 팔로워 * 100 (팔로워 없으면 절대값 기준)
    const reach = followerCount > 0
      ? Math.min((views / followerCount) * 100, 100)
      : Math.min(views / 10, 100); // 1000조회=100점

    // Resonance: 참여율
    const resonance = views > 0
      ? Math.min(((likes + comments + shares) / views) * 100, 100)
      : 0;

    // Retention: 간이 지표 (CTR 기반)
    const retention = Math.min(Number(post.ctr || 0) * 100, 100);

    const overall = reach * 0.3 + resonance * 0.5 + retention * 0.2;
    const grade = scoreToGrade(overall);
    const hints = generateHints(reach, resonance, retention);

    // DB 저장
    await pgPool.query('blog', `
      INSERT INTO blog.content_market_fit
        (post_id, post_platform, measurement_days, reach_score, resonance_score,
         retention_score, overall_score, grade, views, likes, comments, shares,
         follower_count_at_publish, measured_at)
      VALUES ($1, 'naver', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
      ON CONFLICT DO NOTHING
    `, [
      String(post.id), daysAfter,
      Number(reach.toFixed(2)), Number(resonance.toFixed(2)), Number(retention.toFixed(2)),
      Number(overall.toFixed(2)), grade,
      views, likes, comments, shares, followerCount,
    ]);

    return {
      post_id: String(post.id),
      reach: Number(reach.toFixed(2)),
      resonance: Number(resonance.toFixed(2)),
      retention: Number(retention.toFixed(2)),
      overall_score: Number(overall.toFixed(2)),
      grade,
      improvement_hints: hints,
    };
  } catch (err) {
    console.warn('[content-market-fit] 계산 실패:', err.message);
    return null;
  }
}

/**
 * 최근 N일 전체 포스팅의 평균 CMF 점수
 */
async function getAverageCmfScore(days = 30) {
  try {
    const rows = await pgPool.query('blog', `
      SELECT AVG(overall_score) AS avg_score, COUNT(*) AS measured_count
      FROM blog.content_market_fit
      WHERE measured_at > NOW() - ($1::text || ' days')::interval
    `, [days]);
    return {
      avg_score: Number(rows?.[0]?.avg_score || 0),
      measured_count: Number(rows?.[0]?.measured_count || 0),
    };
  } catch {
    return { avg_score: 0, measured_count: 0 };
  }
}

/**
 * 최근 미측정 포스팅 일괄 CMF 계산 (evoltion-cycle에서 호출)
 */
async function computePendingCmf(daysAfter = 14) {
  let processed = 0;
  try {
    const posts = await pgPool.query('blog', `
      SELECT p.id::text AS post_id
      FROM blog.posts p
      LEFT JOIN blog.content_market_fit c ON c.post_id = p.id::text
      WHERE p.status = 'published'
        AND COALESCE(p.published_at, p.publish_date, p.created_at) < NOW() - ($1::text || ' days')::interval
        AND COALESCE(p.published_at, p.publish_date, p.created_at) > NOW() - '60 days'::interval
        AND c.id IS NULL
      ORDER BY COALESCE(p.published_at, p.created_at) DESC
      LIMIT 20
    `, [daysAfter + 1]);

    for (const row of (posts || [])) {
      const result = await calculateContentMarketFit(row.post_id, daysAfter);
      if (result) processed++;
    }
  } catch (err) {
    console.warn('[content-market-fit] 일괄 계산 실패:', err.message);
  }
  return processed;
}

// 팔로워 수 근사치 (blog.posts 통계 기반)
async function getApproxFollowerCount() {
  try {
    const rows = await pgPool.query('blog', `
      SELECT AVG(views) AS avg_views
      FROM blog.posts
      WHERE status = 'published'
        AND views > 0
        AND COALESCE(published_at, created_at) > NOW() - '30 days'::interval
    `);
    // 평균 조회수 * 10을 팔로워 근사치로 사용 (임시)
    return Math.max(Number(rows?.[0]?.avg_views || 0) * 10, 100);
  } catch {
    return 500;
  }
}

module.exports = {
  calculateContentMarketFit,
  getAverageCmfScore,
  computePendingCmf,
};
