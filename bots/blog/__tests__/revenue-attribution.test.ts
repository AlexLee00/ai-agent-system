'use strict';

/**
 * Phase 2 Revenue Attribution 테스트
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');

// pgPool mock
jest.mock('../../../packages/core/lib/pg-pool', () => ({
  query: jest.fn().mockResolvedValue([]),
  get: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../packages/core/lib/llm-keys', () => ({
  initHubConfig: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../packages/core/lib/mode-guard', () => ({
  runIfOps: jest.fn((_key, _ops, dev) => dev()),
}));
jest.mock('../../../packages/core/lib/hub-alarm-client', () => ({
  postAlarm: jest.fn().mockResolvedValue(undefined),
}));

const pgPool = require('../../../packages/core/lib/pg-pool');

// ─── ska-revenue-bridge ───────────────────────────────────────────────────────

describe('ska-revenue-bridge', () => {
  const bridge = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/ska-revenue-bridge.ts'));

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BLOG_REVENUE_CORRELATION_ENABLED;
  });

  test('isEnabled() — env 미설정 시 false', () => {
    expect(bridge.isEnabled()).toBe(false);
  });

  test('isEnabled() — true 설정 시 true', () => {
    process.env.BLOG_REVENUE_CORRELATION_ENABLED = 'true';
    expect(bridge.isEnabled()).toBe(true);
  });

  test('getTopRevenueCategories — disabled 시 빈 배열', async () => {
    const result = await bridge.getTopRevenueCategories(30);
    expect(result).toEqual([]);
  });

  test('getTopRevenueCategories — enabled 시 pgPool 조회', async () => {
    process.env.BLOG_REVENUE_CORRELATION_ENABLED = 'true';
    pgPool.query.mockResolvedValueOnce([
      { category: '홈페이지와App', avg_uplift_krw: '50000', post_count: '5' },
    ]);
    const result = await bridge.getTopRevenueCategories(30);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('홈페이지와App');
    expect(result[0].avg_uplift_krw).toBe(50000);
  });

  test('getRoiSummary — disabled 시 enabled:false', async () => {
    const result = await bridge.getRoiSummary(30);
    expect(result.enabled).toBe(false);
  });

  test('getRoiSummary — enabled 시 플랫폼별 요약 반환', async () => {
    process.env.BLOG_REVENUE_CORRELATION_ENABLED = 'true';
    pgPool.query
      .mockResolvedValueOnce([
        { post_platform: 'naver', posts_count: '10', total_uplift_krw: '500000',
          avg_uplift_krw: '50000', avg_confidence: '0.7', total_utm_visits: '100', total_conversions: '5' },
      ])
      .mockResolvedValueOnce([
        { category: '홈페이지와App', avg_uplift_krw: '50000', post_count: '5' },
      ]);
    const result = await bridge.getRoiSummary(30);
    expect(result.enabled).toBe(true);
    expect(result.by_platform).toHaveLength(1);
    expect(result.by_platform[0].platform).toBe('naver');
    expect(result.by_platform[0].posts_count).toBe(10);
    expect(result.by_platform[0].total_uplift_krw).toBe(500000);
  });

  test('correlateBlogPostsToRevenue — disabled 시 null', async () => {
    const result = await bridge.correlateBlogPostsToRevenue('2026-04-01');
    expect(result).toBeNull();
  });

  test('correlateBlogPostsToRevenue — enabled + 데이터 없으면 null', async () => {
    process.env.BLOG_REVENUE_CORRELATION_ENABLED = 'true';
    pgPool.query.mockResolvedValue([]);
    const result = await bridge.correlateBlogPostsToRevenue('2026-04-01', 7);
    expect(result).toBeNull();
  });

  test('computePendingAttributions — disabled 시 0 반환', async () => {
    const count = await bridge.computePendingAttributions();
    expect(count).toBe(0);
  });
});

// ─── attribution-tracker ─────────────────────────────────────────────────────

describe('attribution-tracker', () => {
  const tracker = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/attribution-tracker.ts'));
  const revenueAttribution = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/omnichannel/revenue-attribution.ts'));

  test('generateTrackingLink — naver 플랫폼', () => {
    const link = tracker.generateTrackingLink('post123', 'naver', '2026-04-19');
    expect(link.utm_source).toBe('naver');
    expect(link.utm_medium).toBe('blog');
    expect(link.utm_campaign).toMatch(/naver_blog/);
    expect(link.url).toContain('utm_source=naver');
  });

  test('generateTrackingLink — instagram 플랫폼', () => {
    const link = tracker.generateTrackingLink('post456', 'instagram', '2026-04-19');
    expect(link.utm_source).toBe('instagram');
    expect(link.utm_medium).toBe('reel');
    expect(link.url).toContain('utm_source=instagram');
  });

  test('generateTrackingLink — instagram_reel 세분화 플랫폼', () => {
    const link = tracker.generateTrackingLink('post456', 'instagram_reel', '2026-04-19', 'native', {
      campaignId: 'camp_1',
      variantId: 'var_1',
      brandAxis: 'cafe_library',
      objective: 'conversion',
    });
    expect(link.utm_source).toBe('instagram');
    expect(link.utm_medium).toBe('reel');
    expect(link.utm_campaign).toContain('cafe_library');
    expect(link.attribution_key).toContain('camp_1');
    expect(link.url).toContain('utm_medium=reel');
  });

  test('generateTrackingLink — facebook 플랫폼', () => {
    const link = tracker.generateTrackingLink('post789', 'facebook');
    expect(link.utm_source).toBe('facebook');
    expect(link.utm_medium).toBe('post');
  });

  test('revenue-attribution — low confidence decay bounded', () => {
    const high = revenueAttribution.computeLowConfidenceDecay(0.9, 0, 0.6);
    const low = revenueAttribution.computeLowConfidenceDecay(0.2, 5, 0.6);
    expect(high).toBe(1);
    expect(low).toBeGreaterThanOrEqual(0.4);
    expect(low).toBeLessThan(1);
  });

  test('recordPublishAttribution — disabled 시 조기 반환', async () => {
    delete process.env.BLOG_REVENUE_CORRELATION_ENABLED;
    await expect(
      tracker.recordPublishAttribution('123', '제목', 'http://url', new Date(), 'naver'),
    ).resolves.not.toThrow();
    expect(pgPool.query).not.toHaveBeenCalled();
  });
});

// ─── topic-selector Revenue-Driven 가중치 ────────────────────────────────────

describe('topic-selector adjustCategoryWeightsBySense + attributionWeights', () => {
  const { adjustCategoryWeightsBySense, fetchRevenueAttributionWeights } = require(
    path.join(env.PROJECT_ROOT, 'bots/blog/lib/topic-selector.ts'),
  );

  test('attributionWeights 없으면 기본 가중치 반환', () => {
    const weights = adjustCategoryWeightsBySense({}, null, null, {});
    expect(weights['홈페이지와App']).toBe(1);
  });

  test('attributionWeights 있으면 해당 카테고리 부스팅', () => {
    const attrWeights = { '홈페이지와App': 2, '성장과성공': 1 };
    const weights = adjustCategoryWeightsBySense({}, null, null, attrWeights);
    expect(weights['홈페이지와App']).toBe(3); // 기본 1 + 부스팅 2
    expect(weights['성장과성공']).toBe(2);    // 기본 1 + 부스팅 1
    expect(weights['도서리뷰']).toBe(1);       // 부스팅 없음
  });

  test('fetchRevenueAttributionWeights — disabled 시 빈 객체', async () => {
    delete process.env.BLOG_REVENUE_CORRELATION_ENABLED;
    const weights = await fetchRevenueAttributionWeights();
    expect(weights).toEqual({});
  });
});
