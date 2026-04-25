'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');

jest.mock('../../../packages/core/lib/pg-pool', () => ({
  query: jest.fn().mockResolvedValue([]),
  run: jest.fn().mockResolvedValue(undefined),
}));

const pgPool = require('../../../packages/core/lib/pg-pool');
const assetMemory = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/omnichannel/asset-memory.ts'));

describe('omnichannel asset-memory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pgPool.query.mockResolvedValue([]);
    pgPool.run.mockResolvedValue(undefined);
  });

  test('buildCreativeFingerprint — platform/hook/cta/hashtag cluster 포함', () => {
    const fingerprint = assetMemory.buildCreativeFingerprint({
      platform: 'instagram_reel',
      source_mode: 'strategy_native',
      caption: '오늘 집중 루틴 3가지 알려드릴까요?',
      cta: '지금 스터디룸 예약하고 자리 선점해보세요',
      hashtags: ['#커피랑도서관', '#서현역스터디카페', '#집중루틴'],
    });

    expect(fingerprint).toContain('instagram_reel');
    expect(fingerprint).toContain('question');
    expect(fingerprint).toContain('conversion');
    expect(fingerprint).toContain('커피랑도서관');
  });

  test('recordMarketingAssetOutcome — variant_id 기준 upsert 수행', async () => {
    const result = await assetMemory.recordMarketingAssetOutcome({
      variant: {
        variant_id: 'var_asset_1',
        campaign_id: 'camp_1',
        platform: 'facebook_page',
        brand_axis: 'cafe_library',
        objective: 'engagement',
        source_mode: 'strategy_native',
        caption: '서현역 근처에서 공부 루틴 어떻게 잡으세요?',
        hashtags: ['#커피랑도서관', '#분당서현'],
      },
      qualityScore: 82.5,
      gateResult: 'passed',
      publishStatus: 'published',
      metadata: { smoke: true },
    });

    expect(result.ok).toBe(true);
    expect(result.variantId).toBe('var_asset_1');
    expect(pgPool.query).toHaveBeenCalled();
  });

  test('detectFormatSaturation — top format 과집중 감지', async () => {
    pgPool.query.mockResolvedValueOnce([
      {
        platform: 'instagram_reel',
        creative_fingerprint: 'instagram_reel::strategy_native::question::conversion::a',
        samples: 8,
        success_count: 7,
        fail_count: 1,
        avg_quality: 81,
      },
      {
        platform: 'instagram_reel',
        creative_fingerprint: 'instagram_reel::strategy_native::story::engagement::b',
        samples: 2,
        success_count: 1,
        fail_count: 1,
        avg_quality: 63,
      },
      {
        platform: 'facebook_page',
        creative_fingerprint: 'facebook_page::strategy_native::story::engagement::c',
        samples: 3,
        success_count: 2,
        fail_count: 1,
        avg_quality: 71,
      },
    ]);

    const result = await assetMemory.detectFormatSaturation({
      days: 14,
      threshold: 0.6,
    });

    const instagram = result.find((item) => item.platform === 'instagram_reel');
    expect(instagram).toBeTruthy();
    expect(instagram.saturated).toBe(true);
    expect(instagram.saturationRatio).toBeGreaterThanOrEqual(0.6);
  });
});

