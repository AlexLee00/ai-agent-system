'use strict';

jest.mock('../../../packages/core/lib/pg-pool', () => ({
  query: jest.fn(),
}));

const pgPool = require('../../../packages/core/lib/pg-pool');
const { getVaultRelatedPosts, _testOnly } = require('../lib/vault-context.ts');

const SUFFIX = '실무 사례 오류 해결';
const TOPIC = '웹표준과 접근성: 서버 사이드 렌더링(SSR)과 SEO 최적화 전략';

describe('vault context query assembly', () => {
  beforeEach(() => {
    pgPool.query.mockReset();
  });

  test('does not append a suffix already included in the topic', () => {
    const topicWithSuffix = `${TOPIC} ${SUFFIX}`;
    const query = _testOnly.buildVaultRelatedQuery({
      topic: topicWithSuffix,
      curriculumKeywords: [SUFFIX],
    });

    expect(query).toBe(topicWithSuffix);
    expect(_testOnly.buildVaultRelatedQuery({
      topic: query,
      curriculumKeywords: [SUFFIX],
    })).toBe(query);
  });

  test('appends a missing suffix exactly once', () => {
    const query = _testOnly.buildVaultRelatedQuery({
      topic: TOPIC,
      curriculumKeywords: [SUFFIX],
    });

    expect(query).toBe(`${TOPIC} ${SUFFIX}`);
  });

  test('returns an empty query for empty input', () => {
    expect(_testOnly.buildVaultRelatedQuery({
      topic: '  ',
      curriculumKeywords: ['', null, undefined],
    })).toBe('');
  });

  test('bridges legacy, sourceId, and source_ref post identifiers', () => {
    expect(_testOnly.extractVaultPostId({ meta: { post_id: 41 } })).toBe(41);
    expect(_testOnly.extractVaultPostId({ meta: { sourceId: '42' } })).toBe(42);
    expect(_testOnly.extractVaultPostId({ meta: { source_ref: { id: '43' } } })).toBe(43);
  });

  test('keeps only published reference fixtures', () => {
    const index = _testOnly.buildPublishedReferenceIndex([
      { id: 51, status: 'published', filename: 'published.md', metadata: {} },
      { id: 52, status: 'ready', filename: 'ready.md', metadata: {} },
      { id: 53, status: 'replaced', filename: 'replaced.md', metadata: {} },
    ]);
    expect([...index.ids]).toEqual([51]);
    expect([...index.filenames]).toEqual(['published.md']);
  });

  test('prefilters published blog posts and groups chunks by source post before top-k', async () => {
    pgPool.query.mockResolvedValue([
      { id: 61, status: 'published', filename: 'published.md', metadata: {} },
      { id: 62, status: 'ready', filename: 'ready.md', metadata: {} },
      { id: 63, status: 'replaced', filename: 'replaced.md', metadata: {} },
    ]);
    const searchVault = jest.fn().mockResolvedValue({
      ok: true,
      results: [
        { id: 'chunk-1', title: '발행 글 첫 청크', contentPreview: '첫 요약', similarity: 0.91, meta: { sourceId: '61' } },
        { id: 'chunk-2', title: '발행 글 둘째 청크', contentPreview: '둘째 요약', similarity: 0.88, meta: { source_ref: { id: '61' } } },
        { id: 'chunk-3', title: 'ready 글', contentPreview: '제외 요약', similarity: 0.95, meta: { sourceId: '62' } },
      ],
    });

    const result = await getVaultRelatedPosts({ topic: TOPIC, postType: 'lecture', topK: 3 }, { searchVault });

    expect(searchVault).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      topK: 3,
      sourceKinds: ['blo'],
      types: ['blog_post'],
      sourceRefIds: ['61'],
      groupBySourceRef: true,
      layerSearchEnabled: false,
    }));
    expect(result.results).toHaveLength(2);
    expect(result.relatedPosts).toHaveLength(1);
    expect(result.relatedPosts[0].title).toBe('발행 글 첫 청크');

    const generalResult = await getVaultRelatedPosts({ topic: TOPIC, postType: 'general', topK: 3 }, { searchVault });
    expect(generalResult.ok).toBe(true);
    expect(generalResult.relatedPosts).toHaveLength(1);
    expect(generalResult.query).toContain('general');
  });
});
