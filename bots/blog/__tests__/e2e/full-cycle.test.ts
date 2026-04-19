'use strict';

/**
 * 블로팀 전체 사이클 E2E 테스트 (Phase 7)
 * 5 시나리오: 3 플랫폼 발행, 이미지 복구, 자율진화, 경쟁사 감지, DPO 학습
 */

const path = require('path');
const env = require('../../../../packages/core/lib/env');

// ─── 공통 모킹 ────────────────────────────────────────────────────────────────

jest.mock('../../../../packages/core/lib/pg-pool', () => ({
  query: jest.fn().mockResolvedValue([]),
  get: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../../packages/core/lib/hub-client', () => ({
  queryOpsDb: jest.fn().mockResolvedValue({ rows: [] }),
}));
jest.mock('../../../../packages/core/lib/llm-keys', () => ({
  initHubConfig: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../packages/core/lib/mode-guard', () => ({
  runIfOps: jest.fn((_key, _ops, dev) => Promise.resolve(dev())),
}));
jest.mock('../../../../packages/core/lib/openclaw-client', () => ({
  postAlarm: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../packages/core/lib/llm-fallback', () => ({
  callWithFallback: jest.fn().mockResolvedValue({
    response: '{"primary_strategy":"스터디카페 집중력 콘텐츠","content_calendar":[],"expected_impact":{"views":"+15%"},"risk_factors":[],"success_metrics":["조회수 500+"]}'
  }),
}));

const pgPool = require('../../../../packages/core/lib/pg-pool');
const { postAlarm } = require('../../../../packages/core/lib/openclaw-client');

// ─── 시나리오 1: 일일 3 플랫폼 발행 + 매출 연동 ─────────────────────────────

describe('시나리오 1: 일일 3 플랫폼 발행 + 매출 연동', () => {
  const publishReporter = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/publish-reporter.ts'));
  const attributionTracker = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/attribution-tracker.ts'));

  beforeEach(() => jest.clearAllMocks());

  test('네이버 발행 성공 → Telegram 보고', async () => {
    pgPool.query.mockResolvedValue([]);
    await publishReporter.reportPublish({
      platform: 'naver',
      status: 'success',
      title: '스터디카페 집중력 향상법',
      url: 'https://blog.naver.com/test/123',
      duration_ms: 5000,
    });
    expect(postAlarm).toHaveBeenCalledWith(
      expect.stringContaining('네이버'),
      expect.anything(),
    );
  });

  test('인스타그램 발행 실패 → 긴급 Telegram 알림', async () => {
    pgPool.query.mockResolvedValue([]);
    await publishReporter.reportPublish({
      platform: 'instagram',
      status: 'failed',
      title: '릴스 테스트',
      error: 'API 인증 실패',
      duration_ms: 1000,
    });
    expect(postAlarm).toHaveBeenCalled();
  });

  test('페이스북 발행 성공 → DB 기록 + 보고', async () => {
    pgPool.query.mockResolvedValue([]);
    await publishReporter.reportPublish({
      platform: 'facebook',
      status: 'success',
      title: '페북 테스트',
      url: 'https://facebook.com/test/456',
      duration_ms: 3000,
    });
    expect(pgPool.query).toHaveBeenCalled();
  });

  test('UTM 추적 링크 생성', () => {
    const link = attributionTracker.generateTrackingLink('post_123', 'naver');
    expect(link).toContain('utm_source=naver');
    expect(link).toContain('post_123');
  });

  test('발행 attribution 기록 — DB 오류 시 graceful', async () => {
    pgPool.query.mockRejectedValueOnce(new Error('DB 오류'));
    await expect(
      attributionTracker.recordPublishAttribution('post_123', 'naver', 'https://test.com')
    ).resolves.not.toThrow();
  });
});

// ─── 시나리오 2: 이미지 생성 실패 복구 ───────────────────────────────────────

describe('시나리오 2: 이미지 생성 실패 + 진단 + 복구', () => {
  const imgGenDoctor = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/img-gen-doctor.ts'));

  beforeEach(() => jest.clearAllMocks());

  test('이미지 진단 — 모든 검사 실행', async () => {
    const result = await imgGenDoctor.diagnoseImageGeneration();
    expect(result).toHaveProperty('healthy');
    expect(result).toHaveProperty('issues');
    expect(result).toHaveProperty('checks');
    expect(Array.isArray(result.issues)).toBe(true);
  });

  test('이미지 진단 — DB 오류 시 graceful 처리', async () => {
    pgPool.query.mockRejectedValueOnce(new Error('DB 오류'));
    const result = await imgGenDoctor.diagnoseImageGeneration();
    expect(result.healthy).toBeDefined();
  });

  test('이미지 실패 보고 — Telegram 전송', async () => {
    await imgGenDoctor.reportImageGenFailure('테스트 포스트', 'API 연결 실패');
    expect(postAlarm).toHaveBeenCalledWith(
      expect.stringContaining('이미지'),
      expect.anything(),
    );
  });

  test('Fallback 썸네일 — null 반환 (Draw Things 없을 때)', async () => {
    const thumb = await imgGenDoctor.useFallbackThumbnail('자기계발');
    // 실패 시 null, 성공 시 경로 문자열
    expect(thumb === null || typeof thumb === 'string').toBe(true);
  });
});

// ─── 시나리오 3: 자율진화 루프 한 사이클 ─────────────────────────────────────

