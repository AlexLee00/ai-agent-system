'use strict';

/**
 * bots/blog/lib/omnichannel/campaign-planner.ts
 *
 * Sense Engine + 최신 전략에서 marketing_campaigns + marketing_platform_variants를 생성.
 * 네이버 포스트에 종속되지 않는 strategy_native 독립 캠페인 경로.
 */

const path = require('path');
const env = require('../../../../packages/core/lib/env');
const pgPool = require('../../../../packages/core/lib/pg-pool');
const kst = require('../../../../packages/core/lib/kst');
const { loadStrategyBundle } = require('../strategy-loader.ts');
const { buildPlatformVariants } = require('./platform-variant-builder.ts');
const { enqueueMarketingVariants } = require('./publish-queue.ts');

/** 간단한 ulid-like ID 생성 (외부 의존 없이) */
function generateId(prefix = 'camp') {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}_${ts}_${rand}`;
}

/**
 * 현재 전략 + sense 신호로 campaign을 생성하고 DB에 저장.
 * @param {object} opts
 * @param {string} [opts.brandAxis] - 'cafe_library' | 'seungho_dad' | 'mixed'
 * @param {string} [opts.objective] - 'awareness' | 'engagement' | 'conversion' | 'retention' | 'brand_trust'
 * @param {object} [opts.sourceSignal] - sense-engine 출력
 * @param {boolean} [opts.dryRun]
 */
async function createMarketingCampaignFromSignals({
  brandAxis = 'cafe_library',
  objective = 'awareness',
  sourceSignal = null,
  dryRun = false,
} = {}) {
  const { plan, directives } = loadStrategyBundle();
  const strategyVersion = String(plan?.weekOf || kst.today());
  const campaignId = generateId('camp');

  const campaign = {
    campaign_id: campaignId,
    brand_axis: brandAxis,
    objective,
    source_signal: sourceSignal ? JSON.stringify(sourceSignal) : null,
    strategy_version: strategyVersion,
    status: 'active',
  };

  if (!dryRun) {
    await pgPool.query('blog', `
      INSERT INTO blog.marketing_campaigns
        (campaign_id, brand_axis, objective, source_signal, strategy_version, status)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6)
      ON CONFLICT (campaign_id) DO NOTHING
    `, [
      campaign.campaign_id,
      campaign.brand_axis,
      campaign.objective,
      campaign.source_signal,
      campaign.strategy_version,
      campaign.status,
    ]);
  }

  console.log(`[campaign-planner] 캠페인 생성: ${campaignId} brand=${brandAxis} obj=${objective} dryRun=${dryRun}`);

  const variants = await buildPlatformVariants({
    campaign,
    directives,
    dryRun,
  });

  const scheduled = await enqueueMarketingVariants({
    campaignId,
    variants,
    dryRun,
  });

  return {
    campaignId,
    campaign,
    variants,
    scheduled,
  };
}

/**
 * 오늘 활성 캠페인 수 조회
 */
async function getTodayActiveCampaignCount() {
  try {
    const rows = await pgPool.query('blog', `
      SELECT COUNT(*)::int AS cnt
      FROM blog.marketing_campaigns
      WHERE DATE(created_at AT TIME ZONE 'Asia/Seoul') = CURRENT_DATE
        AND status = 'active'
    `);
    return rows?.[0]?.cnt || 0;
  } catch {
    return 0;
  }
}

/**
 * 오늘 strategy_native 발행 성공 수 (source_mode 기준)
 */
async function getTodayNativePublishCount(platform = null) {
  try {
    const platformClause = platform ? `AND platform = $2` : '';
    const params = platform ? [kst.today(), platform] : [kst.today()];
    const rows = await pgPool.query('blog', `
      SELECT COUNT(*)::int AS cnt
      FROM blog.publish_log
      WHERE DATE(created_at AT TIME ZONE 'Asia/Seoul') = $1
        AND status = 'success'
        AND source_mode = 'strategy_native'
        AND COALESCE(dry_run, false) = false
        ${platformClause}
    `, params);
    return rows?.[0]?.cnt || 0;
  } catch {
    return 0;
  }
}

module.exports = {
  createMarketingCampaignFromSignals,
  getTodayActiveCampaignCount,
  getTodayNativePublishCount,
};
