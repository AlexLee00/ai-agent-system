'use strict';

/**
 * Phase 5 Signal Collectors 테스트
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');

jest.mock('../../../packages/core/lib/pg-pool', () => ({
  query: jest.fn().mockResolvedValue([]),
  get: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../packages/core/lib/mode-guard', () => ({
  runIfOps: jest.fn((_key, _ops, dev) => Promise.resolve(dev())),
}));
jest.mock('../../../packages/core/lib/hub-alarm-client', () => ({
  postAlarm: jest.fn().mockResolvedValue(undefined),
}));

const pgPool = require('../../../packages/core/lib/pg-pool');

// ─── naver-trend-collector ────────────────────────────────────────────────────

describe('naver-trend-collector', () => {
  const collector = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/signals/naver-trend-collector.ts'));

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BLOG_SIGNAL_COLLECTOR_ENABLED;
    delete process.env.NAVER_CLIENT_ID;
  });

  test('isEnabled() — false by default', () => {
    expect(collector.isEnabled()).toBe(false);
  });

  test('isEnabled() — true when set', () => {
    process.env.BLOG_SIGNAL_COLLECTOR_ENABLED = 'true';
    expect(collector.isEnabled()).toBe(true);
  });

  test('analyzeTrend — API 데이터 없으면 기본값 반환', () => {
    const result = collector.analyzeTrend('스터디카페', null);
    expect(result.keyword).toBe('스터디카페');
    expect(result.trend_score).toBe(0);
    expect(result.growth_rate_week).toBe(0);
  });

  test('analyzeTrend — 유효 데이터 분석', () => {
    const fakeData = {
      results: [{
        data: [
          { period: '2026-04-05', ratio: 50 },
          { period: '2026-04-06', ratio: 55 },
          { period: '2026-04-07', ratio: 60 },
          { period: '2026-04-08', ratio: 65 },
          { period: '2026-04-09', ratio: 70 },
          { period: '2026-04-10', ratio: 75 },
          { period: '2026-04-11', ratio: 80 },
          { period: '2026-04-12', ratio: 85 },
          { period: '2026-04-13', ratio: 90 },
          { period: '2026-04-14', ratio: 95 },
          { period: '2026-04-15', ratio: 100 },
          { period: '2026-04-16', ratio: 100 },
          { period: '2026-04-17', ratio: 100 },
          { period: '2026-04-18', ratio: 100 },
        ],
      }],
    };
    const result = collector.analyzeTrend('스터디카페', fakeData);
    expect(result.trend_score).toBeGreaterThan(0);
    expect(result.growth_rate_week).toBeGreaterThan(0);
  });

  test('collectBlogKeywordTrends — disabled 시 빈 배열', async () => {
    const result = await collector.collectBlogKeywordTrends();
    expect(result).toEqual([]);
  });

  test('detectTrendingTopics — DB 데이터 없으면 빈 배열', async () => {
    pgPool.query.mockResolvedValueOnce([]);
    const result = await collector.detectTrendingTopics();
    expect(result).toEqual([]);
  });

  test('detectTrendingTopics — DB 데이터 있으면 키워드 반환', async () => {
    pgPool.query.mockResolvedValueOnce([
      { keyword: '스터디카페', growth_rate_week: '35.5' },
      { keyword: '공부법', growth_rate_week: '25.0' },
    ]);
    const result = await collector.detectTrendingTopics();
    expect(result).toEqual(['스터디카페', '공부법']);
  });

  test('fetchNaverTrend — API 키 없으면 null 반환', async () => {
    process.env.BLOG_SIGNAL_COLLECTOR_ENABLED = 'true';
    const result = await collector.fetchNaverTrend(['스터디카페']);
    expect(result).toBeNull();
  });
});

// ─── brand-mention-collector ──────────────────────────────────────────────────

describe('brand-mention-collector', () => {
  const brandCollector = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/signals/brand-mention-collector.ts'));

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BLOG_SIGNAL_COLLECTOR_ENABLED;
  });

  test('BRAND_KEYWORDS — 정의됨', () => {
    expect(brandCollector.BRAND_KEYWORDS).toBeInstanceOf(Array);
    expect(brandCollector.BRAND_KEYWORDS.length).toBeGreaterThan(0);
    expect(brandCollector.BRAND_KEYWORDS).toEqual(expect.arrayContaining([
      '커피랑도서관',
      '커피랑 도서관',
      '커피랑도서관 분당서현점',
      '분당서현',
      '분당서현 스터디카페',
      '분당 서현 스터디카페',
      '서현 스터디카페',
      '서현역 스터디카페',
      '서현역 독서실',
      '승호아빠',
    ]));
  });

  test('analyzeSentiment — 부정 키워드 감지', () => {
    expect(brandCollector.analyzeSentiment('서비스가 최악이었어요 불편했습니다')).toBe('negative');
  });

  test('analyzeSentiment — 긍정 키워드 감지', () => {
    expect(brandCollector.analyzeSentiment('정말 추천합니다 조용하고 집중 잘 돼요')).toBe('positive');
  });

  test('analyzeSentiment — 중립 텍스트', () => {
    expect(brandCollector.analyzeSentiment('스터디카페 방문했습니다')).toBe('neutral');
  });

  test('analyzeSentiment — 빈 텍스트', () => {
    expect(brandCollector.analyzeSentiment('')).toBe('neutral');
    expect(brandCollector.analyzeSentiment(null)).toBe('neutral');
  });

  test('collectBrandMentions — disabled 시 빈 결과', async () => {
    const result = await brandCollector.collectBrandMentions();
    expect(result.total).toBe(0);
    expect(result.items).toEqual([]);
  });

  test('getBrandMentionSummary — DB 빈 결과', async () => {
    pgPool.query.mockResolvedValueOnce([]);
    const result = await brandCollector.getBrandMentionSummary(24);
    expect(result).toHaveProperty('positive', 0);
    expect(result).toHaveProperty('negative', 0);
    expect(result).toHaveProperty('neutral', 0);
  });

  test('getBrandMentionSummary — DB 데이터 집계', async () => {
    pgPool.query.mockResolvedValueOnce([
      { sentiment: 'positive', cnt: '5' },
      { sentiment: 'negative', cnt: '2' },
      { sentiment: 'neutral', cnt: '8' },
    ]);
    const result = await brandCollector.getBrandMentionSummary(24);
    expect(result.positive).toBe(5);
    expect(result.negative).toBe(2);
    expect(result.neutral).toBe(8);
  });
});
