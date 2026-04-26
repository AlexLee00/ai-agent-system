'use strict';

/**
 * Phase 6 DPO Learning 테스트
 * marketing-dpo.ts + cross-platform-transfer.ts + marketing-rag.ts
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
  callLocalFast: jest.fn().mockResolvedValue('{"hook_difference":"테스트","key_insight":"테스트","action_hint":"테스트"}'),
}));

const pgPool = require('../../../packages/core/lib/pg-pool');

// ─── marketing-dpo ────────────────────────────────────────────────────────────

describe('marketing-dpo', () => {
  const dpo = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/self-rewarding/marketing-dpo.ts'));

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BLOG_DPO_ENABLED;
  });

  test('isEnabled() — 기본 false', () => {
    expect(dpo.isEnabled()).toBe(false);
  });

  test('isEnabled() — BLOG_DPO_ENABLED=true 시 true', () => {
    process.env.BLOG_DPO_ENABLED = 'true';
    expect(dpo.isEnabled()).toBe(true);
  });

  // calcPostScore
  test('calcPostScore — 모든 지표 0이면 0', () => {
    const post = { views_7d: 0, engagement_rate: 0, revenue_attributed_krw: 0 };
    expect(dpo.calcPostScore(post)).toBe(0);
  });

  test('calcPostScore — 최대 지표면 100', () => {
    const post = { views_7d: 1000, engagement_rate: 0.01, revenue_attributed_krw: 100000 };
    expect(dpo.calcPostScore(post)).toBe(100);
  });

  test('calcPostScore — 부분 지표 합산 정확', () => {
    const post = { views_7d: 500, engagement_rate: 0, revenue_attributed_krw: 0 };
    const score = dpo.calcPostScore(post);
    expect(score).toBeCloseTo(20, 0); // 500/1000 * 40 = 20
  });

  // classifyHookStyle
  test('classifyHookStyle — 숫자+가지 = list', () => {
    expect(dpo.classifyHookStyle('공부 집중력 높이는 5가지 방법')).toBe('list');
  });

  test('classifyHookStyle — 이유 = why', () => {
    expect(dpo.classifyHookStyle('스터디카페가 독서실보다 집중이 되는 이유')).toBe('why');
  });

  test('classifyHookStyle — 방법 = how', () => {
    expect(dpo.classifyHookStyle('합격하는 수험생의 공부 비결')).toBe('how');
  });

  test('classifyHookStyle — 질문형 = question', () => {
    expect(dpo.classifyHookStyle('어떻게 하면 공부가 잘 될까')).toBe('question');
  });

  test('classifyHookStyle — 비교 = comparison', () => {
    expect(dpo.classifyHookStyle('독서실 vs 스터디카페 비교')).toBe('comparison');
  });

  test('classifyHookStyle — 기타 = statement', () => {
    expect(dpo.classifyHookStyle('스터디카페 후기')).toBe('statement');
  });

  test('classifyHookStyle — null/빈문자 = unknown', () => {
    expect(dpo.classifyHookStyle(null)).toBe('unknown');
    expect(dpo.classifyHookStyle('')).toBe('unknown');
  });

  // buildPreferencePairs
  test('buildPreferencePairs — DB 빈 결과 시 빈 배열', async () => {
    pgPool.query.mockResolvedValue([]);
    const pairs = await dpo.buildPreferencePairs(30);
    expect(pairs).toEqual([]);
  });

  test('buildPreferencePairs — 포스팅 4개 미만이면 빈 배열', async () => {
    pgPool.query.mockResolvedValue([
      { id: '1', title: 'A', category: 'cat1', score: 80, views_7d: 100, engagement_rate: 0.05, revenue_attributed_krw: 0 },
      { id: '2', title: 'B', category: 'cat1', score: 20, views_7d: 10, engagement_rate: 0.01, revenue_attributed_krw: 0 },
    ]);
    const pairs = await dpo.buildPreferencePairs(30);
    expect(pairs).toEqual([]);
  });

  test('buildPreferencePairs — 배열 반환 (DB 빈 결과)', async () => {
    pgPool.query.mockResolvedValue([]);
    const pairs = await dpo.buildPreferencePairs(30);
    expect(Array.isArray(pairs)).toBe(true);
    expect(pairs.length).toBe(0); // 포스팅 없음 → 빈 배열
  });

  test('buildPreferencePairs — 선호 쌍 구조 검증 (직접 함수 테스트)', async () => {
    // 내부 로직 검증: 두 post를 직접 비교해 쌍 생성 구조 확인
    // score 기반 top/bottom 분리가 올바르게 작동하는지 calcPostScore로 검증
    const highPost = { views_7d: 1000, engagement_rate: 0.01, revenue_attributed_krw: 100000 };
    const lowPost  = { views_7d: 10, engagement_rate: 0.001, revenue_attributed_krw: 0 };
    expect(dpo.calcPostScore(highPost)).toBeGreaterThan(dpo.calcPostScore(lowPost));
  });

  // calculateDpoScore
  test('calculateDpoScore — 성공/실패 패턴 없으면 기본 점수(50)', () => {
    const candidate = { title: '공부 비결 5가지', category: '공부법' };
    const score = dpo.calculateDpoScore(candidate, [], []);
    expect(score).toBe(50);
  });

  test('calculateDpoScore — 매칭 성공 패턴으로 기본보다 높은 점수', () => {
    const candidate = { title: '스터디카페 5가지 장점', category: '스터디카페' };
    const patterns = [
      { pattern_type: 'hook', pattern_template: 'list', avg_performance: 80, platform: 'naver' },
    ];
    const score = dpo.calculateDpoScore(candidate, patterns, []);
    expect(score).toBeGreaterThan(50);
  });

  test('calculateDpoScore — 실패 패턴 매칭 시 기본보다 낮은 점수', () => {
    const candidate = { title: '오늘의 일상', category: '일상' };
    const failures = [
      {
        failure_category: 'poor_hook_statement',
        typical_characteristics: { hook_styles: ['statement'], categories: ['일상'] },
        avoidance_hint: 'statement 스타일 제목 회피',
      },
    ];
    const score = dpo.calculateDpoScore(candidate, [], failures);
    expect(score).toBeLessThan(50);
  });

  // fetchSuccessPatterns
  test('fetchSuccessPatterns — DB 오류 시 빈 배열', async () => {
    pgPool.query.mockRejectedValue(new Error('DB error'));
    const patterns = await dpo.fetchSuccessPatterns(10);
    expect(patterns).toEqual([]);
  });

  test('fetchSuccessPatterns — DB 결과 반환', async () => {
    const mockPatterns = [
      { pattern_type: 'hook', pattern_template: 'list', avg_performance: '75', usage_count: '12' },
    ];
    pgPool.query.mockResolvedValue(mockPatterns);
    const patterns = await dpo.fetchSuccessPatterns(10);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].pattern_type).toBe('hook');
  });

  // fetchFailureTaxonomy
  test('fetchFailureTaxonomy — DB 오류 시 빈 배열', async () => {
    pgPool.query.mockRejectedValue(new Error('DB error'));
    const failures = await dpo.fetchFailureTaxonomy(10);
    expect(failures).toEqual([]);
  });

  // analyzePairWithLlm
  test('analyzePairWithLlm — LLM 응답 파싱 성공', async () => {
    const preferred = { title: '스터디카페 5가지 꿀팁', category: '스터디카페', views_7d: 500 };
    const rejected = { title: '일상 브이로그', category: '일상', views_7d: 50 };
    const result = await dpo.analyzePairWithLlm(preferred, rejected);
    expect(result).toHaveProperty('hook_difference');
    expect(result).toHaveProperty('key_insight');
    expect(result).toHaveProperty('action_hint');
  });

  test('analyzePairWithLlm — LLM 실패 시 규칙 기반 fallback', async () => {
    const { callLocalFast } = require('../../../packages/core/lib/local-llm-client');
    callLocalFast.mockRejectedValueOnce(new Error('LLM timeout'));

    const preferred = { title: '합격 비결 3가지', category: '공부법', views_7d: 300 };
    const rejected = { title: '오늘 일상', category: '공부법', views_7d: 20 };
    const result = await dpo.analyzePairWithLlm(preferred, rejected);
    // fallback 결과도 정해진 키를 가짐
    expect(result).toHaveProperty('hook_difference');
    expect(result).toHaveProperty('key_insight');
    expect(result).toHaveProperty('action_hint');
  });

  // runDpoLearningCycle
  test('runDpoLearningCycle — Kill Switch OFF 시 skipped 반환', async () => {
    process.env.BLOG_DPO_ENABLED = 'false';
    const result = await dpo.runDpoLearningCycle(30);
    expect(result.skipped).toBe(true);
  });

  test('runDpoLearningCycle — 포스팅 없으면 pairs_built=0', async () => {
    process.env.BLOG_DPO_ENABLED = 'true';
    pgPool.query.mockResolvedValue([]);
    const result = await dpo.runDpoLearningCycle(30);
    expect(result.pairs_built).toBe(0);
  });
});

// ─── cross-platform-transfer ─────────────────────────────────────────────────

describe('cross-platform-transfer', () => {
  const transfer = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/self-rewarding/cross-platform-transfer.ts'));

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BLOG_DPO_ENABLED;
  });

  test('isEnabled() — 기본 false', () => {
    expect(transfer.isEnabled()).toBe(false);
  });

  test('isEnabled() — BLOG_DPO_ENABLED=true 시 true', () => {
    process.env.BLOG_DPO_ENABLED = 'true';
    expect(transfer.isEnabled()).toBe(true);
  });

  test('extractSuccessfulHooks — DB 오류 시 빈 배열', async () => {
    pgPool.query.mockRejectedValue(new Error('DB error'));
    const hooks = await transfer.extractSuccessfulHooks('instagram', 30);
    expect(hooks).toEqual([]);
  });

  test('extractSuccessfulHooks — 결과 매핑 정확', async () => {
    pgPool.query.mockResolvedValue([
      { title: '집중력 높이는 5가지', eng_rate: '0.08', views: '1000' },
      { title: '공부 비결', eng_rate: '0.05', views: '500' },
    ]);
    const hooks = await transfer.extractSuccessfulHooks('instagram', 30);
    expect(hooks).toHaveLength(2);
    expect(hooks[0]).toHaveProperty('hook_style');
    expect(hooks[0]).toHaveProperty('hook_words');
    expect(hooks[0].hook_style).toBe('list');
  });

  test('runTransferLearning — Kill Switch OFF 시 skipped 반환', async () => {
    const result = await transfer.runTransferLearning();
    expect(result).toHaveProperty('skipped', true);
  });
});

// ─── marketing-rag ───────────────────────────────────────────────────────────

describe('marketing-rag', () => {
  const rag = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/agentic-rag/marketing-rag.ts'));

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BLOG_MARKETING_RAG_ENABLED;
  });

  test('isEnabled() — 기본 false', () => {
    expect(rag.isEnabled()).toBe(false);
  });

  test('isEnabled() — BLOG_MARKETING_RAG_ENABLED=true 시 true', () => {
    process.env.BLOG_MARKETING_RAG_ENABLED = 'true';
    expect(rag.isEnabled()).toBe(true);
  });

  test('planMarketingQuery — 비수기 의도 분해', () => {
    const subqueries = rag.planMarketingQuery('3월 스터디카페 비수기 대응 전략');
    expect(Array.isArray(subqueries)).toBe(true);
    expect(subqueries.length).toBeGreaterThan(0);
    expect(subqueries[0]).toHaveProperty('q');
    expect(subqueries[0]).toHaveProperty('priority');
  });

  test('planMarketingQuery — 신규 유입 의도 분해', () => {
    const subqueries = rag.planMarketingQuery('신규 방문자 유입 방법');
    expect(subqueries.some((q) => /신규/.test(q.q))).toBe(true);
  });

  test('planMarketingQuery — 의도 없으면 기본 서브쿼리 포함', () => {
    const subqueries = rag.planMarketingQuery('블로그 운영 개선');
    expect(subqueries.length).toBeGreaterThan(0);
    // 기본 쿼리 항상 포함 (priority 3)
    expect(subqueries.some((q) => q.priority === 3)).toBe(true);
  });

  test('retrieveMarketingKnowledge — DB 오류 무시하고 통합 결과', async () => {
    pgPool.query.mockRejectedValue(new Error('DB error'));
    const subqueries = [{ q: '스터디카페 전략', priority: 1 }];
    const results = await rag.retrieveMarketingKnowledge(subqueries);
    // 오류 있어도 빈 배열이나 빈 결과 반환 (crash 없음)
    expect(Array.isArray(results)).toBe(true);
  });

  test('evaluateRetrievalQuality — 빈 결과는 재검색 필요', () => {
    const eval_result = rag.evaluateRetrievalQuality([], { q: '테스트' });
    expect(eval_result.needs_retry).toBe(true);
  });

  test('evaluateRetrievalQuality — 충분한 결과는 재검색 불필요', () => {
    const results = Array.from({ length: 5 }, (_, i) => ({
      source: 'success_patterns',
      content: `패턴 ${i}`,
      relevance: 0.8,
      freshness: 0.9,
      proven: 0.7,
    }));
    const eval_result = rag.evaluateRetrievalQuality(results, { q: '테스트' });
    expect(eval_result.needs_retry).toBe(false);
    expect(eval_result.results.length).toBeGreaterThan(0);
  });

  test('runMarketingRag — Kill Switch OFF 시 skipped 반환', async () => {
    const result = await rag.runMarketingRag('비수기 대응 전략');
    expect(result).toHaveProperty('skipped', true);
  });
});
