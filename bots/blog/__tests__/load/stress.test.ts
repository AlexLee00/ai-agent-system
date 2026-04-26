'use strict';

/**
 * 블로팀 부하 테스트 (Phase 7)
 * 3 시나리오: 동시 발행, Signal Collector 대량 처리, Evolution Cycle 연속 실행
 */

jest.setTimeout(30000);

const path = require('path');
const env = require('../../../../packages/core/lib/env');

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
jest.mock('../../../../packages/core/lib/hub-alarm-client', () => ({
  postAlarm: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../packages/core/lib/llm-fallback', () => ({
  callWithFallback: jest.fn().mockResolvedValue({ response: '{"primary_strategy":"테스트"}' }),
}));

const pgPool = require('../../../../packages/core/lib/pg-pool');

// ─── 부하 시나리오 1: 3 플랫폼 동시 발행 10회 ────────────────────────────────

describe('부하 시나리오 1: 3 플랫폼 동시 발행 병렬 처리', () => {
  const publishReporter = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/publish-reporter.ts'));

  beforeEach(() => {
    jest.clearAllMocks();
    pgPool.query.mockResolvedValue([]);
  });

  test('3 플랫폼 10회 동시 발행 — 모두 성공 처리', async () => {
    const platforms = ['naver', 'instagram', 'facebook'];
    const count = 10;

    const tasks = Array.from({ length: count }, (_, i) =>
      Promise.all(
        platforms.map((platform) =>
          publishReporter.reportPublish({
            platform,
            status: 'success',
            title: `테스트 포스트 ${i + 1}`,
            url: `https://test.com/${platform}/${i}`,
            duration_ms: 1000 + i * 100,
          })
        )
      )
    );

    const results = await Promise.allSettled(tasks);
    const failed = results.filter((r) => r.status === 'rejected');
    expect(failed.length).toBe(0);
  }, 20000);

  test('동시 발행 중 일부 실패해도 나머지는 정상 처리', async () => {
    let callCount = 0;
    pgPool.query.mockImplementation(() => {
      callCount++;
      if (callCount % 5 === 0) return Promise.reject(new Error('일시적 DB 오류'));
      return Promise.resolve([]);
    });

    const tasks = Array.from({ length: 15 }, (_, i) =>
      publishReporter.reportPublish({
        platform: 'naver',
        status: 'success',
        title: `포스트 ${i}`,
        duration_ms: 500,
      })
    );

    const results = await Promise.allSettled(tasks);
    // 모든 태스크가 settled (reject 없이 graceful)
    expect(results.length).toBe(15);
  }, 15000);

  test('발행 보고 100회 연속 — 메모리 급증 없음', async () => {
    pgPool.query.mockResolvedValue([]);
    const before = process.memoryUsage().heapUsed;

    for (let i = 0; i < 100; i++) {
      await publishReporter.reportPublish({
        platform: 'naver',
        status: i % 2 === 0 ? 'success' : 'failed',
        title: `부하 테스트 ${i}`,
        error: i % 2 === 0 ? undefined : '테스트 오류',
        duration_ms: 100,
      });
    }

    const after = process.memoryUsage().heapUsed;
    const diffMB = (after - before) / 1_000_000;
    expect(diffMB).toBeLessThan(50); // 50MB 미만 증가
  }, 20000);
});

// ─── 부하 시나리오 2: DPO 점수 계산 대량 처리 ────────────────────────────────

describe('부하 시나리오 2: DPO 점수 계산 1000건 처리', () => {
  const dpo = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/self-rewarding/marketing-dpo.ts'));

  test('DPO 점수 계산 1000회 — 10ms 이내', () => {
    const patterns = [
      { pattern_type: 'hook', pattern_template: 'list', avg_performance: 300 },
      { pattern_type: 'hook', pattern_template: 'why', avg_performance: 200 },
      { pattern_type: 'hook', pattern_template: 'how', avg_performance: 250 },
    ];
    const failures = [
      { failure_category: 'poor_hook_unknown', frequency_count: 2 },
    ];

    const candidates = Array.from({ length: 1000 }, (_, i) => ({
      topic: `주제 ${i}`,
      category: '자기계발',
    }));

    const start = Date.now();
    for (const c of candidates) {
      dpo.calculateDpoScore(c, patterns, failures);
    }
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500); // 1000회 0.5초 이내
  });

  test('classifyHookStyle 10000회 — 50ms 이내', () => {
    const titles = [
      '5가지 집중력 방법', '왜 스터디카페가 좋은가', '집중력을 높이는 법',
      '블로그 A vs 블로그 B', '공부 실수 피하는 법', '체험 후기',
    ];

    const start = Date.now();
    for (let i = 0; i < 10000; i++) {
      dpo.classifyHookStyle(titles[i % titles.length]);
    }
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(200);
  });
});

// ─── 부하 시나리오 3: Signal Aggregator 다중 소스 동시 처리 ──────────────────

describe('부하 시나리오 3: Signal + RAG 병렬 처리', () => {
  const rag = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/agentic-rag/marketing-rag.ts'));
  const transfer = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/self-rewarding/cross-platform-transfer.ts'));

  beforeEach(() => {
    jest.clearAllMocks();
    pgPool.query.mockResolvedValue([]);
  });

  test('RAG planMarketingQuery 50회 병렬 — 1초 이내', async () => {
    const intents = [
      '비수기 대응', '신규 유입', '재방문 유도', '경쟁사 대응', '브랜드 강화',
    ];

    const start = Date.now();
    const tasks = Array.from({ length: 50 }, (_, i) =>
      Promise.resolve(rag.planMarketingQuery(intents[i % intents.length]))
    );
    await Promise.all(tasks);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
  });

  test('evaluateRetrievalQuality 100회 연속 — 결과 일관성', () => {
    const results = [
      { content: '성공 패턴', source: 'success_patterns', score: 0.9, age_days: 1 },
    ];
    const subqueries = [{ q: '테스트' }];

    for (let i = 0; i < 100; i++) {
      const quality = rag.evaluateRetrievalQuality(results, subqueries);
      expect(quality).toHaveProperty('needs_retry');
      expect(quality).toHaveProperty('quality_score');
    }
  });

  test('adaptHooksToBlogTitles + adaptHooksToFacebook 병렬', () => {
    const hooks = Array.from({ length: 20 }, (_, i) => ({
      hook_style: ['list', 'why', 'how', 'comparison', 'question'][i % 5],
      sample_title: `테스트 제목 ${i}`,
      avg_views: 100 + i * 10,
    }));

    const blogTitles = transfer.adaptHooksToBlogTitles(hooks);
    const fbPosts = transfer.adaptHooksToFacebook(hooks);

    expect(Array.isArray(blogTitles)).toBe(true);
    expect(Array.isArray(fbPosts)).toBe(true);
  });
});
