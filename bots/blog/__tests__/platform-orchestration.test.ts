'use strict';

/**
 * Phase 4 멀티 플랫폼 오케스트레이션 테스트
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
jest.mock('../../../packages/core/lib/openclaw-client', () => ({
  postAlarm: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../lib/star.ts', () => ({
  createInstaContent: jest.fn().mockResolvedValue({
    caption: 'strategy-native caption',
    hashtags: ['#strategy_native'],
    thumbnailUrl: '',
  }),
}));

const pgPool = require('../../../packages/core/lib/pg-pool');

// ─── cross-platform-adapter ───────────────────────────────────────────────────

describe('cross-platform-adapter', () => {
  const adapter = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/cross-platform-adapter.ts'));

  test('extractKeyPoints — 빈 콘텐츠 → 빈 배열', () => {
    expect(adapter.extractKeyPoints('')).toEqual([]);
    expect(adapter.extractKeyPoints(null)).toEqual([]);
  });

  test('extractKeyPoints — 번호 목록 추출', () => {
    const content = '1. 첫 번째 포인트입니다\n2. 두 번째 포인트입니다\n3. 세 번째 포인트입니다';
    const result = adapter.extractKeyPoints(content, 5);
    expect(result.length).toBeGreaterThan(0);
  });

  test('blogToInstagramCaption — 기본 캡션 생성', () => {
    const post = {
      title: '스터디카페 집중력 높이는 법',
      content: '1. 핸드폰을 멀리 두세요\n2. 타이머를 사용하세요\n3. 목표를 명확히 하세요',
      hashtags: ['집중', '공부법'],
    };
    const caption = adapter.blogToInstagramCaption(post);
    expect(typeof caption).toBe('string');
    expect(caption).toContain('스터디카페 집중력 높이는 법');
    expect(caption).toContain('#스터디카페');
    expect(caption.length).toBeLessThanOrEqual(2200);
  });

  test('blogToInstagramCaption — 전략에 따라 전환형 태그를 강화', () => {
    const post = {
      title: '예약 전환을 높이는 CTA 설계',
      content: '1. CTA를 눈에 띄게 배치하세요\n2. 망설이는 구간을 줄이세요',
      hashtags: [],
    };
    const caption = adapter.blogToInstagramCaption(post, 2200, {
      executionDirectives: {
        hashtagPolicy: { mode: 'conversion', focusTags: ['#전환설계'] },
        creativePolicy: { ctaStyle: 'conversion' },
      },
    });
    expect(caption).toContain('#예약문의');
    expect(caption).toContain('#전환설계');
  });

  test('blogToFacebookPost — 기본 포스트 생성', () => {
    const post = {
      title: '자기계발 독서법',
      content: '책을 읽는 것만으로는 부족합니다. 정리하고 실천해야 합니다.',
      naver_url: 'https://blog.naver.com/test/123',
    };
    const fbPost = adapter.blogToFacebookPost(post);
    expect(fbPost).toHaveProperty('message');
    expect(fbPost).toHaveProperty('link');
    expect(fbPost.link).toBe(post.naver_url);
    expect(fbPost.message.length).toBeLessThanOrEqual(200);
  });

  test('blogToReelScript — 릴스 스크립트 구조 반환', () => {
    const post = {
      title: '집중력을 높이는 3가지 방법',
      content: '1. 환경을 만들어라\n2. 목표를 세분화하라\n3. 휴식을 취하라',
      category: '자기계발',
    };
    const script = adapter.blogToReelScript(post);
    expect(script).toHaveProperty('hook');
    expect(script).toHaveProperty('cta');
    expect(script).toHaveProperty('full_script');
    expect(script).toHaveProperty('estimated_duration_sec');
  });

  test('blogToReelScript — 전략에 따라 problem-first hook 사용', () => {
    const post = {
      title: '이탈을 줄이는 UX 포인트',
      content: '1. 설명을 먼저 보이게 하세요\n2. 상태를 명확히 안내하세요',
      category: '홈페이지와App',
    };
    const script = adapter.blogToReelScript(post, {
      executionDirectives: {
        creativePolicy: { hookStyle: 'problem_first', ctaStyle: 'conversion' },
      },
    });
    expect(script.hook).toContain('놓칩니다');
    expect(script.cta).toContain('적용 포인트');
  });
});

// ─── time-slot-optimizer ─────────────────────────────────────────────────────

describe('time-slot-optimizer', () => {
  const optimizer = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/time-slot-optimizer.ts'));

  beforeEach(() => jest.clearAllMocks());

  test('DEFAULT_OPTIMAL_HOURS — 모든 플랫폼 포함', () => {
    expect(optimizer.DEFAULT_OPTIMAL_HOURS).toHaveProperty('naver');
    expect(optimizer.DEFAULT_OPTIMAL_HOURS).toHaveProperty('instagram');
    expect(optimizer.DEFAULT_OPTIMAL_HOURS).toHaveProperty('facebook');
  });

  test('optimizePublishTime — 데이터 없으면 기본값 사용', async () => {
    pgPool.query.mockResolvedValue([]);
    const result = await optimizer.optimizePublishTime('naver');
    expect(result).toHaveProperty('platform', 'naver');
    expect(result.recommended_hours).toBeInstanceOf(Array);
    expect(result.recommended_hours.length).toBeGreaterThan(0);
    expect(result.note).toContain('기본값');
  });

  test('optimizePublishTime — 데이터 있으면 학습 기반 반환', async () => {
    pgPool.query
      .mockResolvedValueOnce([
        { hour: '20', avg_views: '500', avg_engagement: '25', post_count: '10' },
        { hour: '18', avg_views: '400', avg_engagement: '20', post_count: '8' },
      ])
      .mockResolvedValueOnce([
        { weekday: '2', weekday_name: '화', avg_views: '450', avg_engagement: '22', post_count: '5' },
      ]);
    const result = await optimizer.optimizePublishTime('naver');
    expect(result.recommended_hours[0]).toBe(20);
  });

  test('getAllPlatformOptimalTimes — 3 플랫폼 모두 반환', async () => {
    pgPool.query.mockResolvedValue([]);
    const result = await optimizer.getAllPlatformOptimalTimes();
    expect(result).toHaveProperty('naver');
    expect(result).toHaveProperty('instagram');
    expect(result).toHaveProperty('facebook');
  });
});

// ─── ab-testing ──────────────────────────────────────────────────────────────

describe('ab-testing', () => {
  const abTesting = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/ab-testing.ts'));

  beforeEach(() => jest.clearAllMocks());

  test('chiSquareTest — 샘플 부족 시 유의하지 않음', () => {
    const result = abTesting.chiSquareTest(3, 2, 100, 80);
    expect(result.significant).toBe(false);
  });

  test('chiSquareTest — 충분한 샘플 + 차이 없으면 유의하지 않음', () => {
    const result = abTesting.chiSquareTest(50, 50, 500, 500);
    expect(result.significant).toBe(false);
  });

  test('createAbTest — DB 오류 시 null 반환', async () => {
    pgPool.query.mockRejectedValueOnce(new Error('DB 오류'));
    const result = await abTesting.createAbTest({
      platform: 'naver',
      variant_a: { title: '제목 A' },
      variant_b: { title: '제목 B' },
      hypothesis: '제목 다양화 테스트',
    });
    expect(result).toBeNull();
  });

  test('createAbTest — 성공 시 test_id 반환', async () => {
    pgPool.query.mockResolvedValueOnce([]);
    const result = await abTesting.createAbTest({
      platform: 'naver',
      variant_a: { title: '제목 A' },
      variant_b: { title: '제목 B' },
    });
    expect(result).toHaveProperty('test_id');
    expect(result.status).toBe('running');
  });

  test('analyzeAbTest — 존재하지 않는 ID → null', async () => {
    pgPool.query.mockResolvedValueOnce([]);
    const result = await abTesting.analyzeAbTest('nonexistent');
    expect(result).toBeNull();
  });
});

// ─── platform-orchestrator ────────────────────────────────────────────────────

describe('platform-orchestrator', () => {
  const orchestrator = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/platform-orchestrator.ts'));

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BLOG_MULTI_PLATFORM_ENABLED;
  });

  test('isEnabled() — false by default', () => {
    expect(orchestrator.isEnabled()).toBe(false);
  });

  test('orchestrateDailyPublishing — disabled 시 null', async () => {
    const result = await orchestrator.orchestrateDailyPublishing(true);
    expect(result).toBeNull();
  });

  test('orchestrateDailyPublishing — enabled + 오늘 포스트 없으면 strategy_native fallback 또는 null', async () => {
    process.env.BLOG_MULTI_PLATFORM_ENABLED = 'true';
    pgPool.get.mockResolvedValueOnce(null);
    const result = await orchestrator.orchestrateDailyPublishing(true);
    if (result === null) {
      expect(result).toBeNull();
      return;
    }
    expect(result).toHaveProperty('blogPost');
    expect(result.blogPost?.sourceMode).toBe('strategy_native');
  });

  test('PLATFORM_STRATEGY — 3 플랫폼 모두 정의', () => {
    expect(orchestrator.PLATFORM_STRATEGY).toHaveProperty('naver_blog');
    expect(orchestrator.PLATFORM_STRATEGY).toHaveProperty('instagram');
    expect(orchestrator.PLATFORM_STRATEGY).toHaveProperty('facebook');
  });

  test('getTodayPublishStatus — 기본 구조 반환', async () => {
    pgPool.query.mockResolvedValueOnce([]);
    const result = await orchestrator.getTodayPublishStatus();
    expect(result).toHaveProperty('naver');
    expect(result).toHaveProperty('instagram');
    expect(result).toHaveProperty('facebook');
  });
});
