'use strict';

/**
 * shared/signal.js — 신호 타입 정의 (Phase 3-A 확장)
 *
 * bots/invest/lib/signal.js 대비 추가:
 *   ANALYST_TYPES: TA_MTF, MACRO, FEAR_GREED, CRYPTO_PANIC
 */

const ACTIONS = Object.freeze({
  BUY:  'BUY',
  SELL: 'SELL',
  HOLD: 'HOLD',
});

const SIGNAL_STATUS = Object.freeze({
  PENDING:   'pending',
  APPROVED:  'approved',
  REJECTED:  'rejected',
  EXECUTED:  'executed',
  FAILED:    'failed',
});

const ANALYST_TYPES = Object.freeze({
  TA:          'ta',          // 기술분석 (아리아 — 단일 타임프레임)
  TA_MTF:      'ta_mtf',      // 기술분석 멀티타임프레임 (아리아)
  ONCHAIN:     'onchain',     // 온체인·파생상품 (오라클)
  MACRO:       'macro',       // 거시경제 (오라클)
  NEWS:        'news',        // 뉴스 (헤르메스)
  SENTIMENT:   'sentiment',   // 커뮤니티 감성 (소피아)
  FEAR_GREED:  'fear_greed',  // 공포탐욕지수 (소피아)
  CRYPTO_PANIC:'crypto_panic',// CryptoPanic (소피아)
  NAVER_DISC:  'naver_disc',  // 네이버 증권 종목토론실 (소피아 — 국내주식)
  BULL:        'bull',        // 강세 리서처 (제우스)
  BEAR:        'bear',        // 약세 리서처 (아테나)
});

/**
 * 신호 검증
 * @param {object} signal
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateSignal(signal) {
  const errors = [];
  if (!signal.symbol || typeof signal.symbol !== 'string') errors.push('symbol 필수');
  if (!Object.values(ACTIONS).includes(signal.action))     errors.push(`action은 BUY/SELL/HOLD`);
  if (signal.action !== ACTIONS.HOLD) {
    if (!signal.amountUsdt || signal.amountUsdt <= 0)      errors.push('BUY/SELL 신호에 amountUsdt > 0 필요');
  }
  if (signal.confidence !== undefined) {
    if (signal.confidence < 0 || signal.confidence > 1)   errors.push('confidence는 0~1 범위');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * 분석가 결과 검증
 * @param {object} analysis
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateAnalysis(analysis) {
  const errors = [];
  if (!analysis.symbol)  errors.push('symbol 필수');
  if (!analysis.analyst) errors.push('analyst 필수');
  if (!['BUY', 'SELL', 'HOLD'].includes(analysis.signal)) errors.push('signal은 BUY/SELL/HOLD');
  if (analysis.confidence === undefined || analysis.confidence < 0 || analysis.confidence > 1) {
    errors.push('confidence는 0~1');
  }
  return { valid: errors.length === 0, errors };
}

module.exports = { ACTIONS, SIGNAL_STATUS, ANALYST_TYPES, validateSignal, validateAnalysis };
