'use strict';

/**
 * Phase 6 테스트 — Self-Rewarding DPO + Marketing RAG + Cross-Platform Transfer
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
jest.mock('../../../packages/core/lib/local-llm-client', () => ({
  callLocalFast: jest.fn().mockResolvedValue('{"primary_strategy":"테스트 전략","key_insight":"테스트"}'),
}), { virtual: true });

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

  test('classifyHookStyle — list 스타일 감지', () => {
    expect(dpo.classifyHookStyle('집중력 높이는 5가지 방법')).toBe('list');
  });

  test('classifyHookStyle — why 스타일 감지', () => {
    expect(dpo.classifyHookStyle('스터디카페를 선택하는 이유')).toBe('why');
  });

  test('classifyHookStyle — how 스타일 감지', () => {
    expect(dpo.classifyHookStyle('공부 집중력 높이는 방법')).toBe('how');
  });

  test('classifyHookStyle — question 스타일 감지', () => {
    expect(dpo.classifyHookStyle('어떻게 하면 집중할 수 있을까')).toBe('question');
  });

  test('classifyHookStyle — unknown fallback', () => {
    expect(dpo.classifyHookStyle('')).toBe('unknown');
    expect(dpo.classifyHookStyle(null)).toBe('unknown');
  });

  test('calcPostScore — 기본 점수 구조', () => {
    const post = { views_7d: 500, engagement_rate: 0.05, revenue_attributed_krw: 50000 };
    const score = dpo.calcPostScore(post);
    expect(typeof score).toBe('number');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  test('calcPostScore — 빈 포스트는 0점', () => {
    expect(dpo.calcPostScore({})).toBe(0);
  });

  test('calculateDpoScore — 기본 점수 50', () => {
    const score = dpo.calculateDpoScore({ topic: '스터디카페 팁' }, [], []);
    expect(score).toBe(50);
  });

  test('calculateDpoScore — 성공 패턴 일치 시 점수 상승', () => {
    const successPatterns = [
      { pattern_type: 'hook', pattern_template: 'list', avg_performance: 80 },
    ];
    const score = dpo.calculateDpoScore({ topic: '공부 잘 되는 5가지 방법' }, successPatterns, []);
    expect(score).toBeGreaterThan(50);
  });

  test('calculateDpoScore — 실패 taxonomy 일치 시 점수 하락', () => {
    const failureTaxonomy = [
      { failure_category: 'poor_hook_unknown', frequency_count: 5 },
    ];
    const score = dpo.calculateDpoScore({ topic: '스터디카페' }, [], failureTaxonomy);
    expect(score).toBeLessThanOrEqual(50);
  });

  test('fetchPostsWithMetrics — 미노출 함수는 스킵', () => {
    // fetchPostsWithMetrics는 내부 함수 (exports에 없을 수 있음)
    expect(typeof dpo.buildPreferencePairs).toBe('function');
  });

  test('fetchSuccessPatterns — 빈 배열 반환', async () => {
    pgPool.query.mockResolvedValueOnce([]);
    const result = await dpo.fetchSuccessPatterns(10);
    expect(Array.isArray(result)).toBe(true);
  });

  test('fetchFailureTaxonomy — 빈 배열 반환', async () => {
    pgPool.query.mockResolvedValueOnce([]);
    const result = await dpo.fetchFailureTaxonomy(10);
    expect(Array.isArray(result)).toBe(true);
  });

  test('buildPreferencePairs — 데이터 부족 시 빈 배열', async () => {
    pgPool.query.mockResolvedValueOnce([{ id: '1', title: 'A', category: 'study', views_7d: 100 }]);
    const result = await dpo.buildPreferencePairs(30);
    expect(Array.isArray(result)).toBe(true);
  });

  test('runDpoLearningCycle — disabled 시 skipped 반환', async () => {
    const result = await dpo.runDpoLearningCycle();
    expect(result).toHaveProperty('skipped', true);
  });

  test('module exports 검증', () => {
    expect(typeof dpo.isEnabled).toBe('function');
    expect(typeof dpo.buildPreferencePairs).toBe('function');
    expect(typeof dpo.fetchSuccessPatterns).toBe('function');
    expect(typeof dpo.fetchFailureTaxonomy).toBe('function');
    expect(typeof dpo.runDpoLearningCycle).toBe('function');
    expect(typeof dpo.classifyHookStyle).toBe('function');
    expect(typeof dpo.calcPostScore).toBe('function');
    expect(typeof dpo.calculateDpoScore).toBe('function');
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

  test('isEnabled() — true when set', () => {
    process.env.BLOG_MARKETING_RAG_ENABLED = 'true';
    expect(rag.isEnabled()).toBe(true);
  });

  test('planMarketingQuery — 비수기 맥락 서브쿼리 생성', () => {
    const subqueries = rag.planMarketingQuery('3월 비수기 대응 전략');
    expect(Array.isArray(subqueries)).toBe(true);
    expect(subqueries.length).toBeGreaterThan(0);
    expect(subqueries.every((s) => s.q && s.priority)).toBe(true);
  });

  test('planMarketingQuery — 신규 유입 맥락', () => {
    const subqueries = rag.planMarketingQuery('신규 방문자 유입 늘리기');
    expect(subqueries.length).toBeGreaterThan(0);
    expect(subqueries.some((s) => s.q.includes('신규') || s.q.includes('방문'))).toBe(true);
  });

  test('planMarketingQuery — 경쟁사 맥락', () => {
    const subqueries = rag.planMarketingQuery('경쟁사 대응 방안');
    expect(subqueries.length).toBeGreaterThan(0);
  });

  test('planMarketingQuery — 기본 쿼리 항상 포함', () => {
    const subqueries = rag.planMarketingQuery('일반적인 마케팅 전략');
    const hasDefault = subqueries.some((s) => s.q.includes('성공 포스팅') || s.q.includes('마케팅'));
    expect(hasDefault).toBe(true);
  });

  test('evaluateRetrievalQuality — 빈 결과 낮은 점수', () => {
    const result = rag.evaluateRetrievalQuality([], []);
    expect(result.needs_retry).toBe(true);
    expect(result.quality_score).toBeLessThan(0.5);
  });

  test('evaluateRetrievalQuality — 충분한 결과 높은 점수', () => {
    const results = [
      { source: 'success_library', relevance: 0.9, snippet: 'A' },
      { source: 'own_success', relevance: 0.8, snippet: 'B' },
      { source: 'dpo_learning', relevance: 0.85, snippet: 'C' },
      { source: 'trend_signal', relevance: 0.7, snippet: 'D' },
    ];
    const result = rag.evaluateRetrievalQuality(results, []);
    expect(result.needs_retry).toBe(false);
    expect(result.quality_score).toBeGreaterThanOrEqual(0.5);
  });

  test('searchOwnSuccessPatterns — DB 결과 없으면 빈 배열', async () => {
    pgPool.query.mockResolvedValue([]);
    const result = await rag.searchOwnSuccessPatterns([{ q: '스터디카페' }]);
    expect(Array.isArray(result)).toBe(true);
  });

  test('searchSuccessPatternLibrary — DB 데이터 반환', async () => {
    pgPool.query.mockResolvedValueOnce([
      { pattern_type: 'hook', pattern_template: 'list', platform: 'naver', avg_performance: '75.5' },
    ]);
    const result = await rag.searchSuccessPatternLibrary([{ q: '테스트' }]);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toHaveProperty('source', 'success_library');
  });

  test('runMarketingRag — disabled 시 skipped 반환', async () => {
    const result = await rag.runMarketingRag('비수기 대응');
    expect(result).toHaveProperty('skipped', true);
  });

  test('synthesizeMarketingResponse — 기본 구조 반환', async () => {
    pgPool.query.mockResolvedValue([]);
    const retrieved = [
      { source: 'own_success', relevance: 0.8, snippet: '스터디카페 공부법', title: '집중 비법' },
    ];
    const result = await rag.synthesizeMarketingResponse(retrieved, '비수기 대응');
    expect(result).toHaveProperty('content_calendar');
    expect(Array.isArray(result.content_calendar)).toBe(true);
  });

  test('module exports 검증', () => {
    expect(typeof rag.isEnabled).toBe('function');
    expect(typeof rag.planMarketingQuery).toBe('function');
    expect(typeof rag.retrieveMarketingKnowledge).toBe('function');
    expect(typeof rag.evaluateRetrievalQuality).toBe('function');
    expect(typeof rag.synthesizeMarketingResponse).toBe('function');
    expect(typeof rag.runMarketingRag).toBe('function');
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

  test('isEnabled() — true when set', () => {
    process.env.BLOG_DPO_ENABLED = 'true';
    expect(transfer.isEnabled()).toBe(true);
  });

  test('classifyHookStyle — list 감지', () => {
    expect(transfer.classifyHookStyle('공부법 5가지')).toBe('list');
  });

  test('classifyHookStyle — 빈 문자열은 unknown', () => {
    expect(transfer.classifyHookStyle('')).toBe('unknown');
  });

  test('extractHookWords — 숫자 + 가지 패턴 추출', () => {
    const words = transfer.extractHookWords('집중력 높이는 5가지 방법');
    expect(Array.isArray(words)).toBe(true);
  });

  test('adaptHooksToBlogTitles — hooks 배열로 템플릿 생성', () => {
    const hooks = [
      { title: '공부 집중법 5가지', hook_style: 'list', hook_words: ['집중법', '5가지'] },
    ];
    const result = transfer.adaptHooksToBlogTitles(hooks);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  test('adaptHooksToFacebook — 짧은 텍스트 생성', () => {
    const hooks = [
      { title: '스터디카페 추천', hook_style: 'how', hook_words: ['추천'] },
    ];
    const result = transfer.adaptHooksToFacebook(hooks);
    expect(Array.isArray(result)).toBe(true);
  });

  test('extractSuccessfulHooks — DB 빈 결과', async () => {
    pgPool.query.mockResolvedValueOnce([]);
    const result = await transfer.extractSuccessfulHooks('instagram', 30);
    expect(Array.isArray(result)).toBe(true);
  });

  test('runTransferLearning — disabled 시 skipped 반환', async () => {
    const result = await transfer.runTransferLearning();
    expect(result).toHaveProperty('skipped', true);
  });

  test('module exports 검증', () => {
    expect(typeof transfer.isEnabled).toBe('function');
    expect(typeof transfer.extractSuccessfulHooks).toBe('function');
    expect(typeof transfer.classifyHookStyle).toBe('function');
    expect(typeof transfer.adaptHooksToBlogTitles).toBe('function');
    expect(typeof transfer.adaptHooksToFacebook).toBe('function');
    expect(typeof transfer.runTransferLearning).toBe('function');
  });
});
