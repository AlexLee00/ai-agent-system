/**
 * shared/signal.js — 신호 타입 정의 + 실행 진입점 (Phase 3-A+)
 *
 * executeSignal(): 모든 실행봇의 단일 진입점
 *   1단계 — PAPER_MODE 최우선 체크
 *   2단계 — 자산 보호 5원칙 검사
 *   3단계 — 거래소 라우팅 (헤파이스토스 / 한울)
 */

import * as db from './db.js';
import { isPaperMode } from './secrets.js';
import { publishToMainBot } from './mainbot-client.js';

export const ACTIONS = Object.freeze({
  BUY:  'BUY',
  SELL: 'SELL',
  HOLD: 'HOLD',
});

export const SIGNAL_STATUS = Object.freeze({
  PENDING:   'pending',
  APPROVED:  'approved',
  REJECTED:  'rejected',
  EXECUTED:  'executed',
  FAILED:    'failed',
});

export const ANALYST_TYPES = Object.freeze({
  TA:          'ta',          // 기술분석 (아리아 — 단일 타임프레임)
  TA_MTF:      'ta_mtf',      // 기술분석 멀티타임프레임 (아리아)
  ONCHAIN:     'onchain',     // 온체인·파생상품 (오라클)
  MACRO:       'macro',       // 거시경제 (오라클)
  NEWS:        'news',        // 뉴스 (헤르메스)
  SENTIMENT:   'sentiment',   // 커뮤니티 감성 (소피아)
  X_SEARCH:    'x_search',    // X/검색 감성 확장 (레거시 호환)
  SENTINEL:    'sentinel',    // 외부 인텔리전스 통합 래퍼 (헤르메스+소피아)
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
export function validateSignal(signal) {
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
export function validateAnalysis(analysis) {
  const errors = [];
  if (!analysis.symbol)  errors.push('symbol 필수');
  if (!analysis.analyst) errors.push('analyst 필수');
  if (!['BUY', 'SELL', 'HOLD'].includes(analysis.signal)) errors.push('signal은 BUY/SELL/HOLD');
  if (analysis.confidence === undefined || analysis.confidence < 0 || analysis.confidence > 1) {
    errors.push('confidence는 0~1');
  }
  return { valid: errors.length === 0, errors };
}

// ─── 자산 보호 5원칙 ────────────────────────────────────────────────

const SAFETY = {
  MAX_SINGLE_PCT:  0.10,  // 단일 포지션 ≤ 10%
  MAX_POSITIONS:   3,     // 동시 포지션 ≤ 3개
  MAX_DAILY_LOSS:  0.03,  // 일손실 ≤ 3%
  MAX_DRAWDOWN:    0.15,  // 최대 드로우다운 ≤ 15%
  INITIAL_EQUITY:  138.71, // 초기 자산 폴백 (USD)
};

async function getTotalAsset() {
  const equity = await db.getLatestEquity();
  return equity ?? SAFETY.INITIAL_EQUITY;
}

async function getMaxDrawdown() {
  const rows = await db.getEquityHistory(200);
  if (rows.length < 2) return 0;
  let peak = rows[0].equity;
  let maxDD = 0;
  for (const r of rows) {
    if (r.equity > peak) peak = r.equity;
    const dd = peak > 0 ? (peak - r.equity) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

/**
 * 자산 보호 5원칙 검사
 * BUY: 전체 5원칙 / SELL: 원칙 3·4·5만
 */
export async function checkSafetyGates(signal) {
  const { action, amount_usdt: orderValue, symbol } = signal;
  const isBuy = action === ACTIONS.BUY;
  const totalAsset = await getTotalAsset();

  // 원칙 1 — 단일 포지션 ≤ 10%
  if (isBuy && orderValue > totalAsset * SAFETY.MAX_SINGLE_PCT) {
    return {
      passed: false,
      reason: `원칙1 위반: 단일 포지션 한도 초과 ($${orderValue?.toFixed(0)} > $${(totalAsset * SAFETY.MAX_SINGLE_PCT).toFixed(0)})`,
    };
  }

  // 원칙 2 — 동시 포지션 ≤ 3개
  if (isBuy) {
    const positions = await db.getAllPositions();
    if (positions.length >= SAFETY.MAX_POSITIONS) {
      return { passed: false, reason: `원칙2 위반: 동시 포지션 한도 (현재 ${positions.length}개, 최대 ${SAFETY.MAX_POSITIONS}개)` };
    }
  }

  // 원칙 3 — 일일 손실 ≤ 3%
  const { pnl } = await db.getTodayPnl();
  if ((pnl ?? 0) < -(totalAsset * SAFETY.MAX_DAILY_LOSS)) {
    return {
      passed: false,
      reason: `원칙3 위반: 일일 손실 한도 초과 ($${Math.abs(pnl).toFixed(2)} > $${(totalAsset * SAFETY.MAX_DAILY_LOSS).toFixed(2)})`,
    };
  }

  // 원칙 4 — 연속 3회 손실 → 24시간 중단
  const recent = await db.query(
    `SELECT total_usdt, side FROM trades ORDER BY executed_at DESC LIMIT 3`,
  );
  if (recent.length === 3) {
    const allLoss = recent.every(r => (r.side === 'sell' ? r.total_usdt : -r.total_usdt) < 0);
    if (allLoss) {
      return { passed: false, reason: '원칙4 위반: 연속 3회 손실 → 24시간 매매 중단' };
    }
  }

  // 원칙 5 — 최대 드로우다운 ≤ 15%
  const maxDD = await getMaxDrawdown();
  if (maxDD > SAFETY.MAX_DRAWDOWN) {
    return {
      passed: false,
      reason: `원칙5 위반: 최대 드로우다운 초과 (${(maxDD * 100).toFixed(1)}% > 15%) → 사용자 승인 필요`,
    };
  }

  return { passed: true };
}

// ─── 단일 실행 진입점 ───────────────────────────────────────────────

/**
 * executeSignal — 모든 실행봇의 단일 진입점
 *
 * 어떤 경우에도 이 함수를 통해서만 실행해야 한다.
 *
 * @param {object} signal  { symbol, action, amount_usdt, exchange, ... }
 * @returns {Promise<any>}
 */
export async function executeSignal(signal) {
  const traceId  = `SIG-${(signal.exchange || 'UNK').toUpperCase()}-${Date.now()}`;
  signal.traceId = traceId;

  const paperMode = isPaperMode();

  // ── 1단계: PAPER_MODE 최우선 체크 ───────────────────────────────
  if (paperMode) {
    const msg = `[PAPER:${traceId}] ${signal.symbol} ${signal.action} $${signal.amount_usdt}`;
    console.log(msg);
    await db.run(
      `UPDATE signals SET trace_id = ?, status = 'paper' WHERE id = ?`,
      [traceId, signal.id ?? ''],
    ).catch(() => {});
    publishToMainBot({ from_bot: 'luna', event_type: 'trade', alert_level: 1, message: msg, payload: signal });
    return { executed: false, mode: 'paper', traceId };
  }

  // ── 2단계: 자산 보호 5원칙 검사 ─────────────────────────────────
  const guard = await checkSafetyGates(signal);
  if (!guard.passed) {
    console.warn(`[GUARD:${traceId}] 차단 — ${guard.reason}`);
    const guardMsg = `🛡️ 안전장치 발동\n사유: ${guard.reason}\n신호: ${signal.symbol} ${signal.action}`;
    publishToMainBot({ from_bot: 'luna', event_type: 'alert', alert_level: 3, message: guardMsg, payload: { reason: guard.reason, signal } });
    await db.updateSignalBlock(signal.id ?? '', {
      status: 'blocked',
      reason: guard.reason,
      code: 'safety_gate_blocked',
      meta: {
        traceId,
        exchange: signal.exchange,
        symbol: signal.symbol,
        action: signal.action,
        amount: signal.amount_usdt,
      },
    }).catch(() => {});
    await db.run(
      `UPDATE signals SET trace_id = ? WHERE id = ?`,
      [traceId, signal.id ?? ''],
    ).catch(() => {});
    return { executed: false, mode: 'blocked', reason: guard.reason, traceId };
  }

  // ── 3단계: 거래소 라우팅 ─────────────────────────────────────────
  if (signal.exchange === 'binance') {
    const { executeSignal: hExec } = await import('../team/hephaestos.js');
    return hExec(signal);
  }
  if (['kis', 'kis_overseas'].includes(signal.exchange)) {
    const { executeSignal: hanulExec, executeOverseasSignal } = await import('../team/hanul.js');
    return signal.exchange === 'kis_overseas'
      ? executeOverseasSignal(signal)
      : hanulExec(signal);
  }

  throw new Error(`[SIGNAL] 알 수 없는 거래소: ${signal.exchange}`);
}

function formatPaperMsg(signal, traceId) {
  const emoji = signal.action === ACTIONS.BUY ? '🟢' : signal.action === ACTIONS.SELL ? '🔴' : '⚪';
  return `${emoji} *[PAPER] ${signal.action}*\n심볼: \`${signal.symbol}\`\n금액: $${signal.amount_usdt}\ntraceId: \`${traceId}\``;
}
