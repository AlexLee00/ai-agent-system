// @ts-nocheck
/**
 * team/hanul.js — 한울 (KIS 실행봇)
 *
 * 역할: 루나가 승인한 신호를 한국투자증권(KIS) API로 실행
 *   - 국내주식 (KOSPI/KOSDAQ, exchange='kis')
 *   - 해외주식 (미국 NYSE/NASDAQ, exchange='kis_overseas')
 * LLM: 없음 (규칙 기반)
 * executionMode / brokerAccountMode 기준:
 *   - PAPER_MODE=true  → executionMode=paper (실제 주문 차단)
 *   - PAPER_MODE=false → executionMode=live  (브로커 계좌로 주문 실행)
 *   - kis_mode=paper → brokerAccountMode=mock
 *   - kis_mode=live  → brokerAccountMode=real
 *
 * ⚠️ 업비트는 거래 대상이 아님.
 *    업비트는 KRW↔암호화폐 입출금 게이트웨이 전용 (바이낸스 자금 이동).
 *
 * bots/invest/src/kis-executor.js 패턴 재사용
 *
 * 실행: node team/hanul.js [--symbol=005930] [--action=BUY] [--amount=500000]
 *       node team/hanul.js [--symbol=AAPL] [--action=BUY] [--amount=400]
 */

import * as db from '../shared/db.ts';
import * as journalDb from '../shared/trade-journal-db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  isPaperMode,
  isKisPaper,
  getInvestmentTradeMode,
  getKisMarketStatus,
  getKisOverseasMarketStatus,
} from '../shared/secrets.ts';
import { getMockUntradableSymbolCooldownMinutes, isSameDaySymbolReentryBlockEnabled } from '../shared/runtime-config.ts';
import { SIGNAL_STATUS, ACTIONS } from '../shared/signal.ts';
import { notifyTrade, notifyError, notifyJournalEntry, notifyKisSignal, notifyKisOverseasSignal, notifySettlement } from '../shared/report.ts';
import { getDynamicMinOrderAmount } from '../shared/capital-manager.ts';
import { getMarketOrderRule } from '../shared/order-rules.ts';
import { buildExecutionRiskApprovalGuard } from '../shared/risk-approval-execution-guard.ts';
import { attachExecutionToPositionStrategyTracked } from '../shared/execution-attach.ts';
import pgPool from '../../../packages/core/lib/pg-pool.js';

// ─── 심볼 유효성 ────────────────────────────────────────────────────

/** 국내주식 심볼: 6자리 숫자 (예: 005930) */
export function isKisSymbol(symbol) {
  return /^\d{6}$/.test(symbol);
}

/** 해외주식 심볼: 알파벳 1~5자 (예: AAPL, TSLA) */
export function isKisOverseasSymbol(symbol) {
  return /^[A-Z]{1,5}$/.test(symbol);
}

// ─── KIS 리스크 규칙 ─────────────────────────────────────────────────

const KIS_RULES = {
  MIN_ORDER_KRW: getMarketOrderRule('kis')?.minOrderAmount ?? 200_000,
  MAX_ORDER_KRW: getMarketOrderRule('kis')?.maxOrderAmount ?? 1_200_000,
};

const KIS_ORDER_CASH_BUFFER_KRW = 10_000;
const KIS_DOMESTIC_BUY_SLIPPAGE_BUFFER_DEFAULT = 1.01;

const KIS_OVERSEAS_RULES = {
  MIN_ORDER_USD: getMarketOrderRule('kis_overseas')?.minOrderAmount ?? 200,
  MAX_ORDER_USD: getMarketOrderRule('kis_overseas')?.maxOrderAmount ?? 1_200,
};

function getInvestmentPoolStats() {
  try {
    return pgPool.getPoolStats('investment');
  } catch {
    return null;
  }
}

function logHanulPhase(label, startedAt, extra = {}) {
  const elapsedMs = Date.now() - startedAt;
  const pool = getInvestmentPoolStats();
  const payload = {
    elapsed_ms: elapsedMs,
    pool,
    ...extra,
  };
  console.log(`[한울] ${label} ${JSON.stringify(payload)}`);
}

function buildHanulSignalJournalContext(signal = null) {
  return {
    executionOrigin: signal?.execution_origin || signal?.executionOrigin || 'strategy',
    qualityFlag: signal?.quality_flag || signal?.qualityFlag || 'trusted',
    excludeFromLearning: Boolean(signal?.exclude_from_learning ?? signal?.excludeFromLearning ?? false),
    incidentLink: signal?.incident_link || signal?.incidentLink || signal?.exit_reason_override || null,
  };
}

async function markSignalFailed(signalId, reason) {
  return markSignalFailedDetailed(signalId, { reason });
}

async function failHanulSignal(signalId, {
  reason,
  code = null,
  market = 'domestic',
  symbol = null,
  action = null,
  amount = null,
  error = null,
  meta = null,
} = {}) {
  await markSignalFailedDetailed(signalId, {
    reason,
    code,
    market,
    symbol,
    action,
    amount,
    error,
    meta,
  });
  return { success: false, reason: reason || error || null, error: error || null };
}

async function enforceHanulNemesisApproval(signal, market = 'domestic') {
  const paperMode = isPaperMode();
  const { id: signalId, symbol, action } = signal;

  const marketPrefix = market === 'overseas' ? 'sec015_overseas' : 'sec015';
  const executionGuard = buildExecutionRiskApprovalGuard(signal, {
    market,
    codePrefix: marketPrefix,
    executionBlockedBy: 'hanul_entry_guard',
    paperMode,
  });

  if (!executionGuard.approved) {
    const reason = `SEC-015: ${executionGuard.reason}`;
    console.error(`  🛡️ [한울] ${reason}`);
    if (signalId) {
      await db.updateSignalBlock(signalId, {
        status: SIGNAL_STATUS.FAILED,
        reason: reason.slice(0, 180),
        code: executionGuard.code,
        meta: executionGuard.meta,
      }).catch(() => {});
    }
    const failed = await failHanulSignal(signalId, {
      reason,
      code: executionGuard.code,
      market,
      symbol,
      action,
      amount: signal.amount_usdt,
      meta: executionGuard.meta,
    });
    return {
      ...failed,
      riskApprovalExecution: executionGuard.meta?.risk_approval_execution || null,
    };
  }

  return { approved: true };
}

function inferHanulBlockCode(reason = '', market = 'domestic') {
  if (!reason) return market === 'overseas' ? 'overseas_order_rejected' : 'domestic_order_rejected';
  if (reason.includes('[90000000]') || reason.includes('모의투자에서는 해당업무가 제공되지 않습니다')) return 'mock_operation_unsupported';
  if (reason.includes('[40070000]') || reason.includes('매매불가 종목')) return 'mock_untradable_symbol';
  if (reason.includes('초당 거래건수를 초과')) return 'broker_rate_limited';
  if (reason.includes('장종료')) return 'market_closed';
  if (reason.includes('현재가 조회 실패')) return 'quote_lookup_failed';
  if (reason.includes('최소 주문금액 미달')) return 'min_order_notional';
  if (reason.includes('1주 안전단가 미달')) return 'min_order_one_share_buffer';
  if (reason.includes('최대 주문금액 초과')) return 'max_order_notional';
  if (reason.includes('포지션 없음')) return 'missing_position';
  if (reason.includes('심볼 아님')) return 'invalid_symbol';
  return market === 'overseas' ? 'overseas_order_rejected' : 'domestic_order_rejected';
}

async function markSignalFailedDetailed(signalId, {
  reason = null,
  code = null,
  market = 'domestic',
  symbol = null,
  action = null,
  amount = null,
  error = null,
  meta = null,
} = {}) {
  const normalizedReason = reason ? String(reason).slice(0, 180) : null;
  await db.updateSignalBlock(signalId, {
    status: SIGNAL_STATUS.FAILED,
    reason: normalizedReason,
    code: code || inferHanulBlockCode(normalizedReason || '', market),
    meta: {
      market,
      symbol,
      action,
      amount,
      error: error ? String(error).slice(0, 240) : null,
      ...(meta || {}),
    },
  }).catch(() => {});
}

