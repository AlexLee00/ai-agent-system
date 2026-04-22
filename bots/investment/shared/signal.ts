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
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { isPaperMode } from './secrets.ts';
import { publishAlert } from './alert-publisher.ts';
import { getCapitalConfig, getMarketAvailableFunds } from './capital-manager.ts';
import { getExchangeEvidenceBaseline, getInvestmentExecutionRuntimeConfig } from './runtime-config.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

function isStockExchange(exchange = null) {
  return exchange === 'kis' || exchange === 'kis_overseas';
}

function formatSafetyAmount(exchange, amount) {
  const value = Number(amount || 0);
  if (exchange === 'kis') return `${Math.round(value).toLocaleString('ko-KR')}원`;
  return `$${value.toFixed(0)}`;
}

function roundAdjustedOrderAmount(exchange, amount) {
  const numeric = Number(amount || 0);
  if (!(numeric > 0)) return 0;
  if (exchange === 'kis') return Math.max(1, Math.round(numeric));
  if (exchange === 'kis_overseas') return Math.round(numeric * 100) / 100;
  return Math.round(numeric * 100) / 100;
}

function getSignalSafetySoftening(signal) {
  const executionConfig = getInvestmentExecutionRuntimeConfig();
  const exchange = signal.exchange || 'binance';
  const tradeMode = signal.trade_mode || 'normal';
  let base = executionConfig?.signalSafetySoftening || {};
  if (!base || (base.enabled !== true && Object.keys(base.byExchange || {}).length === 0)) {
    try {
      const raw = yaml.load(readFileSync(join(__dirname, '..', 'config.yaml'), 'utf8')) || {};
      base =
        raw?.runtime_config?.execution?.signalSafetySoftening
        || raw?.execution?.signalSafetySoftening
        || base;
    } catch {
      // 무시 — 런타임 getter fallback 유지
    }
  }
  const byExchange = base?.byExchange?.[exchange] || {};
  const byTradeMode = byExchange?.tradeModes?.[tradeMode] || {};
  return {
    enabled: byTradeMode?.enabled === true,
    softenedRules: Array.isArray(byTradeMode?.softenedRules) ? byTradeMode.softenedRules : [],
    amountCapMultiplier: Number(byTradeMode?.amountCapMultiplier || 0.99),
  };
}

function canSoftenSafetyRule(signal, ruleCode) {
  const softening = getSignalSafetySoftening(signal);
  return softening.enabled === true && softening.softenedRules.includes(ruleCode);
}

async function getScopedTotalAsset(signal) {
  const exchange = signal.exchange || null;
  const tradeMode = signal.trade_mode || null;

  if (!isStockExchange(exchange)) {
    return getTotalAsset();
  }

  const [availableFunds, positions] = await Promise.all([
    getMarketAvailableFunds(exchange).catch(() => 0),
    db.getAllPositions(exchange, false, tradeMode).catch(() => []),
  ]);

  const positionValue = positions.reduce((sum, position) => {
    const amount = Number(position.amount || 0);
    const avgPrice = Number(position.avg_price || 0);
    return sum + (amount * avgPrice);
  }, 0);

  const totalAsset = Number(availableFunds || 0) + positionValue;
  if (totalAsset > 0) return totalAsset;
  return null;
}

