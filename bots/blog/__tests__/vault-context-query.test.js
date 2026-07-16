'use strict';

const { _testOnly } = require('../lib/vault-context.ts');

const SUFFIX = '실무 사례 오류 해결';
const TOPIC = '웹표준과 접근성: 서버 사이드 렌더링(SSR)과 SEO 최적화 전략';

describe('vault context query assembly', () => {
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
});