async function recordHanulEntryJournal({
  market,
  exchange,
  signalId,
  symbol,
  trade,
  paperMode,
  confidence = null,
  reasoning = null,
}) {
  try {
    const execTime = Date.now();
    const tradeId = await journalDb.generateTradeId();
    const signal = signalId ? await db.getSignalById(signalId).catch(() => null) : null;
    await journalDb.insertJournalEntry({
      trade_id: tradeId,
      signal_id: signalId,
      market,
      exchange,
      symbol,
      is_paper: paperMode,
      entry_time: execTime,
      entry_price: trade.price || 0,
      entry_size: trade.amount || 0,
      entry_value: trade.totalUsdt || 0,
      direction: 'long',
      strategy_family: signal?.strategy_family || null,
      strategy_quality: signal?.strategy_quality || null,
      strategy_readiness: signal?.strategy_readiness ?? null,
      strategy_route: signal?.strategy_route || null,
      execution_origin: trade.executionOrigin || signal?.execution_origin || 'strategy',
      quality_flag: trade.qualityFlag || signal?.quality_flag || 'trusted',
      exclude_from_learning: Boolean(trade.excludeFromLearning ?? signal?.exclude_from_learning ?? false),
      incident_link: trade.incidentLink || signal?.incident_link || null,
    });
    await journalDb.linkRationaleToTrade(tradeId, signalId).catch(() => {});
    notifyJournalEntry({
      tradeId,
      symbol,
      direction: 'long',
      market,
      entryPrice: trade.price,
      entryValue: trade.totalUsdt,
      isPaper: paperMode,
      confidence,
      reasoning,
    });
  } catch (journalErr) {
    const marketLabel = market === 'overseas' ? '해외주식' : '국내주식';
    console.warn(`  ⚠️ ${marketLabel} 매매일지 기록 실패: ${journalErr.message}`);
  }
}

async function finalizeHanulTrade({ trade, signalId, currency, tag }) {
  await db.insertTrade(trade);
  await db.updateSignalStatus(signalId, SIGNAL_STATUS.EXECUTED);
  await notifyTrade({ ...trade, currency, tradeMode: trade.tradeMode || trade.trade_mode || getInvestmentTradeMode() });
  const priceLabel = currency === 'KRW'
    ? `${trade.price?.toLocaleString()}원`
    : `$${trade.price}`;
  console.log(`  ✅ ${tag} 완료: ${trade.side} ${trade.amount}주 @ ${priceLabel}`);
  return { success: true, trade };
}

async function syncHanulStrategyExecutionState({
  symbol,
  exchange,
  tradeMode = 'normal',
  lifecycleStatus,
  recommendation = null,
  reasonCode = null,
  reason = null,
  trade = null,
  updatedBy = 'hanul_execute',
} = {}) {
  if (!symbol || !exchange || !lifecycleStatus) return null;
  const timestamp = new Date().toISOString();
  return db.updatePositionStrategyProfileState(symbol, {
    exchange,
    tradeMode,
    strategyState: {
      lifecycleStatus,
      latestRecommendation: recommendation,
      latestReasonCode: reasonCode,
      latestReason: reason,
      latestExecutedAction: trade?.side || null,
      latestExecutionPrice: Number(trade?.price || 0) || null,
      latestExecutionValue: Number(trade?.totalUsdt || 0) || null,
      latestExecutionAmount: Number(trade?.amount || 0) || null,
      updatedBy,
      updatedAt: timestamp,
    },
    lastEvaluationAt: timestamp,
    lastAttentionAt: timestamp,
  }).catch(() => null);
}

function normalizePartialExitRatio(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  if (parsed >= 1) return 1;
  return Number(parsed.toFixed(4));
}

function normalizeResponsibilityPlan(plan = null) {
  return plan && typeof plan === 'object' ? plan : {};
}

function normalizeExecutionPlan(plan = null) {
  return plan && typeof plan === 'object' ? plan : {};
}

function applyHanulResponsibilityExecutionSizing(amount, {
  action = ACTIONS.BUY,
  confidence = 0,
  responsibilityPlan = null,
  executionPlan = null,
} = {}) {
  const numericAmount = Number(amount || 0);
  if (!(numericAmount > 0) || action !== ACTIONS.BUY) {
    return { amount: numericAmount, multiplier: 1, reason: null };
  }

  const plan = normalizeResponsibilityPlan(responsibilityPlan);
  const execPlan = normalizeExecutionPlan(executionPlan);
  const ownerMode = String(plan.ownerMode || '').trim().toLowerCase();
  const riskMission = String(plan.riskMission || '').trim().toLowerCase();
  const executionMission = String(plan.executionMission || '').trim().toLowerCase();
  const watchMission = String(plan.watchMission || '').trim().toLowerCase();
  let multiplier = 1;
  const reasons = [];

  if (ownerMode === 'capital_preservation') {
    multiplier *= 0.95;
    reasons.push('owner capital_preservation');
  } else if (ownerMode === 'balanced_rotation' || ownerMode === 'equity_rotation') {
    multiplier *= 0.98;
    reasons.push(`owner ${ownerMode}`);
  } else if (ownerMode === 'opportunity_capture' && Number(confidence || 0) >= 0.74) {
    multiplier *= 1.02;
    reasons.push('owner opportunity_capture');
  }

  if (riskMission === 'strict_risk_gate') {
    multiplier *= 0.9;
    reasons.push('risk strict_risk_gate');
  } else if (riskMission === 'soft_sizing_preference') {
    multiplier *= 0.97;
    reasons.push('risk soft_sizing_preference');
  }

  if (executionMission === 'execution_safeguard' || executionMission === 'precision_execution') {
    multiplier *= 0.95;
    reasons.push(`execution ${executionMission}`);
  }

  if (watchMission === 'risk_sentinel') {
    multiplier *= 0.98;
    reasons.push('watch risk_sentinel');
  }

  const entrySizingMultiplier = Number(execPlan.entrySizingMultiplier || 1);
  if (entrySizingMultiplier > 0 && entrySizingMultiplier !== 1) {
    multiplier *= entrySizingMultiplier;
    reasons.push(`executionPlan entry x${entrySizingMultiplier}`);
  }

  const normalizedMultiplier = Number(multiplier.toFixed(4));
  return {
    amount: Math.round(numericAmount * normalizedMultiplier),
    multiplier: normalizedMultiplier,
    reason: reasons.length > 0 ? reasons.join(' + ') : null,
  };
}

export function applyHanulStockSizingFloor(amount, {
  action = ACTIONS.BUY,
  minOrder = 0,
  maxOrder = Infinity,
  currency = 'KRW',
} = {}) {
  const numericAmount = Number(amount || 0);
  const floor = Number(minOrder || 0);
  const cap = Number(maxOrder || Infinity);
  if (action !== ACTIONS.BUY || !(numericAmount > 0) || !(floor > 0)) {
    return { amount: numericAmount, adjusted: false, blocked: false, reason: null, code: null };
  }
  if (numericAmount >= floor) {
    return { amount: numericAmount, adjusted: false, blocked: false, reason: null, code: null };
  }
  if (Number.isFinite(cap) && floor > cap) {
    return {
      amount: numericAmount,
      adjusted: false,
      blocked: true,
      reason: `sizing floor 적용 불가 (${numericAmount.toLocaleString()} ${currency} < floor ${floor.toLocaleString()} ${currency}, cap ${cap.toLocaleString()} ${currency})`,
      code: 'sizing_floor_unavailable',
    };
  }
  return {
    amount: floor,
    adjusted: true,
    blocked: false,
    reason: `sizing floor 적용 (${numericAmount.toLocaleString()} ${currency} → ${floor.toLocaleString()} ${currency})`,
    code: 'sizing_floor_applied',
  };
}