async function getMaxDrawdown(exchange = null) {
  const baseline = exchange ? getExchangeEvidenceBaseline(exchange) : null;
  const rows = await db.getEquityHistory(200, {
    since: baseline,
    positiveOnly: true,
  });
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
  const totalAsset = await getScopedTotalAsset(signal);
  const hasAssetBase = Number(totalAsset || 0) > 0;
  const useGenericAssetRules = !isStockExchange(signal.exchange) || hasAssetBase;
  const limits = getSignalLimits(signal.exchange, signal.trade_mode || null);
  const maxSinglePct = limits.MAX_SINGLE_PCT;
  const maxCapitalUsage = limits.MAX_CAPITAL_USAGE;
  const maxDailyLoss = limits.MAX_DAILY_LOSS;
  const maxPositions = limits.MAX_POSITIONS;
  const cooldownAfterLossStreak = limits.COOLDOWN_AFTER_LOSS_STREAK;
  const cooldownMinutes = limits.COOLDOWN_MINUTES;

  // 원칙 1 — 단일 포지션 ≤ config.max_position_pct
  if (isBuy && useGenericAssetRules && orderValue > totalAsset * maxSinglePct) {
    if (canSoftenSafetyRule(signal, 'rule1')) {
      const softening = getSignalSafetySoftening(signal);
      const cappedAmount = roundAdjustedOrderAmount(
        signal.exchange,
        totalAsset * maxSinglePct * softening.amountCapMultiplier,
      );
      if (cappedAmount > 0 && cappedAmount < Number(orderValue || 0)) {
        return {
          passed: true,
          softened: true,
          advisoryReason: `원칙1 soft guard: 단일 포지션 한도 초과를 감산 허용 (${formatSafetyAmount(signal.exchange, orderValue)} -> ${formatSafetyAmount(signal.exchange, cappedAmount)})`,
          softGuard: {
            kind: 'signal_rule1_softened',
            exchange: signal.exchange || 'binance',
            tradeMode: signal.trade_mode || 'normal',
            originalAmount: Number(orderValue || 0),
            reducedAmount: cappedAmount,
            reductionMultiplier: Number(softening.amountCapMultiplier || 0.99),
          },
        };
      }
    }
    return {
      passed: false,
      reason: `원칙1 위반: 단일 포지션 한도 초과 (${formatSafetyAmount(signal.exchange, orderValue)} > ${formatSafetyAmount(signal.exchange, totalAsset * maxSinglePct)})`,
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
    if (useGenericAssetRules) {
      const projectedExposure = currentExposure + Number(orderValue || 0);
      if (projectedExposure > totalAsset * maxCapitalUsage) {
        return {
          passed: false,
          reason: `원칙2 위반: 총 자본 사용률 초과 (${formatSafetyAmount(signal.exchange, projectedExposure)} > ${formatSafetyAmount(signal.exchange, totalAsset * maxCapitalUsage)})`,
        };
      }
    }

    // 원칙 3 — 동시 포지션 ≤ config.max_concurrent_positions
    if (positions.length >= maxPositions) {
      return { passed: false, reason: `원칙3 위반: 동시 포지션 한도 (현재 ${positions.length}개, 최대 ${maxPositions}개)` };
    }
  }

  // 원칙 4 — 일일 손실 ≤ config.max_daily_loss_pct
  const { pnl } = await db.getTodayPnl(signal.exchange || null);
  if (useGenericAssetRules && (pnl ?? 0) < -(totalAsset * maxDailyLoss)) {
    return {
      passed: false,
      reason: `원칙4 위반: 일일 손실 한도 초과 (${formatSafetyAmount(signal.exchange, Math.abs(pnl))} > ${formatSafetyAmount(signal.exchange, totalAsset * maxDailyLoss)})`,
    };
  }

  // 원칙 5 — 연속 손실 쿨다운
  const recent = await db.query(
    `SELECT pnl_net, exit_time
     FROM investment.trade_journal
     WHERE status = 'closed'
       AND ($1::text IS NULL OR exchange = $1)
       AND ($2::text IS NULL OR COALESCE(trade_mode, 'normal') = $2)
     ORDER BY exit_time DESC
     LIMIT $3`,
    [signal.exchange || null, signal.trade_mode || null, cooldownAfterLossStreak],
  );
  if (recent.length >= cooldownAfterLossStreak) {
    const allLoss = recent.every(r => Number(r.pnl_net || 0) < 0);
    if (allLoss) {
      const lastExitAt = Number(recent[0].exit_time || 0);
      const cooldownEnd = lastExitAt + (cooldownMinutes * 60 * 1000);
      if (Date.now() < cooldownEnd) {
        const remainMin = Math.ceil((cooldownEnd - Date.now()) / 60000);
        if (canSoftenSafetyRule(signal, 'rule5')) {
          return {
            passed: true,
            softened: true,
            advisoryReason: `원칙5 soft guard: 연속 손실 쿨다운을 validation 관찰 레일로 완화 (${remainMin}분 잔여)`,
            softGuard: {
              kind: 'signal_rule5_softened',
              exchange: signal.exchange || 'binance',
              tradeMode: signal.trade_mode || 'normal',
              remainMinutes: remainMin,
              cooldownMinutes,
              cooldownAfterLossStreak,
            },
          };
        }
        return { passed: false, reason: `원칙5 위반: 연속 ${cooldownAfterLossStreak}회 손실 → 쿨다운 ${remainMin}분 남음` };
      }
    }
  }

  // 원칙 6 — 최대 드로우다운 ≤ 15%
  const maxDD = useGenericAssetRules ? await getMaxDrawdown(signal.exchange || null) : 0;
  if (useGenericAssetRules && maxDD > limits.MAX_DRAWDOWN) {
    if (canSoftenSafetyRule(signal, 'rule6')) {
      return {
        passed: true,
        softened: true,
        advisoryReason: `원칙6 soft guard: 최대 드로우다운 경고를 validation 관찰 레일로 완화 (${(maxDD * 100).toFixed(1)}%)`,
        softGuard: {
          kind: 'signal_rule6_softened',
          exchange: signal.exchange || 'binance',
          tradeMode: signal.trade_mode || 'normal',
          currentDrawdown: Number(maxDD || 0),
          limitDrawdown: Number(limits.MAX_DRAWDOWN || 0),
        },
      };
    }
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
    publishAlert({ from_bot: 'luna', event_type: 'trade', alert_level: 1, message: msg, payload: signal });
    return { executed: false, mode: 'paper', traceId };
  }

  // ── 2단계: 자산 보호 5원칙 검사 ─────────────────────────────────
  const guard = await checkSafetyGates(signal);
  if (guard.passed && guard.softened) {
    const reducedAmount = Number(guard?.softGuard?.reducedAmount || 0);
    if (reducedAmount > 0 && reducedAmount < Number(signal.amount_usdt || 0)) {
      signal.amount_usdt = reducedAmount;
      signal.amountUsdt = reducedAmount;
      await db.updateSignalAmount(signal.id ?? '', reducedAmount).catch(() => {});
    }
    await db.updateSignalBlock(signal.id ?? '', {
      code: 'safety_gate_softened',
      meta: {
        traceId,
        exchange: signal.exchange,
        symbol: signal.symbol,
        action: signal.action,
        tradeMode: signal.trade_mode || 'normal',
        advisoryReason: guard.advisoryReason,
        softGuard: guard.softGuard || null,
      },
    }).catch(() => {});
    publishAlert({
      from_bot: 'luna',
      event_type: 'alert',
      alert_level: 2,
      message: `🛡️ 안전장치 완화 적용\n사유: ${guard.advisoryReason}\n신호: ${signal.symbol} ${signal.action}`,
      payload: { reason: guard.advisoryReason, signal, softGuard: guard.softGuard || null },
    });
  }
  if (!guard.passed) {
    console.warn(`[GUARD:${traceId}] 차단 — ${guard.reason}`);
    const guardMsg = `🛡️ 안전장치 발동\n사유: ${guard.reason}\n신호: ${signal.symbol} ${signal.action}`;
    publishAlert({ from_bot: 'luna', event_type: 'alert', alert_level: 3, message: guardMsg, payload: { reason: guard.reason, signal } });
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
