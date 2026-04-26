'use strict';

/**
 * omnichannel campaign planner / variant builder / publish queue 테스트
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');

// ── mocks ─────────────────────────────────────────────────────────────────────
jest.mock('../../../packages/core/lib/pg-pool', () => ({
  query: jest.fn().mockResolvedValue([{ cnt: 0 }]),
  get: jest.fn().mockResolvedValue(null),
  run: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../packages/core/lib/mode-guard', () => ({
  runIfOps: jest.fn((_key, _ops, dev) => Promise.resolve(dev())),
}));
jest.mock('../../../packages/core/lib/hub-alarm-client', () => ({
  postAlarm: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../packages/core/lib/kst', () => ({
  today: jest.fn().mockReturnValue('2026-04-25'),
}));

const pgPool = require('../../../packages/core/lib/pg-pool');

// ── publish-queue ──────────────────────────────────────────────────────────────
describe('publish-queue', () => {
  const queue = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/omnichannel/publish-queue.ts'));

  beforeEach(() => {
    jest.clearAllMocks();
    pgPool.query.mockResolvedValue([{ cnt: 0 }]);
  });

  test('buildIdempotencyKey — 구성요소 포함', () => {
    const key = queue.buildIdempotencyKey({
      campaignId: 'camp_123',
      platform: 'instagram_reel',
      variantId: 'var_456',
      scheduledDate: '2026-04-25',
    });
    expect(key).toContain('camp_123');
    expect(key).toContain('instagram_reel');
    expect(key).toContain('var_456');
    expect(key).toContain('2026-04-25');
  });

  test('buildDeterministicQueueId — 동일 key는 동일 queue_id', () => {
    const idempotencyKey = queue.buildIdempotencyKey({
      campaignId: 'camp_123',
      platform: 'instagram_reel',
      variantId: 'var_456',
      scheduledDate: '2026-04-25',
    });
    const first = queue.buildDeterministicQueueId(idempotencyKey);
    const second = queue.buildDeterministicQueueId(idempotencyKey);
    expect(first).toBe(second);
    expect(first.startsWith('q_')).toBe(true);
  });

  test('enqueueMarketingVariants — dryRun 시 DB 호출 없음', async () => {
    const variants = [
      {
        variant_id: 'var_test1',
        platform: 'instagram_reel',
        campaign_id: 'camp_test',
        source_mode: 'strategy_native',
        title: '테스트 캠페인',
        caption: '테스트 캡션',
        hashtags: ['#test'],
        cta: null,
        asset_refs: null,
      },
    ];

    const jobs = await queue.enqueueMarketingVariants({
      campaignId: 'camp_test',
      variants,
      dryRun: true,
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0].platform).toBe('instagram_reel');
    expect(jobs[0].dry_run).toBe(true);
    expect(jobs[0].enqueue_status).toBe('dry_run');
    expect(jobs[0].persisted).toBe(false);
    // dryRun=true이므로 INSERT 없음
    expect(pgPool.query).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['var_test1'])
    );
  });

  test('enqueueMarketingVariants — dryRun=false 시 DB INSERT 호출', async () => {
    pgPool.query.mockResolvedValue([]);
    const variants = [
      {
        variant_id: 'var_db_test',
        platform: 'facebook_page',
        campaign_id: 'camp_db',
        source_mode: 'strategy_native',
        title: 'FB 테스트',
        caption: 'FB 캡션',
        hashtags: [],
        cta: null,
        asset_refs: null,
      },
    ];

    await queue.enqueueMarketingVariants({
      campaignId: 'camp_db',
      variants,
      dryRun: false,
    });

    expect(pgPool.query).toHaveBeenCalled();
  });

  test('getTodayQueuedCount — DB 오류 시 0 반환', async () => {
    pgPool.query.mockRejectedValueOnce(new Error('db error'));
    const count = await queue.getTodayQueuedCount('instagram_reel');
    expect(count).toBe(0);
  });
});

// ── platform-variant-builder ──────────────────────────────────────────────────
describe('platform-variant-builder', () => {
  const builder = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/omnichannel/platform-variant-builder.ts'));

  test('buildVariantId — 동일 입력이면 동일 ID', () => {
    const first = builder.buildVariantId({
      campaignId: 'camp_test',
      platform: 'instagram_reel',
      strategyVersion: '2026-W17',
      cycleDate: '2026-04-25',
    });
    const second = builder.buildVariantId({
      campaignId: 'camp_test',
      platform: 'instagram_reel',
      strategyVersion: '2026-W17',
      cycleDate: '2026-04-25',
    });
    expect(first).toBe(second);
    expect(first.startsWith('var_')).toBe(true);
  });

  test('buildInstagramReelVariant — cafe_library 브랜드 키워드 포함', () => {
    const variant = builder.buildInstagramReelVariant({
      campaignId: 'camp_test',
      brandAxis: 'cafe_library',
      objective: 'conversion',
      directives: {},
    });
    expect(variant.platform).toBe('instagram_reel');
    expect(variant.source_mode).toBe('strategy_native');
    expect(variant.caption).toContain('커피랑도서관');
    expect(Array.isArray(variant.hashtags)).toBe(true);
    expect(variant.hashtags.some(h => h.includes('스터디카페') || h.includes('커피랑도서관'))).toBe(true);
    expect(variant.tracking_url).toContain('utm_source=instagram');
    expect(variant.tracking_url).toContain('utm_campaign=');
  });

  test('buildInstagramReelVariant — seungho_dad 브랜드 키워드 포함', () => {
    const variant = builder.buildInstagramReelVariant({
      campaignId: 'camp_test2',
      brandAxis: 'seungho_dad',
      objective: 'awareness',
      directives: {},
    });
    expect(variant.caption).toContain('승호아빠');
    expect(variant.hashtags.some(h => h.includes('승호아빠') || h.includes('자동화'))).toBe(true);
  });

  test('buildFacebookPageVariant — conversion objective 예약 키워드', () => {
    const variant = builder.buildFacebookPageVariant({
      campaignId: 'camp_fb',
      brandAxis: 'cafe_library',
      objective: 'conversion',
      directives: {},
    });
    expect(variant.platform).toBe('facebook_page');
    expect(variant.source_mode).toBe('strategy_native');
    expect(variant.caption || variant.body).toBeTruthy();
    const content = (variant.caption || variant.body || '');
    expect(content.includes('예약') || content.includes('자리')).toBe(true);
    expect(variant.tracking_url).toContain('utm_source=facebook');
    expect(variant.tracking_url).toContain('utm_medium=post');
  });

  test('buildPlatformVariants — 2개 variant 생성 (dryRun)', async () => {
    pgPool.query.mockResolvedValue([]);
    const campaign = {
      campaign_id: 'camp_multi',
      brand_axis: 'cafe_library',
      objective: 'engagement',
    };
    const variants = await builder.buildPlatformVariants({
      campaign,
      directives: {},
      dryRun: true,
    });
    expect(variants).toHaveLength(2);
    const platforms = variants.map(v => v.platform);
    expect(platforms).toContain('instagram_reel');
    expect(platforms).toContain('facebook_page');
  });
});

describe('campaign-planner deterministic id', () => {
  const planner = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/omnichannel/campaign-planner.ts'));

  test('buildCampaignId — 동일 입력이면 동일 ID', () => {
    const first = planner.buildCampaignId({
      brandAxis: 'cafe_library',
      objective: 'awareness',
      strategyVersion: '2026-W17',
      cycleDate: '2026-04-25',
    });
    const second = planner.buildCampaignId({
      brandAxis: 'cafe_library',
      objective: 'awareness',
      strategyVersion: '2026-W17',
      cycleDate: '2026-04-25',
    });
    expect(first).toBe(second);
    expect(first.startsWith('camp_')).toBe(true);
  });
});