async function getHanulDomesticBufferedUnitPrice(symbol) {
  if (!isKisSymbol(symbol)) return null;
  try {
    const kis = await getKis();
    if (typeof kis?.getDomesticPrice !== 'function') return null;
    const currentPrice = Number(await kis.getDomesticPrice(symbol, isKisPaper()));
    if (!(currentPrice > 0)) return null;
    const slippageBuffer = Number(kis?.KIS_DOMESTIC_BUY_SLIPPAGE_BUFFER || KIS_DOMESTIC_BUY_SLIPPAGE_BUFFER_DEFAULT);
    const safeSlippageBuffer = slippageBuffer > 0 ? slippageBuffer : KIS_DOMESTIC_BUY_SLIPPAGE_BUFFER_DEFAULT;
    const bufferedUnitPrice = Math.ceil(currentPrice * safeSlippageBuffer);
    return { currentPrice, bufferedUnitPrice, slippageBuffer: safeSlippageBuffer };
  } catch {
    return null;
  }
}

function isEffectivePartialExit({ entrySize = 0, soldAmount = 0, partialExitRatio = 1 } = {}) {
  const normalizedRatio = normalizePartialExitRatio(partialExitRatio);
  const baseline = Number(entrySize || 0);
  const sold = Number(soldAmount || 0);
  if (!(baseline > 0) || !(sold > 0)) return false;
  if (normalizedRatio < 1) return sold < baseline;
  return sold < baseline;
}

