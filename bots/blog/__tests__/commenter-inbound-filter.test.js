'use strict';

const { assessInboundComment } = require('../lib/commenter.ts');

describe('commenter inbound filters', () => {
  test('skips promotional recruitment comments with external url', () => {
    const result = assessInboundComment({
      comment_text: '브랜드의 베스트셀러 제품 체험자를 찾고 있습니다! 제품은 반납없이 소유, 리뷰비 30,000원, 작성 가능하신 분 https://m.site.naver.com/274gP',
    });

    expect(result).toEqual({
      ok: false,
      reason: 'promotional_recruitment_comment_with_url',
    });
  });

  test('keeps reflective normal comments replyable', () => {
    const result = assessInboundComment({
      comment_text: '2026년 IT 흐름을 자동화 중심으로 풀어주신 점이 인상적이네요. 자동화가 의사결정까지 확장된다는 설명이 특히 와닿았습니다.',
    });

    expect(result.ok).toBe(true);
  });
});
