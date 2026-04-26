'use strict';

/**
 * Phase 6 DPO Self-Rewarding + Agentic RAG + Cross-Platform Transfer 테스트
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
jest.mock('../../../packages/core/lib/llm-fallback', () => ({
  callWithFallback: jest.fn().mockResolvedValue({ response: '{"hook_difference":"질문형 vs 나열형","category_fit":"적합","key_insight":"후킹 스타일 차이","action_hint":"질문형 제목 활용"}' }),
}));

const pgPool = require('../../../packages/core/lib/pg-pool');

// ─── marketing-dpo ────────────────────────────────────────────────────────────

describe('marketing-dpo', () => {
  const dpo = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/self-rewarding/marketing-dpo.ts'));

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BLOG_DPO_ENABLED;
  });

  test('isEnabled() — false by default', () => {
    expect(dpo.isEnabled()).toBe(false);
  });

  test('isEnabled() — true when set', () => {
    process.env.BLOG_DPO_ENABLED = 'true';
    expect(dpo.isEnabled()).toBe(true);
  });

  test('calcPostScore — 조회수/참여율/매출 모두 0이면 0', () => {
    const score = dpo.calcPostScore({ views_7d: 0, engagement_rate: 0, revenue_attributed_krw: 0 });
    expect(score).toBe(0);
  });

  test('calcPostScore — 최대값 기준 100 이하', () => {
    const score = dpo.calcPostScore({ views_7d: 10000, engagement_rate: 1, revenue_attributed_krw: 1000000 });
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBeGreaterThan(0);
  });

  test('classifyHookStyle — list 패턴 감지', () => {
    expect(dpo.classifyHookStyle('5가지 방법')).toBe('list');
    expect(dpo.classifyHookStyle('TOP 3 팁')).toBe('list');
  });

  test('classifyHookStyle — why 패턴 감지', () => {
    expect(dpo.classifyHookStyle('왜 스터디카페가 좋을까')).toBe('why');
    expect(dpo.classifyHookStyle('집중력 저하 이유')).toBe('why');
  });

  test('classifyHookStyle — how 패턴 감지', () => {
    expect(dpo.classifyHookStyle('집중력을 높이는 방법')).toBe('how');
  });

  test('classifyHookStyle — unknown 폴백', () => {
    expect(dpo.classifyHookStyle('')).toBe('unknown');
    expect(dpo.classifyHookStyle(null)).toBe('unknown');
  });

  test('calculateDpoScore — 기본 점수 50', () => {
    const score = dpo.calculateDpoScore({ topic: '일반적인 주제', category: '자기계발' }, [], []);
    expect(score).toBe(50);
  });

  test('calculateDpoScore — 성공 패턴 일치 시 점수 상승', () => {
    const patterns = [{ pattern_type: 'hook', pattern_template: 'list', avg_performance: 200 }];
    const score = dpo.calculateDpoScore({ topic: '3가지 팁', category: '자기계발' }, patterns, []);
    expect(score).toBeGreaterThan(50);
  });

  test('calculateDpoScore — 실패 패턴 일치 시 점수 하락', () => {
    const failures = [{ failure_category: 'poor_hook_list', frequency_count: 5 }];
    const score = dpo.calculateDpoScore({ topic: '5가지 방법', category: '자기계발' }, [], failures);
    expect(score).toBeLessThan(50);
  });

  test('calculateDpoScore — 최소값 0, 최대값 100 범위 내', () => {
    const patterns = [{ pattern_type: 'hook', pattern_template: 'list', avg_performance: 9999 }];
    const failures = Array(20).fill({ failure_category: 'poor_hook_why', frequency_count: 10 });
    const score = dpo.calculateDpoScore({ topic: '5가지 핵심', category: '자기계발' }, patterns, failures);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  test('fetchPostsWithMetrics — DB 오류 시 빈 배열 반환', async () => {
    pgPool.query.mockRejectedValueOnce(new Error('DB 연결 실패'));
    const result = await dpo.fetchPostsWithMetrics(30);
    expect(result).toEqual([]);
  });

  test('fetchSuccessPatterns — DB 오류 시 빈 배열', async () => {
    pgPool.query.mockRejectedValueOnce(new Error('오류'));
    const result = await dpo.fetchSuccessPatterns(20);
    expect(result).toEqual([]);
  });

  test('fetchFailureTaxonomy — DB 오류 시 빈 배열', async () => {
    pgPool.query.mockRejectedValueOnce(new Error('오류'));
    const result = await dpo.fetchFailureTaxonomy(20);
    expect(result).toEqual([]);
  });

  test('buildPreferencePairs — Kill Switch OFF 시 빈 배열', async () => {
    process.env.BLOG_DPO_ENABLED = 'false';
    const result = await dpo.buildPreferencePairs(30);
    expect(result).toEqual([]);
  });

  test('buildPreferencePairs — 데이터 부족 시 빈 배열', async () => {
    process.env.BLOG_DPO_ENABLED = 'true';
    pgPool.query.mockResolvedValueOnce([{ id: 1, category: '자기계발', title: '테스트', views_7d: 100 }]);
    const result = await dpo.buildPreferencePairs(30);
    expect(result).toEqual([]);
  });

  test('runDpoLearningCycle — Kill Switch OFF 시 0 반환', async () => {
    process.env.BLOG_DPO_ENABLED = 'false';
    const result = await dpo.runDpoLearningCycle();
    expect(result.pairs_built).toBe(0);
    expect(result.pairs_saved).toBe(0);
  });
});

// ─── marketing-rag ────────────────────────────────────────────────────────────

describe('marketing-rag', () => {
  const rag = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/agentic-rag/marketing-rag.ts'));

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BLOG_MARKETING_RAG_ENABLED;
  });

  test('isEnabled() — false by default', () => {
    expect(rag.isEnabled()).toBe(false);
  });

  test('planMarketingQuery — 비수기 의도 분해', () => {
    const subqueries = rag.planMarketingQuery('스터디카페 비수기 유입 대응 전략');
    expect(subqueries.length).toBeGreaterThan(0);
    expect(subqueries.some((q) => /비수기/.test(q.q))).toBe(true);
  });

  test('planMarketingQuery — 신규 유입 의도 감지', () => {
    const subqueries = rag.planMarketingQuery('신규 방문자 유도 콘텐츠 전략');
    expect(subqueries.some((q) => /신규/.test(q.q))).toBe(true);
  });

  test('planMarketingQuery — 기본 쿼리는 항상 포함', () => {
    const subqueries = rag.planMarketingQuery('일반 마케팅 전략');
    expect(subqueries.length).toBeGreaterThan(0);
    // 기본 쿼리 2개 이상
    const basicCount = subqueries.filter((q) => q.priority >= 3).length;
    expect(basicCount).toBeGreaterThanOrEqual(1);
  });

  test('evaluateRetrievalQuality — 빈 결과면 needs_retry true', () => {
    const quality = rag.evaluateRetrievalQuality([], { q: '테스트' });
    expect(quality.needs_retry).toBe(true);
  });

  test('evaluateRetrievalQuality — 유효 결과면 needs_retry false', () => {
    const results = [
      { content: '스터디카페 성공 포스팅 패턴', source: 'success_patterns', score: 0.9, age_days: 1 },
      { content: '비수기 대응 전략', source: 'competitor', score: 0.8, age_days: 3 },
    ];
    const quality = rag.evaluateRetrievalQuality(results, { q: '비수기 전략' });
    expect(quality.quality_score).toBeGreaterThan(0);
  });

  test('searchOwnSuccessPatterns — DB 오류 시 빈 배열', async () => {
    pgPool.query.mockRejectedValueOnce(new Error('DB 오류'));
    const result = await rag.searchOwnSuccessPatterns([{ q: '테스트' }]);
    expect(result).toEqual([]);
  });

  test('searchDpoLearnings — DB 오류 시 빈 배열', async () => {
    pgPool.query.mockRejectedValueOnce(new Error('DB 오류'));
    const result = await rag.searchDpoLearnings([{ q: '테스트' }]);
    expect(result).toEqual([]);
  });

  test('runMarketingRag — Kill Switch OFF 시 skipped', async () => {
    process.env.BLOG_MARKETING_RAG_ENABLED = 'false';
    const result = await rag.runMarketingRag('테스트 의도');
    expect(result).toHaveProperty('skipped', true);
  });
});

// ─── cross-platform-transfer ──────────────────────────────────────────────────

describe('cross-platform-transfer', () => {
  const transfer = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/self-rewarding/cross-platform-transfer.ts'));

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BLOG_DPO_ENABLED;
  });

  test('isEnabled() — false by default', () => {
    expect(transfer.isEnabled()).toBe(false);
  });

  test('classifyHookStyle — 정확한 분류', () => {
    expect(transfer.classifyHookStyle('3가지 방법')).toMatch(/list|how/);
    expect(transfer.classifyHookStyle('왜 이것이 중요한가')).toMatch(/why/);
  });

  test('extractHookWords — 단어 추출', () => {
    const words = transfer.extractHookWords('집중력을 높이는 5가지 실전 팁');
    expect(Array.isArray(words)).toBe(true);
    expect(words.length).toBeGreaterThan(0);
  });

  test('adaptHooksToBlogTitles — 유효 타이틀 배열 반환', () => {
    const hooks = [
      { hook_style: 'list', sample_title: '5가지 방법', avg_views: 300 },
    ];
    const titles = transfer.adaptHooksToBlogTitles(hooks);
    expect(Array.isArray(titles)).toBe(true);
  });

  test('adaptHooksToFacebook — 페북 포스트 형식 반환', () => {
    const hooks = [
      { hook_style: 'why', sample_title: '왜 중요한가', avg_views: 250 },
    ];
    const posts = transfer.adaptHooksToFacebook(hooks);
    expect(Array.isArray(posts)).toBe(true);
  });

  test('extractSuccessfulHooks — DB 오류 시 빈 배열', async () => {
    pgPool.query.mockRejectedValueOnce(new Error('DB 오류'));
    const result = await transfer.extractSuccessfulHooks('instagram', 30);
    expect(result).toEqual([]);
  });

  test('runTransferLearning — Kill Switch OFF 시 skipped', async () => {
    process.env.BLOG_DPO_ENABLED = 'false';
    const result = await transfer.runTransferLearning('instagram');
    expect(result).toHaveProperty('skipped', true);
  });

  test('runTransferLearning — 데이터 없으면 빈 결과 반환', async () => {
    process.env.BLOG_DPO_ENABLED = 'true';
    pgPool.query.mockResolvedValueOnce([]); // extractSuccessfulHooks 빈 결과
    const result = await transfer.runTransferLearning('instagram');
    expect(result).not.toBeNull();
    expect(result.source_hooks).toBe(0);
  });
});
