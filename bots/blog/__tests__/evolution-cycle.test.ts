'use strict';

/**
 * Phase 3 자율진화 루프 테스트
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');

jest.mock('../../../packages/core/lib/pg-pool', () => ({
  query: jest.fn().mockResolvedValue([]),
  get: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../packages/core/lib/llm-keys', () => ({
  initHubConfig: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../packages/core/lib/mode-guard', () => ({
  runIfOps: jest.fn((_key, _ops, dev) => Promise.resolve(dev())),
}));
jest.mock('../../../packages/core/lib/hub-alarm-client', () => ({
  postAlarm: jest.fn().mockResolvedValue(undefined),
}));

// 복잡한 의존성 모킹
jest.mock(
  `${process.env.PROJECT_ROOT || require('../../../packages/core/lib/env').PROJECT_ROOT}/bots/blog/lib/feedback-learner.ts`,
  () => ({
    learnHighPerformancePatterns: jest.fn().mockResolvedValue({ count: 0 }),
    calculateAccuracy: jest.fn().mockResolvedValue({ accuracy: 0.8 }),
  }),
  { virtual: true },
);
jest.mock(
  `${process.env.PROJECT_ROOT || require('../../../packages/core/lib/env').PROJECT_ROOT}/bots/blog/lib/strategy-evolver.ts`,
  () => ({
    evolveStrategy: jest.fn().mockResolvedValue({ topicsAdded: 0, personaWeightDelta: {}, nextCycleHints: [] }),
  }),
  { virtual: true },
);

const pgPool = require('../../../packages/core/lib/pg-pool');

// ─── content-market-fit ───────────────────────────────────────────────────────

describe('content-market-fit', () => {
  const cmf = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/content-market-fit.ts'));

  beforeEach(() => jest.clearAllMocks());

  test('calculateContentMarketFit — 포스트 없으면 null', async () => {
    pgPool.get.mockResolvedValueOnce(null);
    const result = await cmf.calculateContentMarketFit('999');
    expect(result).toBeNull();
  });

  test('calculateContentMarketFit — 유효 데이터', async () => {
    pgPool.get.mockResolvedValueOnce({
      id: 1, views: 500, likes: 20, comments: 5, ctr: 0.05,
      published_at: new Date().toISOString(),
    });
    pgPool.query
      .mockResolvedValueOnce([{ total_shares: '3' }])  // channel_performance shares
      .mockResolvedValueOnce([{ avg_views: '100' }])   // follower count query
      .mockResolvedValueOnce([]);                       // CMF insert

    const result = await cmf.calculateContentMarketFit('1', 14);
    expect(result).not.toBeNull();
    expect(result.post_id).toBe('1');
    expect(result.grade).toMatch(/[A-F]/);
    expect(result.overall_score).toBeGreaterThanOrEqual(0);
    expect(result.improvement_hints).toBeInstanceOf(Array);
    expect(result.improvement_hints.length).toBeGreaterThan(0);
  });

  test('getAverageCmfScore — 데이터 없으면 0', async () => {
    pgPool.query.mockResolvedValueOnce([{ avg_score: null, measured_count: '0' }]);
    const result = await cmf.getAverageCmfScore(30);
    expect(result.avg_score).toBe(0);
    expect(result.measured_count).toBe(0);
  });

  test('getAverageCmfScore — 데이터 있으면 평균 반환', async () => {
    pgPool.query.mockResolvedValueOnce([{ avg_score: '75.5', measured_count: '10' }]);
    const result = await cmf.getAverageCmfScore(30);
    expect(result.avg_score).toBe(75.5);
    expect(result.measured_count).toBe(10);
  });

  test('computePendingCmf — DB 오류 시 0 반환', async () => {
    pgPool.query.mockRejectedValueOnce(new Error('DB 연결 실패'));
    const result = await cmf.computePendingCmf(14);
    expect(result).toBe(0);
  });
});

// ─── aarrr-metrics ────────────────────────────────────────────────────────────

describe('aarrr-metrics', () => {
  const aarrr = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/aarrr-metrics.ts'));

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BLOG_REVENUE_CORRELATION_ENABLED;
  });

  test('getAcquisitionMetrics — 기본 빈 결과', async () => {
    pgPool.query.mockResolvedValueOnce([]);
    const result = await aarrr.getAcquisitionMetrics(30);
    expect(result).toHaveProperty('total_clicks');
    expect(result).toHaveProperty('top_channel');
  });

  test('getActivationMetrics — revenue disabled 시 note 반환', async () => {
    const result = await aarrr.getActivationMetrics(30);
    expect(result.note).toContain('BLOG_REVENUE_CORRELATION_ENABLED');
  });

  test('getActivationMetrics — revenue enabled 시 DB 조회', async () => {
    process.env.BLOG_REVENUE_CORRELATION_ENABLED = 'true';
    pgPool.query.mockResolvedValueOnce([
      { total_utm_visits: '100', total_conversions: '10', posts_with_attribution: '5' },
    ]);
    const result = await aarrr.getActivationMetrics(30);
    expect(result.utm_visits).toBe(100);
    expect(result.conversions).toBe(10);
    expect(result.activation_rate).toBe(0.1);
  });

  test('calculateAARRR — 전체 지표 구조 반환', async () => {
    pgPool.query.mockResolvedValue([]);
    const result = await aarrr.calculateAARRR(30);
    expect(result).toHaveProperty('period_days', 30);
    expect(result).toHaveProperty('acquisition');
    expect(result).toHaveProperty('activation');
    expect(result).toHaveProperty('retention');
    expect(result).toHaveProperty('referral');
    expect(result).toHaveProperty('revenue');
  });
});

// ─── evolution-cycle ─────────────────────────────────────────────────────────

describe('evolution-cycle', () => {
  const cycle = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/evolution-cycle.ts'));

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BLOG_EVOLUTION_CYCLE_ENABLED;
  });

  test('isEnabled() — false by default', () => {
    expect(cycle.isEnabled()).toBe(false);
  });

  test('isEnabled() — true when set', () => {
    process.env.BLOG_EVOLUTION_CYCLE_ENABLED = 'true';
    expect(cycle.isEnabled()).toBe(true);
  });

  test('runEvolutionCycle — disabled 시 null 반환', async () => {
    const result = await cycle.runEvolutionCycle();
    expect(result).toBeNull();
  });

  test('runEvolutionCycle — enabled 시 사이클 결과 반환', async () => {
    process.env.BLOG_EVOLUTION_CYCLE_ENABLED = 'true';
    pgPool.query.mockResolvedValue([]);
    pgPool.get.mockResolvedValue(null);
    const result = await cycle.runEvolutionCycle();
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('cycle_id');
    expect(result).toHaveProperty('utilize');
    expect(result).toHaveProperty('collect');
    expect(result).toHaveProperty('analyze');
    expect(result).toHaveProperty('feedback');
    expect(result).toHaveProperty('strategy');
    expect(result).toHaveProperty('duration_ms');
  });

  test('collectUtilizeStats — 기본 구조 반환', async () => {
    pgPool.query.mockResolvedValue([{ posts_published: '2' }]);
    const result = await cycle.collectUtilizeStats(1);
    expect(result).toHaveProperty('posts_published');
    expect(result).toHaveProperty('platforms');
  });

  test('collectAllSignals — 기본 구조 반환', async () => {
    pgPool.query.mockResolvedValue([]);
    const result = await cycle.collectAllSignals(7);
    expect(result).toHaveProperty('total_signals');
    expect(result).toHaveProperty('platform_signals');
    expect(result).toHaveProperty('revenue_signals');
  });
});