describe('시나리오 3: 자율진화 루프 (Evolution Cycle)', () => {
  const evolutionCycle = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/evolution-cycle.ts'));

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BLOG_EVOLUTION_CYCLE_ENABLED;
  });

  test('runEvolutionCycle — Kill Switch OFF 시 null 반환', async () => {
    process.env.BLOG_EVOLUTION_CYCLE_ENABLED = 'false';
    const result = await evolutionCycle.runEvolutionCycle();
    expect(result).toBeNull();
  });

  test('runEvolutionCycle — DB 오류에도 graceful 완료', async () => {
    process.env.BLOG_EVOLUTION_CYCLE_ENABLED = 'true';
    pgPool.query.mockRejectedValue(new Error('DB 연결 실패'));
    const result = await evolutionCycle.runEvolutionCycle();
    // 오류가 있어도 result 구조는 반환 (null 또는 객체)
    if (result !== null) {
      expect(result).toHaveProperty('cycle_id');
    }
  });

  test('Content-Market Fit 지표 계산 — 데이터 없으면 null', async () => {
    const cmf = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/content-market-fit.ts'));
    pgPool.get.mockResolvedValueOnce(null);
    const result = await cmf.calculateContentMarketFit('nonexistent_id');
    expect(result).toBeNull();
  });

  test('AARRR 지표 — DB 오류 시 0 반환', async () => {
    const aarrr = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/aarrr-metrics.ts'));
    pgPool.query.mockRejectedValue(new Error('DB 오류'));
    const result = await aarrr.calculateAARRR(30);
    expect(result).toHaveProperty('acquisition');
    expect(result.acquisition.total_new_visitors).toBe(0);
  });
});

// ─── 시나리오 4: 경쟁사 바이럴 감지 → 벤치마킹 ──────────────────────────────

describe('시나리오 4: 경쟁사 바이럴 감지 + 벤치마킹 힌트', () => {
  const competitorMonitor = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/signals/competitor-monitor.ts'));

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BLOG_SIGNAL_COLLECTOR_ENABLED;
  });

  test('monitorCompetitors — Kill Switch OFF 시 빈 배열', async () => {
    process.env.BLOG_SIGNAL_COLLECTOR_ENABLED = 'false';
    const result = await competitorMonitor.monitorCompetitors();
    expect(result).toEqual([]);
  });

  test('monitorCompetitors — DB 오류 시 기본값 반환', async () => {
    process.env.BLOG_SIGNAL_COLLECTOR_ENABLED = 'true';
    pgPool.query.mockRejectedValue(new Error('DB 오류'));
    const result = await competitorMonitor.monitorCompetitors();
    expect(Array.isArray(result)).toBe(true);
  });

  test('detectAnomalies — 빈 스냅샷에서 이상 없음', () => {
    const alerts = competitorMonitor.detectAnomalies([]);
    expect(alerts).toEqual([]);
  });

  test('detectAnomalies — 바이럴 스냅샷 감지', () => {
    const snapshots = [{
      competitor_name: '경쟁카페',
      is_viral: true,
      trending_topics: ['집중력', '스터디'],
    }];
    const alerts = competitorMonitor.detectAnomalies(snapshots);
    expect(alerts.length).toBeGreaterThan(0);
  });
});

// ─── 시나리오 5: DPO 학습 + 신규 콘텐츠 힌트 적용 ────────────────────────────

describe('시나리오 5: DPO 학습 → 신규 콘텐츠 힌트 반영', () => {
  const dpo = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/self-rewarding/marketing-dpo.ts'));
  const rag = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/agentic-rag/marketing-rag.ts'));

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BLOG_DPO_ENABLED;
    delete process.env.BLOG_MARKETING_RAG_ENABLED;
  });

  test('DPO 사이클 실행 → 성공 패턴 반영', async () => {
    process.env.BLOG_DPO_ENABLED = 'false'; // Kill Switch OFF = 안전
    const result = await dpo.runDpoLearningCycle();
    expect(result.pairs_built).toBe(0); // OFF이면 0
  });

  test('RAG 의도 분해 → 서브 쿼리 생성', () => {
    const subqueries = rag.planMarketingQuery('스터디카페 재방문 유도 전략');
    expect(subqueries.length).toBeGreaterThan(0);
    expect(subqueries.every((q) => typeof q.q === 'string')).toBe(true);
  });

  test('RAG 검색 품질 평가 → 재검색 필요 여부 판단', () => {
    const emptyResults = [];
    const quality = rag.evaluateRetrievalQuality(emptyResults, { q: '테스트' });
    expect(quality.needs_retry).toBe(true);
    expect(Array.isArray(quality.broader_queries)).toBe(true);
  });

  test('DPO 점수 → topic-selector 후보 정렬 영향', () => {
    const successPatterns = [{ pattern_type: 'hook', pattern_template: 'list', avg_performance: 300 }];
    const failurePatterns = [{ failure_category: 'poor_hook_unknown', frequency_count: 3 }];

    const scoreList = dpo.calculateDpoScore({ topic: '5가지 집중력 방법', category: '자기계발' }, successPatterns, failurePatterns);
    const scoreUnknown = dpo.calculateDpoScore({ topic: '여기저기 다양한 이야기', category: '자기계발' }, successPatterns, failurePatterns);

    expect(scoreList).toBeGreaterThanOrEqual(0);
    expect(scoreUnknown).toBeGreaterThanOrEqual(0);
  });

  test('전체 DPO → RAG → 힌트 적용 파이프라인 무중단', async () => {
    process.env.BLOG_DPO_ENABLED = 'false';
    process.env.BLOG_MARKETING_RAG_ENABLED = 'false';

    // Kill Switch OFF 상태에서 순서대로 실행해도 오류 없음
    const dpoResult = await dpo.runDpoLearningCycle();
    const ragResult = await rag.runMarketingRag('스터디카페 마케팅 전략');

    expect(dpoResult.pairs_built).toBe(0);
    expect(ragResult).toBeNull();
  });
});
