'use strict';

/**
 * bots/blog/lib/omnichannel/platform-variant-builder.ts
 *
 * Campaign + Strategy에서 채널별 platform_variant를 독립 생성.
 * 네이버 포스트 여부와 무관하게 strategy_native 콘텐츠를 만든다.
 */

const pgPool = require('../../../../packages/core/lib/pg-pool');
const crypto = require('crypto');
const kst = require('../../../../packages/core/lib/kst');
const { buildTrackingLink } = require('./revenue-attribution.ts');
const { writeInstagramNativeVariant } = require('./instagram-native-writer.ts');
const { writeFacebookNativeVariant } = require('./facebook-native-writer.ts');
const { ensureMarketingOsSchema } = require('./marketing-os-schema.ts');

function normalizeSegment(value, fallback = 'na') {
  const normalized = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function stableDigest(input) {
  return crypto.createHash('sha1').update(String(input || ''), 'utf8').digest('hex').slice(0, 12);
}

function buildVariantId({
  campaignId = '',
  platform = '',
  strategyVersion = '',
  cycleDate = '',
} = {}) {
  const datePart = String(cycleDate || kst.today()).replace(/[^0-9]/g, '').slice(0, 8) || '00000000';
  const platformPart = normalizeSegment(platform).slice(0, 18);
  const digest = stableDigest([
    normalizeSegment(campaignId),
    platformPart,
    normalizeSegment(strategyVersion || 'unknown'),
    datePart,
  ].join('|'));
  return `var_${datePart}_${platformPart}_${digest}`;
}

/**
 * Instagram Reel variant 빌드
 */
function buildInstagramReelVariant({
  campaignId,
  brandAxis,
  objective,
  directives = {},
  strategyVersion = '',
  cycleDate = '',
}) {
  const variantId = buildVariantId({
    campaignId,
    platform: 'instagram_reel',
    strategyVersion,
    cycleDate,
  });
  const isCafe = brandAxis === 'cafe_library' || brandAxis === 'mixed';
  const tracking = buildTrackingLink({
    postId: campaignId,
    campaignId,
    variantId,
    platform: 'instagram_reel',
    postDate: kst.today(),
    variantLabel: isCafe ? 'cafe_native_reel' : 'seungho_native_reel',
    brandAxis,
    objective,
    utmNaming: directives?.attributionPolicy?.utmNaming || 'brand_axis__platform__objective',
  });
  const native = writeInstagramNativeVariant({
    campaign: {
      campaign_id: campaignId,
      brand_axis: brandAxis,
      objective,
      preferredCategory: directives?.titlePolicy?.keywordBias?.[0] || '',
    },
    directives,
    variantId,
    campaignId,
  });

  return {
    ...native,
    tracking_url: tracking.url,
    quality_score: null,
    quality_status: 'pending',
  };
}

/**
 * Facebook Page variant 빌드
 */
function buildFacebookPageVariant({ campaignId, brandAxis, objective, directives = {} }) {
  const variantId = buildVariantId({
    campaignId,
    platform: 'facebook_page',
    strategyVersion: directives?.strategyVersion || '',
    cycleDate: directives?.cycleDate || '',
  });
  const isCafe = brandAxis === 'cafe_library' || brandAxis === 'mixed';
  const tracking = buildTrackingLink({
    postId: campaignId,
    campaignId,
    variantId,
    platform: 'facebook_page',
    postDate: kst.today(),
    variantLabel: isCafe ? 'cafe_native_page' : 'seungho_native_page',
    brandAxis,
    objective,
    utmNaming: directives?.attributionPolicy?.utmNaming || 'brand_axis__platform__objective',
  });
  const native = writeFacebookNativeVariant({
    campaign: {
      campaign_id: campaignId,
      brand_axis: brandAxis,
      objective,
    },
    directives,
    variantId,
    campaignId,
  });

  return {
    ...native,
    tracking_url: tracking.url,
    quality_score: null,
    quality_status: 'pending',
  };
}

/**
 * Campaign에서 플랫폼별 variant를 생성하고 DB에 저장.
 */
async function buildPlatformVariants({
  campaign,
  directives = {},
  dryRun = false,
  strategyVersion = '',
  cycleDate = '',
  campaignKey = '',
}) {
  if (!dryRun) {
    await ensureMarketingOsSchema();
  }
  const { campaign_id: campaignId, brand_axis: brandAxis, objective } = campaign;
  const variants = [];
  const variantDirectives = {
    ...directives,
    strategyVersion: strategyVersion || directives?.strategyVersion || '',
    cycleDate: cycleDate || directives?.cycleDate || '',
    campaignKey: campaignKey || directives?.campaignKey || '',
  };

  // 인스타그램 릴스 variant
  const instagramVariant = buildInstagramReelVariant({
    campaignId,
    brandAxis,
    objective,
    directives: variantDirectives,
    strategyVersion: variantDirectives.strategyVersion,
    cycleDate: variantDirectives.cycleDate,
  });
  variants.push(instagramVariant);

  // 페이스북 페이지 variant
  const facebookVariant = buildFacebookPageVariant({
    campaignId,
    brandAxis,
    objective,
    directives: variantDirectives,
  });
  variants.push(facebookVariant);

  if (!dryRun) {
    for (const v of variants) {
      await pgPool.query('blog', `
        INSERT INTO blog.marketing_platform_variants
          (variant_id, campaign_id, platform, source_mode, title, body, caption,
           hashtags, cta, asset_refs, tracking_url, quality_score, quality_status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
        ON CONFLICT (variant_id) DO UPDATE SET
          title = EXCLUDED.title,
          body = EXCLUDED.body,
          caption = EXCLUDED.caption,
          hashtags = EXCLUDED.hashtags,
          cta = EXCLUDED.cta,
          asset_refs = COALESCE(EXCLUDED.asset_refs, blog.marketing_platform_variants.asset_refs),
          tracking_url = EXCLUDED.tracking_url,
          quality_score = EXCLUDED.quality_score,
          quality_status = EXCLUDED.quality_status,
          updated_at = NOW()
      `, [
        v.variant_id,
        v.campaign_id,
        v.platform,
        v.source_mode,
        v.title,
        v.body,
        v.caption,
        v.hashtags,
        v.cta,
        v.asset_refs ? JSON.stringify(v.asset_refs) : null,
        v.tracking_url,
        v.quality_score,
        v.quality_status,
      ]);
    }
  }

  console.log(`[variant-builder] ${variants.length}개 variant 생성 (campaign=${campaignId} dryRun=${dryRun})`);
  return variants;
}

module.exports = {
  buildPlatformVariants,
  buildInstagramReelVariant,
  buildFacebookPageVariant,
  buildVariantId,
};
