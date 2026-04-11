// @ts-nocheck
/**
 * shared/signal.js — 신호 타입 정의 + 실행 진입점 (Phase 3-A+)
 *
 * executeSignal(): 모든 실행봇의 단일 진입점
 *   1단계 — PAPER_MODE 최우선 체크
 *   2단계 — 자산 보호 5원칙 검사
 *   3단계 — 거래소 라우팅 (헤파이스토스 / 한울)
 */

import * as db from './db.ts';
import { isPaperMode } from './secrets.ts';
import { publishToMainBot } from './mainbot-client.ts';
import { getCapitalConfig } from './capital-manager.ts';

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
  MAX_CAPITAL_USAGE: 0.70, // 총 자본 사용률 ≤ 70%
  MAX_POSITIONS:   3,     // 동시 포지션 ≤ 3개
  MAX_DAILY_LOSS:  0.05,  // 일손실 ≤ 5%
  MAX_DRAWDOWN:    0.15,  // 최대 드로우다운 ≤ 15%
  COOLDOWN_AFTER_LOSS_STREAK: 3,
  COOLDOWN_MINUTES: 120,
  INITIAL_EQUITY:  138.71, // 초기 자산 폴백 (USD)
};

export function getSignalLimits(exchange = null, tradeMode = null) {
  const cfg = getCapitalConfig(exchange, tradeMode) || {};
  return {
    MAX_SINGLE_PCT: Number(cfg.max_position_pct ?? SAFETY.MAX_SINGLE_PCT),
    MAX_CAPITAL_USAGE: Number(cfg.max_capital_usage ?? SAFETY.MAX_CAPITAL_USAGE),
    MAX_POSITIONS: Number(cfg.max_concurrent_positions ?? SAFETY.MAX_POSITIONS),
    MAX_DAILY_LOSS: Number(cfg.max_daily_loss_pct ?? SAFETY.MAX_DAILY_LOSS),
    MAX_DRAWDOWN: Number(cfg.max_drawdown_pct ?? SAFETY.MAX_DRAWDOWN),
    COOLDOWN_AFTER_LOSS_STREAK: Number(
      cfg.cooldown_after_loss_streak ?? SAFETY.COOLDOWN_AFTER_LOSS_STREAK,
    ),
    COOLDOWN_MINUTES: Number(cfg.cooldown_minutes ?? SAFETY.COOLDOWN_MINUTES),
    INITIAL_EQUITY: SAFETY.INITIAL_EQUITY,
  };
}

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
  const limits = getSignalLimits(signal.exchange, signal.trade_mode || null);
  const maxSinglePct = limits.MAX_SINGLE_PCT;
  const maxCapitalUsage = limits.MAX_CAPITAL_USAGE;
  const maxDailyLoss = limits.MAX_DAILY_LOSS;
  const maxPositions = limits.MAX_POSITIONS;
  const cooldownAfterLossStreak = limits.COOLDOWN_AFTER_LOSS_STREAK;
  const cooldownMinutes = limits.COOLDOWN_MINUTES;

  // 원칙 1 — 단일 포지션 ≤ config.max_position_pct
  if (isBuy && orderValue > totalAsset * maxSinglePct) {
    return {
      passed: false,
      reason: `원칙1 위반: 단일 포지션 한도 초과 ($${orderValue?.toFixed(0)} > $${(totalAsset * maxSinglePct).toFixed(0)})`,
    };
  }

  // 원칙 2 — 총 자본 사용률 ≤ config.max_capital_usage
  if (isBuy) {
    const positions = await db.getAllPositions(signal.exchange || null, false, signal.trade_mode || null);
    const currentExposure = positions.reduce((sum, position) => {
      const amount = Number(position.amount || 0);
      const avgPrice = Number(position.avg_price || 0);
      return sum + (amount * avgPrice);
    }, 0);
    const projectedExposure = currentExposure + Number(orderValue || 0);
    if (projectedExposure > totalAsset * maxCapitalUsage) {
      return {
        passed: false,
        reason: `원칙2 위반: 총 자본 사용률 초과 ($${projectedExposure.toFixed(0)} > $${(totalAsset * maxCapitalUsage).toFixed(0)})`,
      };
    }

    // 원칙 3 — 동시 포지션 ≤ config.max_concurrent_positions
    if (positions.length >= maxPositions) {
      return { passed: false, reason: `원칙3 위반: 동시 포지션 한도 (현재 ${positions.length}개, 최대 ${maxPositions}개)` };
    }
  }

  // 원칙 4 — 일일 손실 ≤ config.max_daily_loss_pct
  const { pnl } = await db.getTodayPnl();
  if ((pnl ?? 0) < -(totalAsset * maxDailyLoss)) {
    return {
      passed: false,
      reason: `원칙4 위반: 일일 손실 한도 초과 ($${Math.abs(pnl).toFixed(2)} > $${(totalAsset * maxDailyLoss).toFixed(2)})`,
    };
  }

  // 원칙 5 — 연속 손실 쿨다운
  const recent = await db.query(
    `SELECT total_usdt, side, executed_at FROM trades ORDER BY executed_at DESC LIMIT $1`,
    [cooldownAfterLossStreak],
  );
  if (recent.length >= cooldownAfterLossStreak) {
    const allLoss = recent.every(r => (r.side === 'sell' ? r.total_usdt : -r.total_usdt) < 0);
    if (allLoss) {
      const lastExecutedAt = Number(new Date(recent[0].executed_at).getTime());
      const cooldownEnd = lastExecutedAt + (cooldownMinutes * 60 * 1000);
      if (Date.now() < cooldownEnd) {
        const remainMin = Math.ceil((cooldownEnd - Date.now()) / 60000);
        return { passed: false, reason: `원칙5 위반: 연속 ${cooldownAfterLossStreak}회 손실 → 쿨다운 ${remainMin}분 남음` };
      }
    }
  }

  // 원칙 6 — 최대 드로우다운 ≤ 15%
  const maxDD = await getMaxDrawdown();
  if (maxDD > limits.MAX_DRAWDOWN) {
    return {
      passed: false,
      reason: `원칙6 위반: 최대 드로우다운 초과 (${(maxDD * 100).toFixed(1)}% > ${(limits.MAX_DRAWDOWN * 100).toFixed(1)}%) → 사용자 승인 필요`,
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
    const { executeSignal: hExec } = await import('../team/hephaestos.ts');
    return hExec(signal);
  }
  if (['kis', 'kis_overseas'].includes(signal.exchange)) {
    const { executeSignal: hanulExec, executeOverseasSignal } = await import('../team/hanul.ts');
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
