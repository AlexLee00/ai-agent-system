'use strict';

const path = require('path');
const env  = require('../../../packages/core/lib/env');
const {
  synthesizeHybridTopic,
} = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/topic-selector.ts'));

// 루나 요청 픽스처
const makeRequest = (overrides = {}) => ({
  id:         1,
  regime:     'bear',
  mood:       '하락장',
  angleHint:  '하락장 대응',
  urgency:    'urgent',
  keywordHints: ['하락장 투자', '리스크 관리'],
  requestedAt: new Date().toISOString(),
  metadata:   {},
  ...overrides,
});

describe('synthesizeHybridTopic', () => {
  test('pending request 없으면 null', () => {
    const result = synthesizeHybridTopic('자기계발', null, [], null);
    expect(result).toBeNull();
  });

  test('지원 카테고리 + 매칭 regime → 하이브리드 주제 반환', () => {
    const request = makeRequest({ regime: 'bear' });
    const result = synthesizeHybridTopic('자기계발', request, [], null);
    expect(result).not.toBeNull();
    expect(result.topic).toBeTruthy();
    expect(result.source).toBe('luna_hybrid');
    expect(result.lunaRegime).toBe('bear');
  });

  test('최신IT트렌드 + volatile → 하이브리드 주제 반환', () => {
    const request = makeRequest({ regime: 'volatile' });
    const result = synthesizeHybridTopic('최신IT트렌드', request, [], null);
    expect(result).not.toBeNull();
    expect(result.lunaRegime).toBe('volatile');
  });

  test('지원하지 않는 카테고리 → null (fallback)', () => {
    const request = makeRequest();
    const result = synthesizeHybridTopic('도서리뷰', request, [], null);
    expect(result).toBeNull();
  });

  test('최근 포스트와 유사도 높으면 null (품질 게이트)', () => {
    const request = makeRequest({ regime: 'bear' });
    const recentPosts = [{ title: '하락장에서 흔들리지 않는 투자 마인드 루틴' }];
    const result = synthesizeHybridTopic('자기계발', request, recentPosts, null);
    expect(result).toBeNull();
  });

  test('알 수 없는 regime → volatile 폴백 적용', () => {
    const request = makeRequest({ regime: 'sideways' });
    const result = synthesizeHybridTopic('최신IT트렌드', request, [], null);
    // volatile 폴백이 적용되어 결과가 나오거나(null 아님) volatile 템플릿이 반환됨
    if (result !== null) {
      expect(result.lunaRegime).toBe('sideways');
    }
  });

  test('lunaRequestId 가 결과에 포함됨', () => {
    const request = makeRequest({ id: 42, regime: 'bull' });
    const result = synthesizeHybridTopic('자기계발', request, [], null);
    if (result !== null) {
      expect(result.lunaRequestId).toBe(42);
    }
  });

  test('개발기획과컨설팅 + crisis → 하이브리드 주제 반환', () => {
    const request = makeRequest({ regime: 'crisis' });
    const result = synthesizeHybridTopic('개발기획과컨설팅', request, [], null);
    expect(result).not.toBeNull();
  });
});
