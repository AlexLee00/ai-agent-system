'use strict';

/**
 * lib/signal.js — 신호 타입 정의 및 검증
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
  TA:        'ta',        // 기술분석
  ONCHAIN:   'onchain',   // 온체인
  NEWS:      'news',      // 뉴스
  SENTIMENT: 'sentiment', // 감성
});

/**
 * 신호 검증
 * @param {object} signal
 * @param {string} signal.symbol    ex) 'BTC/USDT'
 * @param {string} signal.action    BUY | SELL | HOLD
 * @param {number} signal.amountUsdt 주문 금액 (USDT)
 * @param {number} signal.confidence 0~1
 * @param {string} signal.reasoning  판단 근거
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateSignal(signal) {
  const errors = [];

  if (!signal.symbol || typeof signal.symbol !== 'string') {
    errors.push('symbol 필수');
  }
  if (!Object.values(ACTIONS).includes(signal.action)) {
    errors.push(`action은 ${Object.values(ACTIONS).join('/')} 중 하나`);
  }
  if (signal.action !== ACTIONS.HOLD) {
    if (!signal.amountUsdt || signal.amountUsdt <= 0) {
      errors.push('BUY/SELL 신호에는 amountUsdt > 0 필요');
    }
  }
  if (signal.confidence !== undefined) {
    if (signal.confidence < 0 || signal.confidence > 1) {
      errors.push('confidence는 0~1 범위');
    }
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

  if (!analysis.symbol) errors.push('symbol 필수');
  if (!analysis.analyst) errors.push('analyst 필수');
  if (!['BUY', 'SELL', 'HOLD'].includes(analysis.signal)) {
    errors.push('signal은 BUY/SELL/HOLD');
  }
  if (analysis.confidence === undefined || analysis.confidence < 0 || analysis.confidence > 1) {
    errors.push('confidence는 0~1');
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { ACTIONS, SIGNAL_STATUS, ANALYST_TYPES, validateSignal, validateAnalysis };
