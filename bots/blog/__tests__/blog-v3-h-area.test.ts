'use strict';

/**
 * Blog V3 H영역 Goal-Driven 5/5 smoke tests
 *
 * ① IT 트렌드 추출 동작 (fixture 모드)
 * ② 베스트셀러 동기화 동작 (dry-run — run-bestseller-sync.ts 파일 + saveTrendTopics 검증)
 * ③ 통합 토픽 선정 동작 (calculateTrendFusionScore + buildNaverTrendTopics)
 * ④ 매일/매주 자동 (launchd plist 존재 + 스케줄 검증)
 * ⑤ Hub LLM Gateway 통과 (saveTrendTopics dry-run, 다중 소스 통합)
 */

const path = require('path');
const fs   = require('fs');
const env  = require('../../../packages/core/lib/env');

// ── 공통 모킹 ────────────────────────────────────────────────────────────────

jest.mock('../../../packages/core/lib/pg-pool', () => ({
  run:   jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  get:   jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../packages/core/lib/hub-client', () => ({
  fetchHubSecrets: jest.fn().mockResolvedValue(null),
  queryOpsDb:      jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
}));

const pgPool = require('../../../packages/core/lib/pg-pool');
const { queryOpsDb } = require('../../../packages/core/lib/hub-client');

// ── ① IT 트렌드 추출 (fixture 모드) ───────────────────────────────────────

