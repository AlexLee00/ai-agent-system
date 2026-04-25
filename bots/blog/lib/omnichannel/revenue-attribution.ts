'use strict';

/**
 * bots/blog/lib/omnichannel/revenue-attribution.ts
 *
 * campaign/variant 단위 UTM 링크 생성 및 귀인 헬퍼.
 * 기존 naver/instagram/facebook 3축과
 * instagram_reel/feed/story, facebook_page 세분화를 동시에 지원한다.
 */

function getSkaBaseUrl() {
  return process.env.SKA_RESERVATION_URL || 'https://app.studycafe.com/reservation';
}

function sanitizeToken(value = '', fallback = 'na', maxLen = 48) {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  const token = cleaned || fallback;
  return token.slice(0, maxLen);
}

function normalizeAttributionPlatform(platform = '') {
  const raw = String(platform || '').trim().toLowerCase();
  if (!raw) return 'naver_blog';
  if (raw === 'naver') return 'naver_blog';
  if (raw === 'instagram') return 'instagram_reel';
  if (raw === 'facebook') return 'facebook_page';
  return raw;
}

function resolveUtmSource(platform = '') {
  const normalized = normalizeAttributionPlatform(platform);
  if (normalized.startsWith('instagram')) return 'instagram';
  if (normalized.startsWith('facebook')) return 'facebook';
  if (normalized.startsWith('naver')) return 'naver';
  return sanitizeToken(normalized, 'social', 24);
}

function resolveUtmMedium(platform = '') {
  const normalized = normalizeAttributionPlatform(platform);
  if (normalized === 'naver_blog') return 'blog';
  if (normalized === 'instagram_reel') return 'reel';
  if (normalized === 'instagram_feed') return 'feed';
  if (normalized === 'instagram_story') return 'story';
  if (normalized === 'facebook_page') return 'post';
  return 'social';
}

function buildUtmCampaign({
  postId = '',
  campaignId = '',
  platform = '',
  brandAxis = 'mixed',
  objective = 'awareness',
  utmNaming = 'brand_axis__platform__objective',
} = {}) {
  const normalizedPlatform = normalizeAttributionPlatform(platform);
  const safeBrand = sanitizeToken(brandAxis, 'mixed', 24);
  const safePlatform = sanitizeToken(normalizedPlatform, 'platform', 28);
  const safeObjective = sanitizeToken(objective, 'awareness', 24);
  const safePostId = sanitizeToken(postId, 'post', 30);
  const safeCampaignId = sanitizeToken(campaignId, '', 30);

  if (utmNaming === 'brand_axis__platform__objective') {
    return `${safeBrand}__${safePlatform}__${safeObjective}`;
  }
  if (safeCampaignId) return `camp_${safeCampaignId}`;
  return `post_${safePostId}`;
}

function buildAttributionKey({
  campaignId = '',
  variantId = '',
  postId = '',
  platform = '',
  date = '',
} = {}) {
  const parts = [
    sanitizeToken(campaignId, 'camp'),
    sanitizeToken(variantId, 'variant'),
    sanitizeToken(postId, 'post'),
    sanitizeToken(normalizeAttributionPlatform(platform), 'platform'),
    sanitizeToken(date || '', 'date'),
  ];
  return parts.join('__');
}

function buildTrackingLink({
  postId = '',
  platform = '',
  postDate = '',
  variantLabel = '',
  campaignId = '',
  variantId = '',
  brandAxis = 'mixed',
  objective = 'awareness',
  utmNaming = 'brand_axis__platform__objective',
  baseUrl = '',
} = {}) {
  const normalizedPlatform = normalizeAttributionPlatform(platform);
  const utmSource = resolveUtmSource(normalizedPlatform);
  const utmMedium = resolveUtmMedium(normalizedPlatform);
  const utmCampaign = buildUtmCampaign({
    postId,
    campaignId,
    platform: normalizedPlatform,
    brandAxis,
    objective,
    utmNaming,
  });
  const utmContentParts = [
    sanitizeToken(variantId || postId, 'content', 32),
    postDate ? sanitizeToken(postDate, '', 16) : '',
    variantLabel ? sanitizeToken(variantLabel, '', 32) : '',
  ].filter(Boolean);
  const utmContent = utmContentParts.join('__');

  const params = new URLSearchParams({
    utm_source: utmSource,
    utm_medium: utmMedium,
    utm_campaign: utmCampaign,
    utm_content: utmContent,
  });

  return {
    url: `${baseUrl || getSkaBaseUrl()}?${params.toString()}`,
    utm_source: utmSource,
    utm_medium: utmMedium,
    utm_campaign: utmCampaign,
    utm_content: utmContent,
    normalizedPlatform,
    attribution_key: buildAttributionKey({
      campaignId,
      variantId,
      postId,
      platform: normalizedPlatform,
      date: postDate,
    }),
  };
}

/**
 * low-confidence에서는 전략을 급격히 바꾸지 않기 위한 bounded decay.
 * 반환값은 0.4~1.0 범위 multiplier.
 */
function computeLowConfidenceDecay(confidence = 0, gapCount = 0, threshold = 0.6) {
  const conf = Math.max(0, Math.min(1, Number(confidence || 0)));
  const gaps = Math.max(0, Number(gapCount || 0));
  if (conf >= threshold) return 1;
  const confidencePenalty = Math.max(0, threshold - conf) * 0.8;
  const gapPenalty = Math.min(0.4, gaps * 0.05);
  const multiplier = 1 - confidencePenalty - gapPenalty;
  return Math.max(0.4, Number(multiplier.toFixed(4)));
}

module.exports = {
  normalizeAttributionPlatform,
  resolveUtmSource,
  resolveUtmMedium,
  buildUtmCampaign,
  buildAttributionKey,
  buildTrackingLink,
  computeLowConfidenceDecay,
};
