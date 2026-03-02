'use strict';

/**
 * team/argos.js — 아르고스 (전략 수집봇)
 *
 * 역할: 외부 트레이딩 전략·리서치 수집 및 팀 공유
 * LLM: 추후 (전략 요약·변환)
 * 상태: Skeleton — Phase 3-E에서 구현 예정
 *
 * 아이디어:
 *  - TradingView 공개 전략 파인스크립트 크롤링
 *  - Quantopian / Alpaca 공개 알고리즘 수집
 *  - 트위터/레딧 알파 신호 추출
 *  - 팀원별 전략 성과 비교·추천
 *
 * 실행: node team/argos.js (단독 실행 불가 — Phase 3-E에서 구현)
 */

/**
 * 전략 수집 (Skeleton)
 * @param {string} source  'tradingview' | 'reddit' | 'custom'
 * @returns {Promise<Array>}
 */
async function collectStrategies(source = 'custom') {
  console.log(`\n👁️ [아르고스] 전략 수집: ${source}`);
  console.log('  ℹ️ Skeleton — Phase 3-E에서 구현 예정');

  // TODO: Phase 3-E
  // 1. TradingView 공개 전략 수집 (파인스크립트 파싱)
  // 2. Reddit r/algotrading 인기 전략 추출
  // 3. LLM으로 전략 요약 + 크로노스 호환 형식 변환
  // 4. DB 저장 + 팀 공유 텔레그램

  return [];
}

/**
 * 전략 추천 (Skeleton)
 * @param {string} symbol
 * @param {string} exchange
 */
async function recommendStrategy(symbol, exchange = 'binance') {
  console.log(`\n👁️ [아르고스] ${symbol} 전략 추천 — Skeleton`);
  return null;
}

// CLI 실행
if (require.main === module) {
  console.log('👁️ [아르고스] Phase 3-E 구현 예정 — 현재 Skeleton');
  process.exit(0);
}

module.exports = { collectStrategies, recommendStrategy };
