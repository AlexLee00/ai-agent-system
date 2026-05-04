'use strict';

/**
 * bots/blog/lib/attribution-tracker.ts
 * UTM 파라미터 기반 추적 링크 생성 + 발행 attribution 기록
 *
 * Phase 2: 포스팅별 고유 UTM 링크 → 스카팀 유입 추적
 * Kill Switch: BLOG_REVENUE_CORRELATION_ENABLED=true 일 때만 활성
 */

const { buildTrackingLink } = require('./omnichannel/revenue-attribution.ts');

function isEnabled() {
  return process.env.BLOG_REVENUE_CORRELATION_ENABLED === 'true';
}

function getSkaBaseUrl() {
  return process.env.SKA_RESERVATION_URL || 'https://app.studycafe.com/reservation';
}

/**
 * 포스팅별 UTM 추적 링크 생성
 * 글 본문 CTA에 삽입하여 스카팀 예약 유입 추적
 * @param {string} postId
 * @param {'naver'|'instagram'|'facebook'|'naver_blog'|'instagram_reel'|'instagram_feed'|'instagram_story'|'facebook_page'} platform
 * @param {string} [postDate]
 * @param {string} [variantLabel]
 * @param {object} [context]
 */
function generateTrackingLink(postId: string, platform: string, postDate = '', variantLabel = '', context: Record<string, unknown> = {}) {
  return buildTrackingLink({
    postId: String(postId || ''),
    platform,
    postDate,
    variantLabel,
    campaignId: context?.campaignId || '',
    variantId: context?.variantId || '',
    brandAxis: context?.brandAxis || 'mixed',
    objective: context?.objective || 'awareness',
    utmNaming: context?.utmNaming || 'brand_axis__platform__objective',
    baseUrl: getSkaBaseUrl(),
  });
}

/**
 * 발행 attribution 레코드 초기 생성
 * @param {string} postId
 * @param {string} postTitle
 * @param {string} postUrl
 * @param {Date} postPublishedAt
 * @param {'naver'|'instagram'|'facebook'} platform
 */
async function recordPublishAttribution(postId, postTitle, postUrl, postPublishedAt, platform) {
  if (!isEnabled()) return;
  try {
    const pgPool = require('../../../packages/core/lib/pg-pool');
    await pgPool.query('blog', `
      INSERT INTO blog.post_revenue_attribution
        (post_id, post_url, post_title, post_platform, post_published_at,
         attribution_method, computed_at)
      VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
      ON CONFLICT DO NOTHING
    `, [postId, postUrl, postTitle, platform, postPublishedAt]);
  } catch {
    // attribution 기록 실패는 발행을 막지 않음
  }
}

/**
 * UTM 방문 건수 업데이트 (스카팀 데이터 수신 시)
 * @param {string} campaign
 * @param {number} visits
 */
async function updateUtmVisits(campaign, visits) {
  if (!isEnabled()) return;
  try {
    const pgPool = require('../../../packages/core/lib/pg-pool');
    await pgPool.query('blog', `
      UPDATE blog.post_revenue_attribution
      SET utm_visits = utm_visits + $1
      WHERE post_id IN (
        SELECT post_id FROM blog.post_revenue_attribution
        WHERE post_id LIKE $2
        ORDER BY post_published_at DESC
        LIMIT 1
      )
    `, [visits, `%${campaign}%`]);
  } catch {
    // 실패 무시
  }
}

module.exports = {
  generateTrackingLink,
  recordPublishAttribution,
  updateUtmVisits,
  getSkaBaseUrl,
};
