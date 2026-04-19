'use strict';

const router = require('../lib/case-router');

describe('case-router', () => {
  describe('isValidType', () => {
    test.each(['copyright', 'defect', 'contract', 'trade_secret', 'other'])(
      '%s는 유효한 유형',
      (type) => expect(router.isValidType(type)).toBe(true)
    );

    test('알 수 없는 유형은 false', () => {
      expect(router.isValidType('unknown')).toBe(false);
      expect(router.isValidType('')).toBe(false);
    });
  });

  describe('typeLabel', () => {
    test('copyright → 저작권 침해', () => {
      expect(router.typeLabel('copyright')).toBe('저작권 침해');
    });
    test('알 수 없는 유형 → 알 수 없음', () => {
      expect(router.typeLabel('xyz')).toBe('알 수 없음');
    });
  });

  describe('getAgentRoute', () => {
    test('copyright — lens가 required에 포함', () => {
      const route = router.getAgentRoute('copyright');
      expect(route.required).toContain('lens');
      expect(route.required).toContain('balance');
    });

    test('contract — contro가 required에 포함', () => {
      const route = router.getAgentRoute('contract');
      expect(route.required).toContain('contro');
    });

    test('알 수 없는 유형은 other 라우팅 반환', () => {
      const route = router.getAgentRoute('xyz');
      expect(route).toEqual(router.AGENT_ROUTES.other);
    });

    test('모든 유형에 quill + balance 포함', () => {
      for (const type of Object.keys(router.CASE_TYPES)) {
        const route = router.getAgentRoute(type);
        expect(route.required).toContain('quill');
        expect(route.required).toContain('balance');
      }
    });
  });

  describe('inferTypeFromKeywords', () => {
    test('저작권 키워드 → copyright', () => {
      expect(router.inferTypeFromKeywords('소스코드 유사 복제 여부', [])).toBe('copyright');
    });

    test('영업비밀 키워드 → trade_secret', () => {
      expect(router.inferTypeFromKeywords('영업비밀 유출 혐의', [])).toBe('trade_secret');
    });

    test('하자 키워드 → defect', () => {
      expect(router.inferTypeFromKeywords('소프트웨어 하자 결함', [])).toBe('defect');
    });

    test('계약 키워드 → contract', () => {
      expect(router.inferTypeFromKeywords('', ['용역계약 위반', '납품 지체상금'])).toBe('contract');
    });

    test('매칭 없음 → other', () => {
      expect(router.inferTypeFromKeywords('일반 분쟁', [])).toBe('other');
    });

    test('빈 입력 → other', () => {
      expect(router.inferTypeFromKeywords('', [])).toBe('other');
    });
  });
});