async function processPendingHanulSignals({ exchange, label, execute, delayMs = 1100 }) {
  const startedAt = Date.now();
  const tradeMode = getInvestmentTradeMode();
  console.log(`[한울] ${label} pending 조회 시작 ${JSON.stringify({ pool: getInvestmentPoolStats() })}`);
  const signals = await db.getPendingSignals(exchange, tradeMode);
  logHanulPhase(`${label} pending 조회 완료`, startedAt, { signal_count: signals.length, trade_mode: tradeMode });
  if (signals.length === 0) {
    console.log(`[한울] 대기 ${label} 신호 없음 (trade_mode=${tradeMode})`);
    return [];
  }
  console.log(`[한울] ${signals.length}개 ${label} 신호 처리 시작 (trade_mode=${tradeMode})`);
  const results = [];
  for (const signal of signals) {
    const signalStartedAt = Date.now();
    results.push(await execute(signal));
    logHanulPhase(`${label} 신호 처리 완료 ${signal.symbol}`, signalStartedAt, {
      signal_id: signal.id,
      action: signal.action,
    });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  logHanulPhase(`${label} pending 전체 처리 완료`, startedAt, {
    signal_count: signals.length,
    success_count: results.filter((result) => result?.success).length,
  });
  return results;
}

async function ensureHanulBuyEntryAllowed({
  signalId,
  signalTradeMode,
  paperMode,
  symbol,
  action,
  amount,
  exchange,
  market,
}) {
  const livePosition = await db.getLivePosition(symbol, exchange, signalTradeMode);
  const paperPosition = await db.getPaperPosition(symbol, exchange, signalTradeMode);
  const sameDayBuyTrade = isSameDaySymbolReentryBlockEnabled()
    ? await db.getSameDayTrade({ symbol, side: 'buy', exchange, tradeMode: signalTradeMode })
    : null;

  if (paperMode && livePosition) {
    return failHanulSignal(signalId, {
      reason: '실포지션 보유 중에는 PAPER 추가매수로 혼합 포지션을 만들 수 없음',
      code: 'position_mode_conflict',
      market,
      symbol,
      action,
      amount,
    });
  }
  if (paperMode && paperPosition) {
    return failHanulSignal(signalId, {
      reason: `동일 ${signalTradeMode.toUpperCase()} PAPER 포지션 보유 중 — 추가매수 차단`,
      code: 'paper_position_reentry_blocked',
      market,
      symbol,
      action,
      amount,
    });
  }
  if (!paperMode && livePosition) {
    return failHanulSignal(signalId, {
      reason: '동일 LIVE 포지션 보유 중 — 추가매수 차단',
      code: 'live_position_reentry_blocked',
      market,
      symbol,
      action,
      amount,
    });
  }
  if (!livePosition && !paperPosition && sameDayBuyTrade) {
    return failHanulSignal(signalId, {
      reason: `동일 ${signalTradeMode.toUpperCase()} 심볼 당일 재진입 차단`,
      code: 'same_day_reentry_blocked',
      market,
      symbol,
      action,
      amount,
    });
  }

  return { success: true };
}

async function prepareHanulSellExecution({
  signalId,
  signalTradeMode,
  paperMode,
  symbol,
  action,
  amount,
  exchange,
  market,
  missingReason,
  partialExitRatio = null,
}) {
  const livePosition = await db.getLivePosition(symbol, exchange, signalTradeMode);
  const paperPosition = await db.getPaperPosition(symbol, exchange, signalTradeMode);

  if (paperMode && livePosition && !paperPosition) {
    return failHanulSignal(signalId, {
      reason: '실포지션 보유 중에는 PAPER SELL로 혼합 청산을 실행할 수 없음',
      code: 'position_mode_conflict',
      market,
      symbol,
      action,
      amount,
    });
  }

  const position = paperPosition || livePosition;
  const sellPaperMode = paperMode || (!livePosition && !!paperPosition);
  const baseQty = Number(position?.amount || 0);
  if (!baseQty || baseQty < 1) {
    return failHanulSignal(signalId, {
      reason: missingReason,
      market,
      symbol,
      action,
      amount,
    });
  }

  const normalizedPartialExitRatio = normalizePartialExitRatio(partialExitRatio);
  let qty = baseQty;
  if (normalizedPartialExitRatio < 1) {
    qty = Math.floor(baseQty * normalizedPartialExitRatio);
    if (qty < 1) {
      return failHanulSignal(signalId, {
        reason: `부분청산 수량 미달 (${baseQty}주 x ${normalizedPartialExitRatio} < 1주)`,
        code: 'partial_sell_below_minimum',
        market,
        symbol,
        action,
        amount,
      });
    }
  }

  return {
    success: true,
    livePosition,
    paperPosition,
    position,
    sellPaperMode,
    qty,
    baseQty,
    partialExitRatio: normalizedPartialExitRatio,
    effectiveTradeMode: getPositionTradeMode(position, signalTradeMode),
  };
}

async function getKisExecutionPreflight({ market = 'domestic', action = ACTIONS.HOLD }) {
  if (market === 'domestic') {
    const status = await getKisMarketStatus();
    if (!status.isOpen) {
      return {
        ok: false,
        reason: `국내주식 ${status.reason} — 장중에만 주문 실행 가능`,
        code: 'market_closed',
      };
    }
    return { ok: true };
  }

  const status = getKisOverseasMarketStatus();
  if (!status.isOpen) {
    return {
      ok: false,
      reason: `해외주식 ${status.reason} — 장중에만 주문 실행 가능`,
      code: 'market_closed',
    };
  }
  return { ok: true };
}

async function closeOpenJournalForSymbol(
  symbol,
  market,
  isPaper,
  exitPrice,
  exitValue,
  exitReason,
  tradeMode = null,
  {
    partialExitRatio = null,
    soldAmount = null,
    signalId = null,
    executionOrigin = null,
    qualityFlag = null,
    excludeFromLearning = null,
    incidentLink = null,
  } = {},
) {
  const openEntries = await journalDb.getOpenJournalEntries(market);
  const scopedEntries = openEntries.filter((e) =>
    e.symbol === symbol
      && Boolean(e.is_paper) === Boolean(isPaper),
  );
  const effectiveTradeMode = tradeMode || null;
  let entry = null;
  if (effectiveTradeMode) {
    entry = scopedEntries.find((e) => (e.trade_mode || 'normal') === effectiveTradeMode) || null;
  } else if (scopedEntries.length === 1) {
    entry = scopedEntries[0];
  } else if (scopedEntries.length > 1) {
    const tradeModes = [...new Set(scopedEntries.map((e) => e.trade_mode || 'normal'))];
    console.warn(`[한울] ${market} ${symbol} journal close 스킵 - trade_mode 불명확 (${tradeModes.join(',')})`);
  }
  if (!entry) return;

  const normalizedRatio = normalizePartialExitRatio(partialExitRatio);
  const entrySize = Number(entry.entry_size || 0);
  const entryValue = Number(entry.entry_value || 0);
  const realizedSize = Math.min(entrySize, Math.max(0, Number(soldAmount || 0)));
  const isPartial = isEffectivePartialExit({
    entrySize,
    soldAmount: realizedSize,
    partialExitRatio: normalizedRatio,
  });

  if (isPartial) {
    const realizedEntryValue = entrySize > 0
      ? entryValue * (realizedSize / entrySize)
      : 0;
    const pnlAmount = (exitValue || 0) - realizedEntryValue;
    const pnlPercent = realizedEntryValue > 0
      ? journalDb.ratioToPercent(pnlAmount / realizedEntryValue)
      : null;
    const remainingSize = Math.max(0, entrySize - realizedSize);
    const remainingEntryValue = Math.max(0, entryValue - realizedEntryValue);
    const partialTradeId = await journalDb.generateTradeId();

    await journalDb.insertJournalEntry({
      trade_id: partialTradeId,
      signal_id: signalId ?? entry.signal_id ?? null,
      market: entry.market,
      exchange: entry.exchange,
      symbol: entry.symbol,
      is_paper: entry.is_paper,
      trade_mode: entry.trade_mode,
      entry_time: entry.entry_time,
      entry_price: entry.entry_price,
      entry_size: realizedSize,
      entry_value: realizedEntryValue,
      direction: entry.direction || 'long',
      signal_time: entry.signal_time ?? null,
      decision_time: entry.decision_time ?? null,
      execution_time: Date.now(),
      signal_to_exec_ms: entry.signal_to_exec_ms ?? null,
      tp_price: entry.tp_price ?? null,
      sl_price: entry.sl_price ?? null,
      strategy_family: entry.strategy_family ?? null,
      strategy_quality: entry.strategy_quality ?? null,
      strategy_readiness: entry.strategy_readiness ?? null,
      strategy_route: entry.strategy_route ?? null,
      execution_origin: executionOrigin || entry.execution_origin || 'strategy',
      quality_flag: qualityFlag || entry.quality_flag || 'trusted',
      exclude_from_learning: Boolean(excludeFromLearning ?? entry.exclude_from_learning ?? false),
      incident_link: incidentLink || entry.incident_link || null,
    });

    await journalDb.closeJournalEntry(partialTradeId, {
      exitPrice,
      exitValue,
      exitReason,
      pnlAmount,
      pnlPercent,
      pnlNet: pnlAmount,
      execution_origin: executionOrigin,
      quality_flag: qualityFlag,
      exclude_from_learning: excludeFromLearning,
      incident_link: incidentLink,
    });

    await journalDb.ensureAutoReview(partialTradeId).catch(() => {});
    await db.run(
      `UPDATE trade_journal
       SET entry_size = $1,
           entry_value = $2
       WHERE trade_id = $3`,
      [remainingSize, remainingEntryValue, entry.trade_id],
    );
    return;
  }

  const pnlAmount = (exitValue || 0) - (entry.entry_value || 0);
  const pnlPercent = entry.entry_value > 0
    ? journalDb.ratioToPercent(pnlAmount / entry.entry_value)
    : null;
  await journalDb.closeJournalEntry(entry.trade_id, {
    exitPrice,
    exitValue,
    exitReason,
    pnlAmount,
    pnlPercent,
    pnlNet: pnlAmount,
    execution_origin: executionOrigin,
    quality_flag: qualityFlag,
    exclude_from_learning: excludeFromLearning,
    incident_link: incidentLink,
  });
  await journalDb.ensureAutoReview(entry.trade_id).catch(() => {});
  const review = await journalDb.getReviewByTradeId(entry.trade_id).catch(() => null);
  const exchange = market === 'domestic' ? 'kis' : 'kis_overseas';
  const weekly = await db.get(`
    SELECT
      COALESCE(SUM(pnl_net), 0) AS pnl,
      COUNT(*) AS total_trades,
      COUNT(*) FILTER (WHERE pnl_net > 0) AS wins
    FROM trade_journal
    WHERE exchange = ?
      AND status = 'closed'
      AND exit_time IS NOT NULL
      AND exit_time >= ?
  `, [exchange, Date.now() - 7 * 24 * 60 * 60 * 1000]).catch(() => null);
  const settledAt = Date.now();
  const holdHours = entry.entry_time ? Math.max(0, ((settledAt - Number(entry.entry_time)) / 3600000)) : null;
  await notifySettlement({
    symbol,
    side: 'buy',
    market,
    entryPrice: entry.entry_price,
    exitPrice,
    pnl: pnlAmount,
    pnlPercent,
    holdDuration: holdHours != null ? `${holdHours.toFixed(1)}시간` : null,
    weeklyPnl: weekly?.pnl != null ? Number(weekly.pnl) : null,
    totalTrades: weekly?.total_trades != null ? Number(weekly.total_trades) : null,
    wins: weekly?.wins != null ? Number(weekly.wins) : null,
    winRate: weekly?.total_trades ? Number(weekly.wins || 0) / Number(weekly.total_trades) : null,
    paper: isPaper,
    maxFavorable: review?.max_favorable ?? null,
    maxAdverse: review?.max_adverse ?? null,
    signalAccuracy: review?.signal_accuracy ?? null,
    executionSpeed: review?.execution_speed ?? null,
    qualityFlag,
    incidentLink,
  }).catch(() => {});
}

async function closeStaleOpenJournalForSymbol(symbol, market, isPaper, exitReason, tradeMode = null) {
  const openEntries = await journalDb.getOpenJournalEntries(market);
  const scopedEntries = openEntries.filter((e) =>
    e.symbol === symbol
      && Boolean(e.is_paper) === Boolean(isPaper),
  );
  const effectiveTradeMode = tradeMode || null;
  let entry = null;
  if (effectiveTradeMode) {
    entry = scopedEntries.find((e) => (e.trade_mode || 'normal') === effectiveTradeMode) || null;
  } else if (scopedEntries.length === 1) {
    entry = scopedEntries[0];
  } else if (scopedEntries.length > 1) {
    const tradeModes = [...new Set(scopedEntries.map((e) => e.trade_mode || 'normal'))];
    console.warn(`[한울] ${market} ${symbol} stale journal close 스킵 - trade_mode 불명확 (${tradeModes.join(',')})`);
  }
  if (!entry) return;

  await journalDb.closeJournalEntry(entry.trade_id, {
    exitReason,
    exitPrice: null,
    exitValue: null,
    pnlAmount: null,
    pnlPercent: null,
    pnlNet: null,
  });
  await journalDb.ensureAutoReview(entry.trade_id).catch(() => {});
}

function getPositionTradeMode(position, fallbackTradeMode = null) {
  return position?.trade_mode || fallbackTradeMode || 'normal';
}

async function checkKisRisk(signal) {
  const { action, amount_usdt: amountKrw, symbol } = signal;
  const signalTradeMode = signal.trade_mode || getInvestmentTradeMode();
  if (!isKisSymbol(symbol)) return { approved: false, reason: `KIS 국내 심볼 아님: ${symbol}` };
  if (action === ACTIONS.HOLD)  return { approved: true };
  if (action === ACTIONS.BUY) {
    const minOrderKrw = await getDynamicMinOrderAmount('kis', signalTradeMode);
    const kisPaperMode = isKisPaper();
    const accountModeLabel = kisPaperMode ? 'mock' : 'real';
    if (isKisPaper()) {
      const cooldownMinutes = getMockUntradableSymbolCooldownMinutes();
      const recentBlocked = await db.getRecentBlockedSignalByCode({
        symbol,
        action: ACTIONS.BUY,
        exchange: 'kis',
        tradeMode: signalTradeMode,
        blockCode: 'mock_untradable_symbol',
        minutesBack: cooldownMinutes,
      });
      if (recentBlocked) {
        const cooldownHours = (cooldownMinutes / 60).toFixed(cooldownMinutes % 60 === 0 ? 0 : 1);
        return {
          approved: false,
          reason: `${symbol} 최근 KIS mock 매매불가 종목으로 확인됨 — ${cooldownHours}시간 쿨다운`,
          code: 'mock_untradable_symbol_cooldown',
        };
      }
    }
    if (!amountKrw || amountKrw < minOrderKrw)
      return { approved: false, reason: `최소 주문금액 미달 (${amountKrw?.toLocaleString()}원 < ${minOrderKrw.toLocaleString()}원)` };
    if (amountKrw > KIS_RULES.MAX_ORDER_KRW)
      return { approved: false, reason: `최대 주문금액 초과 (${amountKrw?.toLocaleString()}원)` };
    try {
      const kis = await getKis();
      if (typeof kis.getDomesticPrice === 'function') {
        const currentPrice = Number(await kis.getDomesticPrice(symbol, kisPaperMode));
        if (!(currentPrice > 0)) {
          return { approved: false, reason: `${symbol} 국내 현재가 0원 응답 — 거래불가 종목으로 판단 (${accountModeLabel})` };
        }
        const slippageBuffer = Number(kis?.KIS_DOMESTIC_BUY_SLIPPAGE_BUFFER || KIS_DOMESTIC_BUY_SLIPPAGE_BUFFER_DEFAULT);
        const safeSlippageBuffer = slippageBuffer > 0 ? slippageBuffer : KIS_DOMESTIC_BUY_SLIPPAGE_BUFFER_DEFAULT;
        const bufferedUnitPrice = Math.ceil(currentPrice * safeSlippageBuffer);
        if (amountKrw < bufferedUnitPrice) {
          return {
            approved: false,
            reason: `1주 안전단가 미달 (${amountKrw?.toLocaleString()}원 < ${bufferedUnitPrice.toLocaleString()}원, 현재가 ${currentPrice.toLocaleString()}원, ${accountModeLabel})`,
            code: 'min_order_one_share_buffer',
          };
        }
      }
      if (typeof kis.getDomesticBalance === 'function') {
        const balance = await kis.getDomesticBalance(kisPaperMode);
        const depositKrw = Number(balance?.dnca_tot_amt || 0);
        const spendableKrw = Math.max(0, depositKrw - KIS_ORDER_CASH_BUFFER_KRW);
        if (depositKrw <= 0) {
          return {
            approved: false,
            reason: `국내 예수금 확인 실패 또는 0원 (${depositKrw?.toLocaleString?.() || depositKrw}원, ${accountModeLabel})`,
          };
        }
        if (amountKrw > spendableKrw) {
          return {
            approved: false,
            reason: `주문가능금액 초과 (${amountKrw?.toLocaleString()}원 > 가용 ${spendableKrw.toLocaleString()}원, 예수금 ${depositKrw.toLocaleString()}원, ${accountModeLabel})`,
          };
        }
      }
    } catch (e) {
      return {
        approved: false,
        reason: `${symbol} 국내 현재가 사전검증 실패 (${accountModeLabel}) — ${e.message}`,
      };
    }
  }
  if (action === ACTIONS.SELL) {
    const pos = await db.getLivePosition(symbol, 'kis', signalTradeMode)
      || await db.getPaperPosition(symbol, 'kis', signalTradeMode);
    if (!pos || pos.amount <= 0) return { approved: false, reason: `${symbol} 포지션 없음` };
  }
  return { approved: true };
}

async function checkKisOverseasRisk(signal) {
  const { action, amount_usdt: amountUsd, symbol } = signal;
  const signalTradeMode = signal.trade_mode || getInvestmentTradeMode();
  if (!isKisOverseasSymbol(symbol)) return { approved: false, reason: `KIS 해외 심볼 아님: ${symbol}` };
  if (action === ACTIONS.HOLD)   return { approved: true };
  if (action === ACTIONS.BUY) {
    const minOrderUsd = await getDynamicMinOrderAmount('kis_overseas', signalTradeMode);
    if (!amountUsd || amountUsd < minOrderUsd)
      return { approved: false, reason: `최소 주문금액 미달 ($${amountUsd} < $${minOrderUsd})` };
    if (amountUsd > KIS_OVERSEAS_RULES.MAX_ORDER_USD)
      return { approved: false, reason: `최대 주문금액 초과 ($${amountUsd})` };
    try {
      const kis = await getKis();
      if (typeof kis.getOverseasQuote === 'function') {
        const quote = await kis.getOverseasQuote(symbol);
        const currentPrice = Number(quote?.price || 0);
        if (currentPrice > 0 && amountUsd < currentPrice) {
          return {
            approved: false,
            reason: `1주 가격 미달 ($${amountUsd} < $${currentPrice.toFixed(2)})`,
          };
        }
      }
    } catch (e) {
      console.warn(`  ⚠️ [한울] 해외 현재가 사전검증 실패 (${symbol}): ${e.message}`);
    }
  }
  if (action === ACTIONS.SELL) {
    if (isKisPaper()) {
      return {
        approved: false,
        reason: `${symbol} 해외 모의투자 계좌는 SELL 주문을 지원하지 않음`,
        code: 'mock_operation_unsupported',
      };
    }
    const pos = await db.getLivePosition(symbol, 'kis_overseas', signalTradeMode)
      || await db.getPaperPosition(symbol, 'kis_overseas', signalTradeMode);
    if (!pos || pos.amount <= 0) return { approved: false, reason: `${symbol} 해외 포지션 없음` };
  }
  return { approved: true };
}

// ─── KIS API (lazy load) ─────────────────────────────────────────────

let _kisPromise = null;

/** kis-client.js 동적 로드 (ESM). 실패 시 mock 반환 */
function getKis() {
  if (!_kisPromise) {
    _kisPromise = import('../shared/kis-client.ts')
      .then(m => {
        console.log('  ℹ️ [한울] KIS 클라이언트 로드 완료 (kis-client.js)');
        return m;
      })
      .catch(() => {
        console.log('  ⚠️ [한울] KIS 클라이언트 로드 실패 — mock 사용');
        return {
          marketBuy:         async (s, a, dry) => ({ qty: 1, price: a, totalKrw: a, dryRun: true }),
          marketSell:        async (s, q, dry) => ({ qty: q, price: 0, totalKrw: 0, dryRun: true }),
          marketBuyOverseas:  async (s, a, dry) => ({ qty: 1, price: a, totalUsd: a, dryRun: true }),
          marketSellOverseas: async (s, q, dry) => ({ qty: q, price: 0, totalUsd: 0, dryRun: true }),
        };
      });
  }
  return _kisPromise;
}

// ─── 국내주식 신호 실행 ──────────────────────────────────────────────

/**
 * KIS 국내주식 단일 신호 실행
 * @param {object} signal  { id, symbol, action, amount_usdt(=amountKrw), confidence }
 */
export async function executeSignal(signal) {
  const paperMode = isPaperMode();
  const kisPaper  = isKisPaper();
  const { id: signalId, symbol, action, amount_usdt: amountKrw } = signal;
  const signalTradeMode = signal.trade_mode || getInvestmentTradeMode();
  const exitReasonOverride = signal.exit_reason_override || null;
  const partialExitRatio = normalizePartialExitRatio(signal.partial_exit_ratio || signal.partialExitRatio);
  const journalContext = buildHanulSignalJournalContext(signal);
  const domesticBuySizing = applyHanulResponsibilityExecutionSizing(amountKrw, {
    action,
    confidence: signal.confidence,
    responsibilityPlan: signal.existingResponsibilityPlan || null,
    executionPlan: signal.existingExecutionPlan || null,
  });
  const domesticMinOrderKrw = action === ACTIONS.BUY
    ? await getDynamicMinOrderAmount('kis', signalTradeMode)
    : 0;
  const domesticBufferedUnit = action === ACTIONS.BUY
    ? await getHanulDomesticBufferedUnitPrice(symbol)
    : null;
  const domesticEffectiveMinOrderKrw = action === ACTIONS.BUY
    ? Math.max(domesticMinOrderKrw, Number(domesticBufferedUnit?.bufferedUnitPrice || 0))
    : domesticMinOrderKrw;
  const domesticSizingFloor = applyHanulStockSizingFloor(domesticBuySizing.amount, {
    action,
    minOrder: domesticEffectiveMinOrderKrw,
    maxOrder: KIS_RULES.MAX_ORDER_KRW,
    currency: 'KRW',
  });
  const effectiveBuyAmountKrw = action === ACTIONS.BUY ? domesticSizingFloor.amount : amountKrw;
  const effectiveSignal = action === ACTIONS.BUY
    ? { ...signal, amount_usdt: effectiveBuyAmountKrw }
    : signal;

  const tag = paperMode ? '[PAPER]' : kisPaper ? '[LIVE/MOCK]' : '[LIVE/REAL]';
  console.log(`\n⚡ [한울] ${symbol} ${action} ${effectiveBuyAmountKrw?.toLocaleString()}원 ${tag}`);

  try {
    if (domesticSizingFloor.blocked) {
      console.log(`  ⛔ sizing floor 차단: ${domesticSizingFloor.reason}`);
      return failHanulSignal(signalId, {
        reason: domesticSizingFloor.reason,
        code: domesticSizingFloor.code,
        market: 'domestic',
        symbol,
        action,
        amount: effectiveBuyAmountKrw,
        meta: {
          originalAmount: amountKrw,
          sizedAmount: domesticBuySizing.amount,
          minOrder: domesticEffectiveMinOrderKrw,
          baseMinOrder: domesticMinOrderKrw,
          oneShareBufferedPrice: domesticBufferedUnit?.bufferedUnitPrice || null,
        },
      });
    }

    if (domesticSizingFloor.adjusted) {
      console.log(`  🧱 [sizing floor] ${symbol} ${domesticSizingFloor.reason}`);
      if (domesticBufferedUnit?.bufferedUnitPrice > domesticMinOrderKrw) {
        console.log(
          `  🧮 [1주 안전단가] ${symbol} 현재가 ${domesticBufferedUnit.currentPrice.toLocaleString()}원, `
          + `안전단가 ${domesticBufferedUnit.bufferedUnitPrice.toLocaleString()}원 적용`,
        );
      }
    }

    const approvalGuard = await enforceHanulNemesisApproval(effectiveSignal, 'domestic');
    if (approvalGuard?.success === false) return approvalGuard;

    const preflight = await getKisExecutionPreflight({ market: 'domestic', action });
    if (!preflight.ok) {
      console.log(`  ⛔ 실행 사전 차단: ${preflight.reason}`);
      return failHanulSignal(signalId, {
        reason: preflight.reason,
        code: preflight.code,
        market: 'domestic',
        symbol,
        action,
        amount: effectiveBuyAmountKrw,
      });
    }

    const risk = await checkKisRisk(effectiveSignal);
    if (!risk.approved) {
      console.log(`  ❌ 리스크 거부: ${risk.reason}`);
      return failHanulSignal(signalId, {
        reason: risk.reason,
        code: risk.code || null,
        market: 'domestic',
        symbol,
        action,
        amount: effectiveBuyAmountKrw,
      });
    }

    // 신호 알람 (BUY/SELL만, HOLD 제외)
    if (action !== ACTIONS.HOLD) {
      notifyKisSignal({ symbol, action, amountKrw: effectiveBuyAmountKrw, confidence: signal.confidence, reasoning: signal.reasoning, paper: paperMode || kisPaper, tradeMode: signalTradeMode });
    }

    const kis = await getKis();
    let trade;

    if (action === ACTIONS.BUY) {
      const buyEntryState = await ensureHanulBuyEntryAllowed({
        signalId,
        signalTradeMode,
        paperMode,
        symbol,
        action,
        amount: effectiveBuyAmountKrw,
        exchange: 'kis',
        market: 'domestic',
      });
      if (buyEntryState?.success === false) return buyEntryState;

      if (domesticBuySizing.reason && domesticBuySizing.multiplier !== 1) {
        console.log(`  🎛️ [execution tone] ${symbol} 책임계획 반영 x${domesticBuySizing.multiplier.toFixed(2)} (${domesticBuySizing.reason})`);
      }

      // paperMode=true → dryRun(API 호출 없음) / false → brokerAccountMode(mock/real)에 따라 실제 주문 API 호출
      const order = await kis.marketBuy(symbol, effectiveBuyAmountKrw, paperMode);
      trade = {
        signalId, symbol, side: 'buy',
        amount:    order.qty,
        price:     order.price,
        totalUsdt: order.totalKrw,
        paper:     paperMode,
        exchange:  'kis',
        tradeMode: signalTradeMode,
        executionOrigin: journalContext.executionOrigin,
        qualityFlag: journalContext.qualityFlag,
        excludeFromLearning: journalContext.excludeFromLearning,
        incidentLink: journalContext.incidentLink,
      };

      await db.upsertPosition({
        symbol,
        amount: order.qty || 0,
        avgPrice: order.price || 0,
        unrealizedPnl: 0,
        exchange: 'kis',
        paper: paperMode,
        tradeMode: signalTradeMode,
      });
      if (!paperMode) {
        await attachExecutionToPositionStrategyTracked({
          trade,
          signal,
          dryRun: false,
          requireOpenPosition: true,
        }).catch((error) => {
          console.warn(`  ⚠️ ${symbol} execution attach 실패: ${error.message}`);
        });
      }
      await syncHanulStrategyExecutionState({
        symbol,
        exchange: 'kis',
        tradeMode: signalTradeMode,
        lifecycleStatus: 'position_open',
        recommendation: 'HOLD',
        reasonCode: 'buy_executed',
        reason: 'BUY 체결 완료',
        trade,
        updatedBy: 'hanul_buy_execute',
      });

      await recordHanulEntryJournal({
        market: 'domestic',
        exchange: 'kis',
        signalId,
        symbol,
        trade,
        paperMode,
        confidence: signal.confidence,
        reasoning: signal.reasoning,
      });

    } else if (action === ACTIONS.SELL) {
      const sellState = await prepareHanulSellExecution({
        signalId,
        signalTradeMode,
        paperMode,
        symbol,
        action,
        amount: amountKrw,
        exchange: 'kis',
        market: 'domestic',
        missingReason: '포지션 없음',
        partialExitRatio,
      });
      if (sellState?.success === false) return sellState;

      const order = await kis.marketSell(symbol, Math.floor(sellState.qty), sellState.sellPaperMode);
      trade = {
        signalId, symbol, side: 'sell',
        amount:    order.qty,
        price:     order.price,
        totalUsdt: order.totalKrw,
        paper:     sellState.sellPaperMode,
        exchange:  'kis',
        tradeMode: sellState.effectiveTradeMode,
        partialExitRatio: sellState.partialExitRatio < 1 ? sellState.partialExitRatio : null,
        partialExit: sellState.partialExitRatio < 1,
        remainingAmount: sellState.partialExitRatio < 1 ? Math.max(0, sellState.baseQty - Number(order.qty || 0)) : 0,
        executionOrigin: journalContext.executionOrigin,
        qualityFlag: journalContext.qualityFlag,
        excludeFromLearning: journalContext.excludeFromLearning,
        incidentLink: journalContext.incidentLink,
      };
      if (trade.partialExit) {
        const remainingAmount = Math.max(0, sellState.baseQty - Number(order.qty || 0));
        await db.upsertPosition({
          symbol,
          amount: remainingAmount,
          avgPrice: Number(sellState.position?.avg_price || sellState.position?.avgPrice || 0),
          unrealizedPnl: Number(sellState.position?.unrealized_pnl || sellState.position?.unrealizedPnl || 0),
          exchange: 'kis',
          paper: sellState.sellPaperMode,
          tradeMode: sellState.effectiveTradeMode,
        });
        await syncHanulStrategyExecutionState({
          symbol,
          exchange: 'kis',
          tradeMode: sellState.effectiveTradeMode,
          lifecycleStatus: 'partial_exit_executed',
          recommendation: 'ADJUST',
          reasonCode: 'partial_exit_executed',
          reason: '부분청산 체결 완료',
          trade,
          updatedBy: 'hanul_partial_sell',
        });
      } else {
        await db.deletePosition(symbol, {
          exchange: 'kis',
          paper: sellState.sellPaperMode,
          tradeMode: sellState.effectiveTradeMode,
        });
      }
      await closeOpenJournalForSymbol(
        symbol,
        'domestic',
        sellState.sellPaperMode,
        trade.price,
        trade.totalUsdt,
        exitReasonOverride || 'sell',
        trade.tradeMode,
        {
          partialExitRatio: trade.partialExitRatio,
          soldAmount: Number(order.qty || 0),
          signalId,
          executionOrigin: trade.executionOrigin,
          qualityFlag: trade.qualityFlag,
          excludeFromLearning: trade.excludeFromLearning,
          incidentLink: trade.incidentLink,
        },
      ).catch(() => {});

    } else {
      console.log(`  ⏸️ HOLD — 실행 없음`);
      await db.updateSignalStatus(signalId, SIGNAL_STATUS.EXECUTED);
      return { success: true };
    }

    return finalizeHanulTrade({ trade, signalId, currency: 'KRW', tag });

  } catch (e) {
    console.error(`  ❌ 실행 오류: ${e.message}`);
    await markSignalFailedDetailed(signalId, {
      reason: e.message,
      market: 'domestic',
      symbol,
      action,
      amount: amountKrw,
      error: e.message,
    });
    await notifyError(`한울(KIS) - ${symbol} ${action}`, e);
    return { success: false, error: e.message };
  }
}

// ─── 해외주식 신호 실행 ──────────────────────────────────────────────

/**
 * KIS 해외주식 단일 신호 실행
 * @param {object} signal  { id, symbol, action, amount_usdt(=amountUsd), confidence }
 */
export async function executeOverseasSignal(signal) {
  const paperMode = isPaperMode();
  const kisPaper  = isKisPaper();
  const { id: signalId, symbol, action, amount_usdt: amountUsd } = signal;
  const signalTradeMode = signal.trade_mode || getInvestmentTradeMode();
  const exitReasonOverride = signal.exit_reason_override || null;
  const partialExitRatio = normalizePartialExitRatio(signal.partial_exit_ratio || signal.partialExitRatio);
  const journalContext = buildHanulSignalJournalContext(signal);
  const overseasBuySizing = applyHanulResponsibilityExecutionSizing(amountUsd, {
    action,
    confidence: signal.confidence,
    responsibilityPlan: signal.existingResponsibilityPlan || null,
    executionPlan: signal.existingExecutionPlan || null,
  });
  const overseasMinOrderUsd = action === ACTIONS.BUY
    ? await getDynamicMinOrderAmount('kis_overseas', signalTradeMode)
    : 0;
  const overseasSizingFloor = applyHanulStockSizingFloor(overseasBuySizing.amount, {
    action,
    minOrder: overseasMinOrderUsd,
    maxOrder: KIS_OVERSEAS_RULES.MAX_ORDER_USD,
    currency: 'USD',
  });
  const effectiveBuyAmountUsd = action === ACTIONS.BUY ? overseasSizingFloor.amount : amountUsd;
  const effectiveSignal = action === ACTIONS.BUY
    ? { ...signal, amount_usdt: effectiveBuyAmountUsd }
    : signal;

  const tag = paperMode ? '[PAPER]' : kisPaper ? '[LIVE/MOCK]' : '[LIVE/REAL]';
  console.log(`\n⚡ [한울] 해외 ${symbol} ${action} $${effectiveBuyAmountUsd} ${tag}`);

  try {
    if (overseasSizingFloor.blocked) {
      console.log(`  ⛔ sizing floor 차단: ${overseasSizingFloor.reason}`);
      return failHanulSignal(signalId, {
        reason: overseasSizingFloor.reason,
        code: overseasSizingFloor.code,
        market: 'overseas',
        symbol,
        action,
        amount: effectiveBuyAmountUsd,
        meta: {
          originalAmount: amountUsd,
          sizedAmount: overseasBuySizing.amount,
          minOrder: overseasMinOrderUsd,
        },
      });
    }

    if (overseasSizingFloor.adjusted) {
      console.log(`  🧱 [sizing floor] ${symbol} ${overseasSizingFloor.reason}`);
    }

    const approvalGuard = await enforceHanulNemesisApproval(effectiveSignal, 'overseas');
    if (approvalGuard?.success === false) return approvalGuard;

    const preflight = await getKisExecutionPreflight({ market: 'overseas', action });
    if (!preflight.ok) {
      console.log(`  ⛔ 실행 사전 차단: ${preflight.reason}`);
      return failHanulSignal(signalId, {
        reason: preflight.reason,
        code: preflight.code,
        market: 'overseas',
        symbol,
        action,
        amount: effectiveBuyAmountUsd,
      });
    }

    const risk = await checkKisOverseasRisk(effectiveSignal);
    if (!risk.approved) {
      console.log(`  ❌ 리스크 거부: ${risk.reason}`);
      return failHanulSignal(signalId, {
        reason: risk.reason,
        code: risk.code || null,
        market: 'overseas',
        symbol,
        action,
        amount: effectiveBuyAmountUsd,
      });
    }

    // 신호 알람 (BUY/SELL만, HOLD 제외)
    if (action !== ACTIONS.HOLD) {
      notifyKisOverseasSignal({ symbol, action, amountUsdt: effectiveBuyAmountUsd, confidence: signal.confidence, reasoning: signal.reasoning, paper: paperMode || kisPaper, tradeMode: signalTradeMode });
    }

    const kis = await getKis();
    let trade;

    if (action === ACTIONS.BUY) {
      const buyEntryState = await ensureHanulBuyEntryAllowed({
        signalId,
        signalTradeMode,
        paperMode,
        symbol,
        action,
        amount: effectiveBuyAmountUsd,
        exchange: 'kis_overseas',
        market: 'overseas',
      });
      if (buyEntryState?.success === false) return buyEntryState;

      if (overseasBuySizing.reason && overseasBuySizing.multiplier !== 1) {
        console.log(`  🎛️ [execution tone] ${symbol} 책임계획 반영 x${overseasBuySizing.multiplier.toFixed(2)} (${overseasBuySizing.reason})`);
      }

      const order = await kis.marketBuyOverseas(symbol, effectiveBuyAmountUsd, paperMode);
      trade = {
        signalId, symbol, side: 'buy',
        amount:    order.qty,
        price:     order.price,
        totalUsdt: order.totalUsd,
        paper:     paperMode,
        exchange:  'kis_overseas',
        tradeMode: signalTradeMode,
        executionOrigin: journalContext.executionOrigin,
        qualityFlag: journalContext.qualityFlag,
        excludeFromLearning: journalContext.excludeFromLearning,
        incidentLink: journalContext.incidentLink,
      };

      await db.upsertPosition({
        symbol,
        amount: order.qty || 0,
        avgPrice: order.price || 0,
        unrealizedPnl: 0,
        exchange: 'kis_overseas',
        paper: paperMode,
        tradeMode: signalTradeMode,
      });
      if (!paperMode) {
        await attachExecutionToPositionStrategyTracked({
          trade,
          signal,
          dryRun: false,
          requireOpenPosition: true,
        }).catch((error) => {
          console.warn(`  ⚠️ ${symbol} execution attach 실패: ${error.message}`);
        });
      }
      await syncHanulStrategyExecutionState({
        symbol,
        exchange: 'kis_overseas',
        tradeMode: signalTradeMode,
        lifecycleStatus: 'position_open',
        recommendation: 'HOLD',
        reasonCode: 'buy_executed',
        reason: 'BUY 체결 완료',
        trade,
        updatedBy: 'hanul_buy_execute',
      });

      await recordHanulEntryJournal({
        market: 'overseas',
        exchange: 'kis_overseas',
        signalId,
        symbol,
        trade,
        paperMode,
        confidence: signal.confidence,
        reasoning: signal.reasoning,
      });

    } else if (action === ACTIONS.SELL) {
      const sellState = await prepareHanulSellExecution({
        signalId,
        signalTradeMode,
        paperMode,
        symbol,
        action,
        amount: amountUsd,
        exchange: 'kis_overseas',
        market: 'overseas',
        missingReason: '해외 포지션 없음',
        partialExitRatio,
      });
      if (sellState?.success === false) return sellState;

      const order = await kis.marketSellOverseas(symbol, Math.floor(sellState.qty), sellState.sellPaperMode);
      trade = {
        signalId, symbol, side: 'sell',
        amount:    order.qty,
        price:     order.price,
        totalUsdt: order.totalUsd,
        paper:     sellState.sellPaperMode,
        exchange:  'kis_overseas',
        tradeMode: sellState.effectiveTradeMode,
        partialExitRatio: sellState.partialExitRatio < 1 ? sellState.partialExitRatio : null,
        partialExit: sellState.partialExitRatio < 1,
        remainingAmount: sellState.partialExitRatio < 1 ? Math.max(0, sellState.baseQty - Number(order.qty || 0)) : 0,
        executionOrigin: journalContext.executionOrigin,
        qualityFlag: journalContext.qualityFlag,
        excludeFromLearning: journalContext.excludeFromLearning,
        incidentLink: journalContext.incidentLink,
      };
      if (trade.partialExit) {
        const remainingAmount = Math.max(0, sellState.baseQty - Number(order.qty || 0));
        await db.upsertPosition({
          symbol,
          amount: remainingAmount,
          avgPrice: Number(sellState.position?.avg_price || sellState.position?.avgPrice || 0),
          unrealizedPnl: Number(sellState.position?.unrealized_pnl || sellState.position?.unrealizedPnl || 0),
          exchange: 'kis_overseas',
          paper: sellState.sellPaperMode,
          tradeMode: sellState.effectiveTradeMode,
        });
        await syncHanulStrategyExecutionState({
          symbol,
          exchange: 'kis_overseas',
          tradeMode: sellState.effectiveTradeMode,
          lifecycleStatus: 'partial_exit_executed',
          recommendation: 'ADJUST',
          reasonCode: 'partial_exit_executed',
          reason: '부분청산 체결 완료',
          trade,
          updatedBy: 'hanul_partial_sell',
        });
      } else {
        await db.deletePosition(symbol, {
          exchange: 'kis_overseas',
          paper: sellState.sellPaperMode,
          tradeMode: sellState.effectiveTradeMode,
        });
      }
      await closeOpenJournalForSymbol(
        symbol,
        'overseas',
        sellState.sellPaperMode,
        trade.price,
        trade.totalUsdt,
        exitReasonOverride || 'sell',
        trade.tradeMode,
        {
          partialExitRatio: trade.partialExitRatio,
          soldAmount: Number(order.qty || 0),
          signalId,
          executionOrigin: trade.executionOrigin,
          qualityFlag: trade.qualityFlag,
          excludeFromLearning: trade.excludeFromLearning,
          incidentLink: trade.incidentLink,
        },
      ).catch(() => {});

    } else {
      console.log(`  ⏸️ HOLD — 실행 없음`);
      await db.updateSignalStatus(signalId, SIGNAL_STATUS.EXECUTED);
      return { success: true };
    }

    return finalizeHanulTrade({ trade, signalId, currency: 'USD', tag });

  } catch (e) {
    if (e?.message && e.message.includes('APBK1526')) {
      const livePosition = await db.getLivePosition(symbol, 'kis_overseas', signalTradeMode).catch(() => null);
      const paperPosition = await db.getPaperPosition(symbol, 'kis_overseas', signalTradeMode).catch(() => null);
      const position = paperPosition || livePosition;
      const cleanupPaperMode = paperMode || (!livePosition && !!paperPosition);
      const effectiveTradeMode = getPositionTradeMode(position, signalTradeMode);
      console.warn(`  ⚠️ ${symbol} KIS 해외잔고 미존재 → DB 포지션 삭제 정리`);
      await db.deletePosition(symbol, {
        exchange: 'kis_overseas',
        paper: cleanupPaperMode,
        tradeMode: effectiveTradeMode,
      });
      await closeStaleOpenJournalForSymbol(
        symbol,
        'overseas',
        cleanupPaperMode,
        'broker_no_balance_cleanup',
        effectiveTradeMode,
      ).catch(() => {});
      await markSignalFailedDetailed(signalId, {
        reason: 'KIS 해외잔고 미존재 — DB 포지션 삭제 정리',
        code: 'kis_overseas_no_balance_cleaned',
        market: 'overseas',
        symbol,
        action,
        amount: amountUsd,
      });
      return { success: false, reason: 'KIS 해외잔고 미존재 — 정리됨' };
    }

    console.error(`  ❌ 해외 실행 오류: ${e.message}`);
    await markSignalFailedDetailed(signalId, {
      reason: e.message,
      market: 'overseas',
      symbol,
      action,
      amount: amountUsd,
      error: e.message,
    });
    await notifyError(`한울(KIS해외) - ${symbol} ${action}`, e);
    return { success: false, error: e.message };
  }
}

/**
 * 대기 중인 KIS 국내주식 신호 전체 처리
 */
export async function processAllPendingKisSignals() {
  return processPendingHanulSignals({
    exchange: 'kis',
    label: 'KIS 국내',
    execute: executeSignal,
  });
}

/**
 * 대기 중인 KIS 해외주식 신호 전체 처리
 */
export async function processAllPendingKisOverseasSignals() {
  return processPendingHanulSignals({
    exchange: 'kis_overseas',
    label: 'KIS 해외',
    execute: executeOverseasSignal,
  });
}

// CLI 실행
if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: async () => {
      const args      = process.argv.slice(2);
      const actionArg = args.find(a => a.startsWith('--action='))?.split('=')[1];
      const symbolArg = args.find(a => a.startsWith('--symbol='))?.split('=')[1];
      const amountArg = args.find(a => a.startsWith('--amount='))?.split('=')[1];

      if (actionArg && symbolArg) {
        const sym        = symbolArg.toUpperCase();
        const isOverseas = isKisOverseasSymbol(sym);
        const isDomestic = isKisSymbol(sym);
        if (!isDomestic && !isOverseas) {
          throw new Error(`KIS 심볼 아님: ${sym} (국내: 6자리 숫자, 해외: 알파벳 1~5자)`);
        }
        const mockSignal = {
          id:          `CLI-HAN-${Date.now()}`,
          symbol:      sym,
          action:      actionArg.toUpperCase(),
          amount_usdt: parseFloat(amountArg || (isOverseas ? '400' : '500000')),
          confidence:  0.7,
          reasoning:   'CLI 수동 실행',
          exchange:    isOverseas ? 'kis_overseas' : 'kis',
        };
        return isOverseas ? executeOverseasSignal(mockSignal) : executeSignal(mockSignal);
      }

      const [domestic, overseas] = await Promise.all([
        processAllPendingKisSignals(),
        processAllPendingKisOverseasSignals(),
      ]);
      return { domestic, overseas };
    },
    onSuccess: async (result) => {
      console.log('완료:', JSON.stringify(result));
    },
    errorPrefix: '❌ 한울 오류:',
  });
}
