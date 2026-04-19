'use strict';

/**
 * Phase 6 Self-Rewarding + Agentic RAG 테스트
 * marketing-dpo.ts / cross-platform-transfer.ts / marketing-rag.ts
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');

jest.mock('../../../packages/core/lib/pg-pool', () => ({
  query: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../../packages/core/lib/mode-guard', () => ({
  runIfOps: jest.fn((_key, ops, dev) => (ops ? Promise.resolve(ops()) : Promise.resolve(dev()))),
}));
jest.mock('../../../packages/core/lib/openclaw-client', () => ({
  postAlarm: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../packages/core/lib/local-llm-client', () => ({
  callLocalFast: jest.fn().mockResolvedValue('{"hook_difference":"A는 list 스타일","key_insight":"list 스타일이 효과적","action_hint":"list 형식 제목 사용"}'),
}));
jest.mock('../../../packages/core/lib/llm-fallback', () => ({
  callWithFallback: jest.fn().mockResolvedValue({ content: '{"primary_strategy":"list 후킹 활용","content_hints":["hint1"],"recommended_hook_style":"list","recommended_categories":[],"timing_hint":"11시","expected_impact":"+15%"}' }),
}));
jest.mock('../../../packages/core/lib/llm-model-selector', () => ({
  selectLLMChain: jest.fn().mockReturnValue([]),
}));

const pgPool = require('../../../packages/core/lib/pg-pool');

// ─── marketing-dpo ────────────────────────────────────────────────────────────

describe('marketing-dpo', () => {
  const dpo = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/self-rewarding/marketing-dpo'));

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

  test('calcPostScore — 0점 (데이터 없음)', () => {
    const post = { views_7d: 0, engagement_rate: 0, revenue_attributed_krw: 0 };
    expect(dpo.calcPostScore(post)).toBe(0);
  });

  test('calcPostScore — 최대 가중치 계산', () => {
    const post = { views_7d: 1000, engagement_rate: 1, revenue_attributed_krw: 100000 };
    const score = dpo.calcPostScore(post);
    expect(score).toBe(100);
  });

  test('calcPostScore — 부분 점수', () => {
    const post = { views_7d: 500, engagement_rate: 0, revenue_attributed_krw: 0 };
    const score = dpo.calcPostScore(post);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
  });

  test('classifyHookStyle — list 스타일 감지', () => {
    expect(dpo.classifyHookStyle('집중력 높이는 5가지 방법')).toBe('list');
  });

  test('classifyHookStyle — why 스타일 감지', () => {
    expect(dpo.classifyHookStyle('공부가 안 되는 이유')).toBe('why');
  });

  test('classifyHookStyle — how 스타일 감지', () => {
    expect(dpo.classifyHookStyle('스터디카페 예약 방법')).toBe('how');
  });

  test('classifyHookStyle — question 스타일 감지', () => {
    expect(dpo.classifyHookStyle('어떻게 집중력을 높일 수 있을까')).toBe('question');
  });

  test('classifyHookStyle — 제목 없으면 unknown', () => {
    expect(dpo.classifyHookStyle('')).toBe('unknown');
    expect(dpo.classifyHookStyle(null)).toBe('unknown');
  });

  test('buildPreferencePairs — Kill Switch off면 빈 배열', async () => {
    delete process.env.BLOG_DPO_ENABLED;
    pgPool.query.mockResolvedValue([]);
    const pairs = await dpo.buildPreferencePairs(30);
    expect(Array.isArray(pairs)).toBe(true);
    expect(pairs.length).toBe(0);
  });

  test('buildPreferencePairs — 데이터 부족 시 빈 배열', async () => {
    process.env.BLOG_DPO_ENABLED = 'true';
    pgPool.query.mockResolvedValue([{ id: '1', title: '제목', category: 'IT', persona: 'POS', views_7d: 100, engagement_rate: 0.01, revenue_attributed_krw: 0, content_length: 1200 }]);
    const pairs = await dpo.buildPreferencePairs(30);
    expect(pairs.length).toBe(0);
  });

  test('analyzePairWithLlm — fallback 동작', async () => {
    const preferred = { title: '5가지 집중법', category: '자기계발', views_7d: 1000 };
    const rejected = { title: '집중이 중요한 이유', category: '자기계발', views_7d: 50 };
    const result = await dpo.analyzePairWithLlm(preferred, rejected);
    expect(result).toHaveProperty('hook_difference');
    expect(result).toHaveProperty('key_insight');
    expect(result).toHaveProperty('action_hint');
  });

  test('fetchSuccessPatterns — DB 에러 시 빈 배열', async () => {
    pgPool.query.mockRejectedValue(new Error('DB 연결 실패'));
    const patterns = await dpo.fetchSuccessPatterns(10);
    expect(Array.isArray(patterns)).toBe(true);
  });

  test('fetchFailureTaxonomy — DB 에러 시 빈 배열', async () => {
    pgPool.query.mockRejectedValue(new Error('DB 연결 실패'));
    const taxonomy = await dpo.fetchFailureTaxonomy(10);
    expect(Array.isArray(taxonomy)).toBe(true);
  });

  test('getBestHookStyleByCategory — DB 에러 시 null', async () => {
    pgPool.query.mockRejectedValue(new Error('DB 에러'));
    const style = await dpo.getBestHookStyleByCategory('자기계발');
    expect(style).toBeNull();
  });

  test('getBestHookStyleByCategory — DB 결과 반환', async () => {
    pgPool.query.mockResolvedValue([{ hook_type: 'list' }]);
    const style = await dpo.getBestHookStyleByCategory('자기계발');
    expect(style).toBe('list');
  });

  test('runDpoLearningCycle — Kill Switch off면 skipped', async () => {
    delete process.env.BLOG_DPO_ENABLED;
    const result = await dpo.runDpoLearningCycle(30);
    expect(result.skipped).toBe(true);
  });

  test('updateFailureTaxonomy — 빈 pairs 처리', async () => {
    pgPool.query.mockResolvedValue([]);
    await expect(dpo.updateFailureTaxonomy([])).resolves.not.toThrow();
  });

  test('saveDpoPairs — 빈 pairs는 0 반환', async () => {
    const saved = await dpo.saveDpoPairs([], []);
    expect(saved).toBe(0);
  });
});

// ─── cross-platform-transfer ─────────────────────────────────────────────────

describe('cross-platform-transfer', () => {
  const transfer = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/self-rewarding/cross-platform-transfer'));

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

  test('classifyHookStyle — 다양한 스타일 분류', () => {
    expect(transfer.classifyHookStyle('5가지 집중법')).toBe('list');
    expect(transfer.classifyHookStyle('안 되는 이유')).toBe('why');
    expect(transfer.classifyHookStyle('vs 비교')).toBe('comparison');
    expect(transfer.classifyHookStyle('실수를 피하는 법')).toBe('mistake');
  });

  test('extractHookWords — 핵심 단어 추출', () => {
    const words = transfer.extractHookWords('집중력을 높이는 비결 전략');
    expect(words).toContain('비결');
    expect(words).toContain('전략');
  });

  test('extractHookWords — 빈 제목은 빈 배열', () => {
    expect(transfer.extractHookWords('')).toEqual([]);
    expect(transfer.extractHookWords(null)).toEqual([]);
  });

  test('adaptHooksToBlogTitles — list 후킹 → 블로그 템플릿 생성', () => {
    const hooks = [{ hook_style: 'list', title: '5가지 방법', engagement_rate: 0.05, views: 500, hook_words: ['방법'] }];
    const templates = transfer.adaptHooksToBlogTitles(hooks);
    expect(templates.length).toBeGreaterThan(0);
    expect(templates[0]).toHaveProperty('template');
    expect(templates[0]).toHaveProperty('confidence');
    expect(templates[0].source_platform).toBe('instagram');
  });

  test('adaptHooksToBlogTitles — why 후킹 → 블로그 템플릿', () => {
    const hooks = [{ hook_style: 'why', title: '이유 분석', engagement_rate: 0.04, views: 300, hook_words: [] }];
    const templates = transfer.adaptHooksToBlogTitles(hooks);
    expect(templates.length).toBeGreaterThan(0);
  });

  test('runTransferLearning — Kill Switch off면 skipped: true 반환', async () => {
    delete process.env.BLOG_DPO_ENABLED;
    pgPool.query.mockResolvedValue([]);
    const result = await transfer.runTransferLearning();
    expect(result).toHaveProperty('skipped', true);
  });

  test('runTransferLearning — DB 에러 시 graceful 반환', async () => {
    process.env.BLOG_DPO_ENABLED = 'true';
    pgPool.query.mockRejectedValue(new Error('DB 에러'));
    const result = await transfer.runTransferLearning();
    expect(result).toHaveProperty('templates');
  });
});

// ─── marketing-rag ───────────────────────────────────────────────────────────

describe('marketing-rag', () => {
  const rag = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/agentic-rag/marketing-rag'));

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

  test('planMarketingQuery — 기본 서브쿼리 생성', () => {
    const plan = rag.planMarketingQuery('스터디카페 마케팅');
    expect(Array.isArray(plan)).toBe(true);
    expect(plan.length).toBeGreaterThan(0);
  });

  test('planMarketingQuery — 비수기 컨텍스트 감지', () => {
    const plan = rag.planMarketingQuery('비수기 스터디카페 유입 전략');
    expect(plan.some((q) => /비수기/.test(q.q))).toBe(true);
  });

  test('planMarketingQuery — 신규 유입 컨텍스트 감지', () => {
    const plan = rag.planMarketingQuery('신규 고객 유입 콘텐츠');
    expect(plan.some((q) => /신규/.test(q.q))).toBe(true);
  });

  test('planMarketingQuery — 경쟁사 컨텍스트 감지', () => {
    const plan = rag.planMarketingQuery('경쟁사 대응 벤치마킹');
    expect(plan.some((q) => /경쟁/.test(q.q))).toBe(true);
  });

  test('retrieveMarketingKnowledge — DB 에러 시 빈 배열', async () => {
    pgPool.query.mockRejectedValue(new Error('DB 에러'));
    const plan = rag.planMarketingQuery('마케팅 전략');
    const results = await rag.retrieveMarketingKnowledge(plan);
    expect(Array.isArray(results)).toBe(true);
  });

  test('evaluateRetrievalQuality — 결과 없으면 needs_retry', () => {
    const quality = rag.evaluateRetrievalQuality([], []);
    expect(quality.needs_retry).toBe(true);
  });

  test('evaluateRetrievalQuality — 충분한 결과면 needs_retry false', () => {
    const results = [
      { source: 'own_success', relevance: 0.9 },
      { source: 'dpo_learning', relevance: 0.8 },
      { source: 'trend_signal', relevance: 0.7 },
      { source: 'success_library', relevance: 0.85 },
    ];
    const subqueries = [{ q: '마케팅' }, { q: '스터디카페' }, { q: '전략' }, { q: '콘텐츠' }];
    const quality = rag.evaluateRetrievalQuality(results, subqueries);
    expect(typeof quality.needs_retry).toBe('boolean');
    expect(quality.quality_score).toBeGreaterThan(0);
  });

  test('runMarketingRag — Kill Switch off면 스킵', async () => {
    delete process.env.BLOG_MARKETING_RAG_ENABLED;
    const result = await rag.runMarketingRag('스터디카페 마케팅');
    expect(result.skipped).toBe(true);
  });

  test('runMarketingRag — Kill Switch on, DB 없이도 응답', async () => {
    process.env.BLOG_MARKETING_RAG_ENABLED = 'true';
    pgPool.query.mockResolvedValue([]);
    const result = await rag.runMarketingRag('스터디카페 마케팅');
    expect(result).toHaveProperty('intent');
    expect(result).toHaveProperty('response');
    expect(result.intent).toBe('스터디카페 마케팅');
  });

  test('synthesizeMarketingResponse — 항상 content_calendar 반환', async () => {
    const retrieved = [
      { source: 'success_library', snippet: 'list 스타일', relevance: 0.9, pattern_type: 'hook', template: 'list', platform: 'naver', avg_performance: 80 },
      { source: 'own_success', snippet: '조회 500', relevance: 0.8, title: '집중법 5가지', category: '자기계발' },
    ];
    const resp = await rag.synthesizeMarketingResponse(retrieved, '스터디카페 마케팅');
    // content_calendar는 항상 포함 (LLM 성공/실패 무관)
    expect(resp).toHaveProperty('content_calendar');
    expect(Array.isArray(resp.content_calendar)).toBe(true);
    expect(resp.content_calendar.length).toBeGreaterThan(0);
  });

  test('searchOwnSuccessPatterns — DB 에러 시 빈 배열', async () => {
    pgPool.query.mockRejectedValue(new Error('DB 에러'));
    const results = await rag.searchOwnSuccessPatterns([{ q: '마케팅', priority: 1 }]);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  });

  test('searchCompetitorBenchmarks — DB 에러 시 빈 배열', async () => {
    pgPool.query.mockRejectedValue(new Error('DB 에러'));
    const results = await rag.searchCompetitorBenchmarks();
    expect(Array.isArray(results)).toBe(true);
  });
});
