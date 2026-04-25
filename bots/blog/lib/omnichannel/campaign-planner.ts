'use strict';

/**
 * bots/blog/lib/omnichannel/campaign-planner.ts
 *
 * Sense Engine + 최신 전략에서 marketing_campaigns + marketing_platform_variants를 생성.
 * 네이버 포스트에 종속되지 않는 strategy_native 독립 캠페인 경로.
 */

const path = require('path');
const crypto = require('crypto');
const env = require('../../../../packages/core/lib/env');
const pgPool = require('../../../../packages/core/lib/pg-pool');
const kst = require('../../../../packages/core/lib/kst');
const { loadStrategyBundle } = require('../strategy-loader.ts');
const { buildPlatformVariants } = require('./platform-variant-builder.ts');
const { enqueueMarketingVariants } = require('./publish-queue.ts');
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

function buildCampaignKey({
  brandAxis = 'cafe_library',
  objective = 'awareness',
  strategyVersion = '',
  cycleDate = '',
} = {}) {
  return [
    normalizeSegment(brandAxis),
    normalizeSegment(objective),
    normalizeSegment(strategyVersion || 'unknown'),
    normalizeSegment(cycleDate || kst.today()),
  ].join('__');
}

function buildCampaignId({
  brandAxis = 'cafe_library',
  objective = 'awareness',
  strategyVersion = '',
  cycleDate = '',
} = {}) {
  const datePart = String(cycleDate || kst.today()).replace(/[^0-9]/g, '').slice(0, 8) || '00000000';
  const brandPart = normalizeSegment(brandAxis).slice(0, 16);
  const objectivePart = normalizeSegment(objective).slice(0, 16);
  const digest = stableDigest(`${brandPart}|${objectivePart}|${normalizeSegment(strategyVersion || 'unknown')}|${datePart}`);
  return `camp_${datePart}_${brandPart}_${objectivePart}_${digest}`;
}

function buildScheduledSummary(scheduled = []) {
  /** @type {Record<string, {total:number, inserted:number, existing:number, queued:number, preparing:number, blocked:number, failed:number}>} */
  const summary = {};
  for (const item of (scheduled || [])) {
    const platform = String(item?.platform || 'unknown');
    if (!summary[platform]) {
      summary[platform] = {
        total: 0,
        inserted: 0,
        existing: 0,
        queued: 0,
        preparing: 0,
        blocked: 0,
        failed: 0,
      };
    }
    summary[platform].total += 1;
    if (item?.enqueue_status === 'inserted') summary[platform].inserted += 1;
    if (item?.enqueue_status === 'existing') summary[platform].existing += 1;
    if (item?.status === 'queued') summary[platform].queued += 1;
    if (item?.status === 'preparing') summary[platform].preparing += 1;
    if (item?.status === 'blocked') summary[platform].blocked += 1;
    if (item?.status === 'failed') summary[platform].failed += 1;
  }
  return summary;
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
  await ensureMarketingOsSchema();
  const { plan, directives } = loadStrategyBundle();
  const cycleDate = kst.today();
  const strategyVersion = String(plan?.weekOf || kst.today());
  const campaignKey = buildCampaignKey({
    brandAxis,
    objective,
    strategyVersion,
    cycleDate,
  });
  const campaignId = buildCampaignId({
    brandAxis,
    objective,
    strategyVersion,
    cycleDate,
  });

  let campaign = {
    campaign_id: campaignId,
    campaign_key: campaignKey,
    brand_axis: brandAxis,
    objective,
    source_signal: sourceSignal ? JSON.stringify(sourceSignal) : null,
    strategy_version: strategyVersion,
    status: 'active',
  };

  if (!dryRun) {
    const rows = await pgPool.query('blog', `
      INSERT INTO blog.marketing_campaigns
        (campaign_id, brand_axis, objective, source_signal, strategy_version, status)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6)
      ON CONFLICT (campaign_id) DO UPDATE SET
        brand_axis = EXCLUDED.brand_axis,
        objective = EXCLUDED.objective,
        source_signal = COALESCE(EXCLUDED.source_signal, blog.marketing_campaigns.source_signal),
        strategy_version = EXCLUDED.strategy_version,
        status = EXCLUDED.status,
        updated_at = NOW()
      RETURNING campaign_id, brand_axis, objective, source_signal, strategy_version, status
    `, [
      campaign.campaign_id,
      campaign.brand_axis,
      campaign.objective,
      campaign.source_signal,
      campaign.strategy_version,
      campaign.status,
    ]);
    const row = rows?.[0];
    if (row) {
      campaign = {
        ...campaign,
        campaign_id: row.campaign_id,
        brand_axis: row.brand_axis,
        objective: row.objective,
        source_signal: row.source_signal ? JSON.stringify(row.source_signal) : campaign.source_signal,
        strategy_version: row.strategy_version,
        status: row.status,
      };
    }
  }

  console.log(`[campaign-planner] 캠페인 준비: ${campaignId} key=${campaignKey} brand=${brandAxis} obj=${objective} dryRun=${dryRun}`);

  const variants = await buildPlatformVariants({
    campaign,
    directives,
    dryRun,
    strategyVersion,
    cycleDate,
    campaignKey,
  });

  const scheduled = await enqueueMarketingVariants({
    campaignId: campaign.campaign_id,
    variants,
    dryRun,
    strategyVersion,
    cycleDate,
    campaignKey,
  });

  const queueSummaryByPlatform = buildScheduledSummary(scheduled);

  return {
    campaignId: campaign.campaign_id,
    campaignKey,
    strategyVersion,
    cycleDate,
    campaign,
    variants,
    scheduled,
    queueSummaryByPlatform,
  };
}

/**
 * 오늘 활성 캠페인 수 조회
 */
async function getTodayActiveCampaignCount() {
  try {
    await ensureMarketingOsSchema();
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
  buildCampaignId,
  buildCampaignKey,
};
