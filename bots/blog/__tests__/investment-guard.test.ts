'use strict';

const { checkInvestmentContent } = require('../lib/investment-guard.ts');

describe('checkInvestmentContent', () => {
  test('매수 권유 감지 → passed: false', () => {
    const body = '이 코인은 지금 매수해야 합니다. BTC 매수 추천.';
    const title = '비트코인 투자 가이드';
    const result = checkInvestmentContent(body, title);
    expect(result.passed).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test('수익 확약 감지 → passed: false', () => {
    const body = '이 방법을 따르면 30% 수익 확정입니다. 원금 보장 상품입니다.';
    const title = '재테크 전략';
    const result = checkInvestmentContent(body, title);
    expect(result.passed).toBe(false);
    expect(result.warnings.some(w => w.includes('수익 확약'))).toBe(true);
  });

  test('면책 문구 없으면 mustAdd 반환', () => {
    const body = '하락장에서 멘탈을 지키는 방법을 알아봅니다.';
    const title = '하락장 투자 마인드';
    const result = checkInvestmentContent(body, title);
    expect(result.mustAdd.length).toBeGreaterThan(0);
    expect(result.mustAdd[0]).toContain('투자 권유가 아닙니다');
  });

  test('면책 문구 있으면 mustAdd 비어있음', () => {
    const body = '하락장 마인드 관리법입니다.\n\n> 📌 본 글은 정보 제공 목적이며 투자 권유가 아닙니다. 투자 판단과 책임은 본인에게 있습니다.';
    const title = '하락장 멘탈 관리';
    const result = checkInvestmentContent(body, title);
    expect(result.mustAdd.length).toBe(0);
  });

  test('정상 콘텐츠 → passed: true', () => {
    const body = '변동성이 큰 시기에 집중력을 지키는 습관을 소개합니다. 불안이 클수록 판단 빈도를 줄이는 것이 중요합니다.\n\n> 📌 본 글은 정보 제공 목적이며 투자 권유가 아닙니다. 투자 판단과 책임은 본인에게 있습니다.';
    const title = '변동성 장세에서 집중력 지키기';
    const result = checkInvestmentContent(body, title);
    expect(result.passed).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.mustAdd).toHaveLength(0);
  });
});