describe('① IT 트렌드 추출 — fixture 모드', () => {
  const scriptPath = path.join(env.PROJECT_ROOT, 'bots/blog/lib/it-trends-collector.ts');

  test('스크립트 파일 존재', () => {
    expect(fs.existsSync(scriptPath)).toBe(true);
  });

  test('fixture 실행 → ok:true + items 배열', async () => {
    const { runItTrendsCollector } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/it-trends-collector.ts'));
    const result = await runItTrendsCollector({ fixture: true, dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
    const item = result.items[0];
    expect(item).toHaveProperty('title');
    expect(item).toHaveProperty('title_pattern');
    expect(item).toHaveProperty('score_signal');
    expect(item.genre).toBe('it');
  });

  test('fixture 토픽 trend_score 0~100 범위', () => {
    const { buildItTrendTopics, fixtureItTrendItems } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/it-trends-collector.ts'));
    const topics = buildItTrendTopics(fixtureItTrendItems());
    for (const t of topics) {
      expect(t.trend_score).toBeGreaterThanOrEqual(0);
      expect(t.trend_score).toBeLessThanOrEqual(100);
      expect(typeof t.topic_ko).toBe('string');
    }
  });
});

// ── ② 베스트셀러 동기화 — 파일 존재 + saveTrendTopics 베스트셀러 경로 ──────

describe('② 베스트셀러 동기화 — 파일 구조 + trend_topics 연동', () => {
  const BLOG_LIB = path.join(env.PROJECT_ROOT, 'bots/blog/lib');
  const SCRIPTS  = path.join(env.PROJECT_ROOT, 'bots/blog/scripts');

  test('bestseller-fetcher.ts 파일 존재', () => {
    expect(fs.existsSync(path.join(BLOG_LIB, 'bestseller-fetcher.ts'))).toBe(true);
  });

  test('run-bestseller-sync.ts 스크립트 파일 존재', () => {
    expect(fs.existsSync(path.join(SCRIPTS, 'run-bestseller-sync.ts'))).toBe(true);
  });

  test('run-bestseller-sync.ts에 ensureBlogV3Tables 및 saveTrendTopics 참조', () => {
    const content = fs.readFileSync(path.join(SCRIPTS, 'run-bestseller-sync.ts'), 'utf8');
    expect(content).toContain('saveTrendTopics');
    expect(content).toContain('ensureBlogV3Tables');
  });

  test('saveTrendTopics — 베스트셀러 도서 포맷 dry-run', async () => {
    const { saveTrendTopics } = require(
      path.join(env.PROJECT_ROOT, 'bots/blog/lib/blog-v3-unified.ts')
    );
    jest.clearAllMocks();
    const bookTopics = [
      {
        topic_ko:        '2024 IT 베스트셀러: 클린 아키텍처',
        category:        '도서',
        keywords:        ['로버트 마틴', '인사이트'],
        trend_score:     60,
        korea_relevance: 85,
        is_book_topic:   true,
        meta:            { isbn: '9788966261367', pub_date: '2023-01-01' },
      },
    ];
    const result = await saveTrendTopics(bookTopics, 'bestseller', { dryRun: true, addedBy: 'bestseller-sync' });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.candidates).toBe(1);
    expect(result.inserted).toBe(0);
    expect(result.source).toBe('bestseller');
    expect(pgPool.run.mock.calls.length).toBe(0);
  });

  test('베스트셀러 fusion score — is_book_topic bonus 포함', () => {
    const { calculateTrendFusionScore } = require(
      path.join(env.PROJECT_ROOT, 'bots/blog/lib/blog-v3-unified.ts')
    );
    const withBook    = calculateTrendFusionScore({ source: 'bestseller', trend_score: 70, korea_relevance: 85, is_book_topic: true });
    const withoutBook = calculateTrendFusionScore({ source: 'bestseller', trend_score: 70, korea_relevance: 85, is_book_topic: false });
    expect(withBook.score).toBeGreaterThan(withoutBook.score);
  });
});

// ── ③ 통합 토픽 선정 — calculateTrendFusionScore + buildNaverTrendTopics ──

describe('③ 통합 토픽 선정 — 3원 fusion score', () => {
  const { calculateTrendFusionScore, saveTrendTopics, buildNaverTrendTopics } = require(
    path.join(env.PROJECT_ROOT, 'bots/blog/lib/blog-v3-unified.ts')
  );

  test('HN 토픽 fusion 점수 계산', () => {
    const fusion = calculateTrendFusionScore({
      source:          'hn',
      topic_ko:        'AI 도구 자동화 흐름에서 지금 확인할 실행 기준',
      trend_score:     84,
      korea_relevance: 78,
      is_book_topic:   false,
      date:            new Date().toISOString(),
      meta:            { source_count: 1, sources: ['hn'] },
    });
    expect(fusion.score).toBeGreaterThan(0);
    expect(fusion.score).toBeLessThanOrEqual(100);
    expect(fusion.source).toBe('hn');
    expect(typeof fusion.sourceWeight).toBe('number');
  });

  test('Naver IT 토픽이 HN보다 source weight 높음', () => {
    const base = { trend_score: 80, korea_relevance: 90, is_book_topic: false };
    const naverScore = calculateTrendFusionScore({ ...base, source: 'naver_it' }).score;
    const hnScore    = calculateTrendFusionScore({ ...base, source: 'hn' }).score;
    expect(naverScore).toBeGreaterThan(hnScore);
  });

  test('다중 출처 diversityBonus 반영', () => {
    const base = { source: 'hn', trend_score: 80, korea_relevance: 80 };
    const single = calculateTrendFusionScore({ ...base, meta: { source_count: 1 } });
    const multi  = calculateTrendFusionScore({ ...base, meta: { source_count: 3, sources: ['hn', 'naver_it', 'bestseller'] } });
    expect(multi.score).toBeGreaterThan(single.score);
  });

  test('saveTrendTopics dry-run — DB 미기록', async () => {
    jest.clearAllMocks();
    const topics = [{ topic_ko: '테스트 토픽', category: '최신IT트렌드', trend_score: 70, korea_relevance: 75 }];
    const result = await saveTrendTopics(topics, 'hn', { dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.inserted).toBe(0);
    expect(result.candidates).toBe(1);
    expect(pgPool.run.mock.calls.length).toBe(0);
  });

  test('buildNaverTrendTopics — 기본 픽스처 토픽 생성', () => {
    const topics = buildNaverTrendTopics();
    expect(Array.isArray(topics)).toBe(true);
    expect(topics.length).toBeGreaterThan(0);
    for (const t of topics) {
      expect(t).toHaveProperty('topic_ko');
      expect(t.trend_score).toBeGreaterThanOrEqual(0);
      expect(t.trend_score).toBeLessThanOrEqual(100);
    }
  });

  test('buildNaverTrendTopics — IT 키워드 → 최신IT트렌드', () => {
    const topics = buildNaverTrendTopics([{ keyword: 'AI 개발 자동화', trend_score: 80, growth_rate_week: 20 }]);
    expect(topics[0].category).toBe('최신IT트렌드');
  });

  test('buildNaverTrendTopics — 도서 키워드 → 자기계발', () => {
    const topics = buildNaverTrendTopics([{ keyword: '독서 루틴', trend_score: 72, growth_rate_week: 15 }]);
    expect(topics[0].category).toBe('자기계발');
  });
});

// ── ④ 매일/매주 자동 — launchd plist 검증 ──────────────────────────────────

describe('④ 매일/매주 자동 — launchd plist', () => {
  const LAUNCHD_DIR = path.join(env.PROJECT_ROOT, 'bots/blog/launchd');

  test('ai.blog.reddit-trends.plist 파일 존재', () => {
    expect(fs.existsSync(path.join(LAUNCHD_DIR, 'ai.blog.reddit-trends.plist'))).toBe(true);
  });

  test('ai.blog.bestseller-sync.plist 파일 존재', () => {
    expect(fs.existsSync(path.join(LAUNCHD_DIR, 'ai.blog.bestseller-sync.plist'))).toBe(true);
  });

  test('reddit-trends plist — 매일 06:00 KST (Hour=6, Weekday 없음)', () => {
    const content = fs.readFileSync(path.join(LAUNCHD_DIR, 'ai.blog.reddit-trends.plist'), 'utf8');
    expect(content).toContain('<integer>6</integer>');
    expect(content).not.toContain('<key>Weekday</key>');
  });

  test('bestseller-sync plist — 매주 월요일(Weekday=1) 07:00', () => {
    const content = fs.readFileSync(path.join(LAUNCHD_DIR, 'ai.blog.bestseller-sync.plist'), 'utf8');
    expect(content).toContain('<key>Weekday</key>');
    expect(content).toContain('<integer>1</integer>');
    expect(content).toContain('<integer>7</integer>');
  });

  test('reddit-trends plist — run-trend-collector 스크립트 참조', () => {
    const content = fs.readFileSync(path.join(LAUNCHD_DIR, 'ai.blog.reddit-trends.plist'), 'utf8');
    expect(content).toContain('run-trend-collector');
  });

  test('bestseller-sync plist — run-bestseller-sync 스크립트 참조', () => {
    const content = fs.readFileSync(path.join(LAUNCHD_DIR, 'ai.blog.bestseller-sync.plist'), 'utf8');
    expect(content).toContain('run-bestseller-sync');
  });
});

// ── ⑤ Hub LLM Gateway 통과 — dry-run 통합 검증 ─────────────────────────────

describe('⑤ Hub LLM Gateway 통과 — dry-run 통합 검증', () => {
  const {
    saveTrendTopics,
    buildNaverTrendTopics,
    ensureBlogV3Tables,
    calculateTrendFusionScore,
    buildTrendTopicFusionClusters,
    topicSimilarity,
  } = require(
    path.join(env.PROJECT_ROOT, 'bots/blog/lib/blog-v3-unified.ts')
  );

  beforeEach(() => jest.clearAllMocks());

  test('ensureBlogV3Tables — pgPool.run 호출 (trend_topics DDL)', async () => {
    await ensureBlogV3Tables();
    expect(pgPool.run.mock.calls.length).toBeGreaterThanOrEqual(1);
    const firstCall = pgPool.run.mock.calls[0];
    expect(firstCall[0]).toBe('blog');
    expect(firstCall[1]).toContain('trend_topics');
  });

  test('HN + Naver IT 통합 dry-run — candidates 합산', async () => {
    const hnTopics = [
      { topic_ko: 'AI 자동화 도구', trend_score: 82, korea_relevance: 78, category: '최신IT트렌드' },
    ];
    const naverTopics = buildNaverTrendTopics([{ keyword: 'AI 개발', trend_score: 80, growth_rate_week: 25 }]);

    const h = await saveTrendTopics(hnTopics, 'hn', { dryRun: true });
    const n = await saveTrendTopics(naverTopics,  'naver_it',  { dryRun: true });

    expect(h.candidates).toBe(1);
    expect(n.candidates).toBe(1);
    expect(h.inserted + n.inserted).toBe(0);
  });

  test('dry-run에서 Hub LLM INSERT 없음', async () => {
    const topics = [{ topic_ko: 'SaaS 구독 피로 이후 도구 선택', trend_score: 72, korea_relevance: 80 }];
    await saveTrendTopics(topics, 'hn', { dryRun: true, addedBy: 'it-trends-collector' });
    const insertCalls = pgPool.run.mock.calls.filter(
      (args) => String(args[1] || '').toLowerCase().includes('insert'),
    );
    expect(insertCalls.length).toBe(0);
  });

  test('source 정규화 — hn/devto/aladin/naver_it 모두 유효한 점수', () => {
    ['hn', 'devto', 'aladin_blogbest', 'naver_it'].forEach((src) => {
      const r = calculateTrendFusionScore({ source: src, trend_score: 75, korea_relevance: 75 });
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThanOrEqual(100);
    });
  });

  test('3원 통합 점수 — hn+naver_it+bestseller 조합', () => {
    const scores = ['hn', 'naver_it', 'bestseller'].map((src) =>
      calculateTrendFusionScore({ source: src, trend_score: 80, korea_relevance: 80 })
    );
    // 모두 유효한 점수 반환
    scores.forEach((s) => {
      expect(s.score).toBeGreaterThan(0);
      expect(s.sourceWeight).toBeGreaterThan(0);
    });
    const [hnScore, naverScore, bestsellerScore] = scores.map((s) => s.score);
    expect(naverScore).toBeGreaterThanOrEqual(hnScore);
    expect(hnScore).toBeGreaterThan(bestsellerScore);
  });

  test('semantic 3원 fusion — 제목이 달라도 관련 토픽은 하나의 클러스터로 묶는다', () => {
    const similarity = topicSimilarity('AI 도구 자동화 흐름에서 지금 확인할 실행 기준', 'AI 개발 자동화 도구 선택 기준');
    expect(similarity).toBeGreaterThanOrEqual(0.34);

    const clusters = buildTrendTopicFusionClusters([
      {
        id: 1,
        source: 'hn',
        topic_ko: 'AI 도구 자동화 흐름에서 지금 확인할 실행 기준',
        category: '최신IT트렌드',
        trend_score: 84,
        korea_relevance: 78,
      },
      {
        id: 2,
        source: 'naver_it',
        topic_ko: 'AI 개발 자동화 도구 선택 기준',
        category: '최신IT트렌드',
        trend_score: 80,
        korea_relevance: 90,
      },
      {
        id: 3,
        source: 'bestseller',
        topic_ko: '자동화 시대에 다시 읽는 실무 생산성',
        category: '자기계발',
        trend_score: 70,
        korea_relevance: 85,
        is_book_topic: true,
      },
    ]);

    const multi = clusters.find((cluster) => cluster.sourceCount >= 2);
    expect(multi).toBeTruthy();
    expect(multi.sources).toEqual(expect.arrayContaining(['hn', 'naver_it']));
    expect(multi.fusion.score).toBeGreaterThan(70);
  });

  test('trend topic dry-run 선택은 used/evidence DB 상태를 변경하지 않는다', async () => {
    const { selectTopicWithCandidateFallback } = require(
      path.join(env.PROJECT_ROOT, 'bots/blog/lib/topic-selector.ts')
    );
    jest.clearAllMocks();
    queryOpsDb.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('FROM blog.trend_topics')) {
        return {
          rows: [{
            id: 77,
            source: 'naver',
            topic_ko: 'AI 자동화 도구 선택법 3가지',
            category: '최신IT트렌드',
            trend_score: 88,
            korea_relevance: 92,
            is_book_topic: false,
            meta: {},
            date: '2026-05-25',
            created_at: new Date().toISOString(),
          }],
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const selected = await selectTopicWithCandidateFallback(
      '최신IT트렌드',
      '2026-05-25',
      [],
      {},
      null,
      null,
      [],
      { dryRun: true },
    );

    expect(selected?.source).toBe('trend_naver');
    expect(queryOpsDb.mock.calls.some(([sql]) => /UPDATE\s+blog\.trend_topics/i.test(String(sql)))).toBe(false);
    expect(pgPool.run.mock.calls.some(([sql]) => /blog_v3_shadow_evidence/i.test(String(sql)))).toBe(false);
  });
});
