// @ts-nocheck
/**
 * team/hephaestos.js — 헤파이스토스 (바이낸스 실행봇)
 *
 * 역할: 루나가 승인한 신호를 바이낸스 Spot API로 실행
 * LLM: 없음 (규칙 기반)
 * PAPER_MODE: true → DB 저장 + 텔레그램만 (실주문 없음)
 *
 * bots/invest/src/binance-executor.js 패턴 재사용
 * (Phase 3-A: PAPER_MODE 기본값 — 실주문은 Phase 3-C에서 활성화)
 *
 * 실행: node team/hephaestos.js [--symbol=BTC/USDT] [--action=BUY] [--amount=100]
 */

import * as db from '../shared/db.ts';
import * as journalDb from '../shared/trade-journal-db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { initHubSecrets, isPaperMode, getInvestmentTradeMode } from '../shared/secrets.ts';
import { isSameDaySymbolReentryBlockEnabled, getInvestmentExecutionRuntimeConfig } from '../shared/runtime-config.ts';
import { getInvestmentAgentRoleState } from '../shared/agent-role-state.ts';
import {
  attachExecutionToPositionStrategyTracked,
  syncPositionsAtMarketOpen,
} from '../shared/portfolio-position-delta.ts';
import { SIGNAL_STATUS, ACTIONS } from '../shared/signal.ts';
import { notifyTrade, notifyError, notifyJournalEntry, notifyTradeSkip, notifySettlement } from '../shared/report.ts';
import {
  buildExecutionRiskApprovalGuard,
  preTradeCheck,
  calculatePositionSize,
  getAvailableBalance,
  getAvailableUSDT,
  getOpenPositions,
  getDailyPnL,
  getDailyTradeCount,
  checkCircuitBreaker,
  getCapitalConfig,
  formatDailyTradeLimitReason,
  getDynamicMinOrderAmount,
} from '../shared/execution-risk-and-capital.ts';
import {
  getBinanceExchange,
  getUsdtFreeBalance,
  getTickerLastPrice,
  createBinanceMarketBuy,
  createBinanceMarketSell,
  fetchBinanceOrder,
  getBinanceOpenOrders,
} from '../shared/binance-client.ts';
import {
  isPendingReconcileQuoteConversionError,
  normalizePendingReconcileOrderUnits as normalizePendingReconcileOrderUnitsBase,
  computeBinancePendingRecordedProgress,
  buildBinancePendingReconcilePayload as buildBinancePendingReconcilePayloadBase,
  BINANCE_PENDING_RECONCILE_EPSILON,
  resolveBinancePendingQueueState,
} from '../shared/binance-order-reconcile.ts';
export {
  computeBinancePendingRecordedProgress,
  resolveBinancePendingQueueState,
} from '../shared/binance-order-reconcile.ts';
import {
  extractClientOrderId,
  extractExchangeOrderId,
  normalizeBinanceMarketOrderExecution,
} from '../shared/binance-order-execution-normalizer.ts';
import { buildHephaestosExecutionContext } from './hephaestos/execution-context.ts';
import { buildHephaestosExecutionPreflight } from './hephaestos/execution-preflight.ts';
import { createSignalFailurePersister, rejectExecution } from './hephaestos/execution-failure.ts';
import { buildGuardTelemetryMeta, runBuySafetyGuards } from './hephaestos/execution-guards.ts';
import {
  buildPendingReconcileDeltaIncidentLink,
  escapePendingReconcileLikePattern,
  normalizePendingReconcileTradeRow,
} from './hephaestos/pending-reconcile-core.ts';
export { buildHephaestosExecutionContext } from './hephaestos/execution-context.ts';
export { buildHephaestosExecutionPreflight } from './hephaestos/execution-preflight.ts';
export { createSignalFailurePersister, rejectExecution } from './hephaestos/execution-failure.ts';
export { buildGuardTelemetryMeta, runBuySafetyGuards } from './hephaestos/execution-guards.ts';
export {
  buildPendingReconcileDeltaIncidentLink,
  escapePendingReconcileLikePattern,
  normalizePendingReconcileTradeRow,
} from './hephaestos/pending-reconcile-core.ts';

// ─── 심볼 유효성 ────────────────────────────────────────────────────

const BINANCE_SYMBOL_RE = /^[A-Z0-9]+\/USDT$/;
const BINANCE_PENDING_RECONCILE_JOURNAL_RETRY_DELAY_MS = 30_000;

function isBinanceSymbol(symbol) {
  return BINANCE_SYMBOL_RE.test(symbol);
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function toPositiveNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function parseSignalBlockMeta(blockMeta = null) {
  if (!blockMeta) return {};
  if (typeof blockMeta === 'object') return blockMeta;
  if (typeof blockMeta === 'string') {
    try {
      const parsed = JSON.parse(blockMeta);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function isSyntheticOrTestSignalContext({
  signalId = null,
  reasoning = null,
} = {}) {
  const idText = String(signalId || '').trim().toLowerCase();
  const reasoningText = String(reasoning || '').trim().toLowerCase();
  if (process.env.NODE_ENV === 'test') return true;
  if (process.env.INVESTMENT_SUPPRESS_TEST_ALERTS === '1') return true;
  if (idText.startsWith('smoke-') || idText.includes('-smoke-')) return true;
  if (reasoningText.includes('pending reconcile smoke')) return true;
  if (reasoningText.includes('smoke test')) return true;
  if (reasoningText.includes('unit test')) return true;
  return false;
}

async function loadSignalPendingReconcileMeta(signalId = null) {
  if (!signalId) return {};
  const signal = await db.getSignalById(signalId).catch(() => null);
  const blockMeta = parseSignalBlockMeta(signal?.block_meta);
  const pendingMeta = blockMeta?.pendingReconcile;
  return pendingMeta && typeof pendingMeta === 'object' ? pendingMeta : {};
}

async function normalizePendingReconcileOrderUnits({
  signalSymbol = '',
  orderSymbol = '',
  filledQty = 0,
  price = 0,
  cost = 0,
  pendingMeta = {},
  signalId = null,
} = {}) {
  return normalizePendingReconcileOrderUnitsBase({
    signalSymbol,
    orderSymbol,
    filledQty,
    price,
    cost,
    pendingMeta,
    signalId,
    quotePriceResolver: fetchTicker,
  });
}

function isDefinitiveBinanceOrderLookupError(errorCode = null) {
  const code = String(errorCode || '').trim().toLowerCase();
  return code === 'binance_order_lookup_not_found' || code === 'binance_order_lookup_ambiguous';
}

export function shouldBlockUsdtFallbackAfterBtcPairError(error = null) {
  if (!error || typeof error !== 'object') return false;
  if (error?.meta?.orderAttempted === true) return true;
  const code = String(error?.code || '').trim().toLowerCase();
  return (
    code === 'order_pending_fill_verification'
    || code === 'order_fill_unverified'
    || code === 'btc_pair_order_execution_error'
    || code === 'btc_pair_post_order_reconcile_required'
  );
}

function buildBtcPairPendingReconcileError(cause, {
  signalSymbol,
  orderSymbol,
  orderId = null,
  clientOrderId = null,
  status = 'unknown',
  amount = 0,
  filled = 0,
  usdtPrice = 0,
  usdtCost = 0,
  pairPriceBtc = 0,
  btcReferencePrice = 0,
  submittedAtMs = null,
  reasonCode = 'order_pending_fill_verification',
} = {}) {
  const normalizedAmount = Math.max(0, Number(amount || 0));
  const normalizedFilled = Math.max(0, Number(filled || 0));
  const normalizedUsdtPrice = Math.max(0, Number(usdtPrice || 0));
  const normalizedUsdtCost = Math.max(
    0,
    Number(usdtCost || (normalizedFilled > 0 && normalizedUsdtPrice > 0 ? (normalizedFilled * normalizedUsdtPrice) : 0)),
  );
  const pendingError = /** @type {any} */ (new Error(
    `${reasonCode}:${signalSymbol}:${String(status || 'unknown').toLowerCase()}:${normalizedFilled}:${normalizedUsdtPrice}:${normalizedUsdtCost}`,
  ));
  pendingError.code = 'order_pending_fill_verification';
  pendingError.meta = {
    symbol: String(signalSymbol || '').trim().toUpperCase(),
    orderSymbol: String(orderSymbol || signalSymbol || '').trim().toUpperCase(),
    side: 'buy',
    orderId: orderId ? String(orderId) : null,
    clientOrderId: clientOrderId ? String(clientOrderId) : null,
    status: String(status || 'unknown').trim().toLowerCase() || 'unknown',
    amount: normalizedAmount,
    filled: normalizedFilled,
    price: normalizedUsdtPrice,
    cost: normalizedUsdtCost,
    pairPriceBtc: Math.max(0, Number(pairPriceBtc || 0)),
    btcReferencePrice: Math.max(0, Number(btcReferencePrice || 0)),
    submittedAtMs: toEpochMs(submittedAtMs),
    source: 'btc_pair_direct_buy',
    orderAttempted: true,
    reasonCode,
  };
  pendingError.originalCode = String(cause?.code || '').trim() || null;
  if (cause?.message) {
    pendingError.originalMessage = String(cause.message).slice(0, 240);
  }
  if (cause) {
    pendingError.cause = cause;
  }
  return pendingError;
}

function getExchange() {
  return getBinanceExchange();
}

/**
 * 바이낸스 USDT 가용 잔고 조회 (LU-004: 잔고 부족 알림용)
 */
export async function fetchUsdtBalance() {
  return getUsdtFreeBalance();
}

/**
 * 현재가 조회 (PAPER_MODE에서도 사용)
 */
export async function fetchTicker(symbol) {
  return getTickerLastPrice(symbol);
}

/**
 * 시장가 매수 (PAPER_MODE: 모의 주문)
 */
async function marketBuy(symbol, amountUsdt, paperMode, {
  clientOrderId = null,
  submittedAtMs = null,
} = {}) {
  if (paperMode) {
    const price  = await fetchTicker(symbol).catch(() => 0);
    const filled = price > 0 ? amountUsdt / price : 0;
    console.log(`  📄 [헤파이스토스] PAPER BUY ${symbol} $${amountUsdt} @ ~$${price?.toLocaleString()}`);
    return { filled, price, dryRun: true };
  }
  const rawOrder = await createBinanceMarketBuy(symbol, amountUsdt, {
    clientOrderId,
  });
  return normalizeBinanceMarketOrderExecution(symbol, 'buy', rawOrder, {
    expectedClientOrderId: clientOrderId,
    submittedAtMs,
  });
}

/**
 * 시장가 매도 (PAPER_MODE: 모의 주문)
 */
async function marketSell(symbol, amount, paperMode, {
  clientOrderId = null,
  submittedAtMs = null,
} = {}) {
  if (paperMode) {
    const price     = await fetchTicker(symbol).catch(() => 0);
    const totalUsdt = amount * price;
    console.log(`  📄 [헤파이스토스] PAPER SELL ${symbol} ${amount} @ ~$${price?.toLocaleString()}`);
    return {
      amount,
      filled: amount,
      price,
      average: price,
      totalUsdt,
      cost: totalUsdt,
      status: 'closed',
      dryRun: true,
      normalized: true,
    };
  }
  const ex = getExchange();
  await ex.loadMarkets();
  const normalizedAmount = roundSellAmount(symbol, amount);
  const minSellAmount = await getMinSellAmount(symbol).catch(() => 0);
  if (normalizedAmount <= 0 || (minSellAmount > 0 && normalizedAmount < minSellAmount)) {
    const error = /** @type {any} */ (new Error(`sell_amount_below_minimum:${symbol}:${normalizedAmount}:${minSellAmount}`));
    error.code = 'sell_amount_below_minimum';
    error.meta = {
      symbol,
      requestedAmount: amount,
      normalizedAmount,
      minSellAmount,
    };
    throw error;
  }
  const rawOrder = await createBinanceMarketSell(symbol, normalizedAmount, {
    clientOrderId,
  });
  return normalizeBinanceMarketOrderExecution(symbol, 'sell', rawOrder, {
    expectedClientOrderId: clientOrderId,
    submittedAtMs,
  });
}

async function getMinSellAmount(symbol) {
  const ex = getExchange();
  await ex.loadMarkets();
  const market = ex.market(symbol);
  const exchangeMin = Number(market?.limits?.amount?.min || 0);
  const rawPrecision = market?.precision?.amount;
  let precisionStep = 0;
  if (typeof rawPrecision === 'number' && Number.isFinite(rawPrecision)) {
    precisionStep = rawPrecision >= 1 ? (1 / (10 ** rawPrecision)) : rawPrecision;
  }
  return Math.max(exchangeMin, precisionStep);
}

export function buildBinancePendingReconcilePayload(signal = {}) {
  return buildBinancePendingReconcilePayloadBase(signal, {
    defaultTradeMode: getInvestmentTradeMode(),
  });
}

async function isBinanceOrderStillOpen(symbol, orderId, clientOrderId = null) {
  if (!symbol || (!orderId && !clientOrderId)) return null;
  try {
    const openOrders = await getBinanceOpenOrders(symbol);
    const targetOrderId = String(orderId);
    const targetClientOrderId = String(clientOrderId || '').trim();
    return (openOrders || []).some((order) => {
      const currentOrderId = String(extractExchangeOrderId(order) || '');
      const currentClientOrderId = String(extractClientOrderId(order) || '');
      if (targetOrderId && currentOrderId && currentOrderId === targetOrderId) return true;
      if (targetClientOrderId && currentClientOrderId && currentClientOrderId === targetClientOrderId) return true;
      return false;
    });
  } catch {
    return null;
  }
}

function buildPendingReconcileQualityContext(signal = null) {
  const base = buildSignalQualityContext(signal);
  return {
    ...base,
    executionOrigin: 'reconciliation',
    qualityFlag: base.qualityFlag === 'exclude_from_learning' ? base.qualityFlag : 'degraded',
    excludeFromLearning: true,
    incidentLink: base.incidentLink || 'order_pending_reconcile',
  };
}

async function findPendingReconcileDeltaTrade({
  signalId = null,
  symbol = null,
  side = null,
  incidentLink = null,
} = {}) {
  if (!signalId || !symbol || !side || !incidentLink) return null;
  return db.get(
    `SELECT id, signal_id, symbol, side, amount, price, total_usdt, paper, exchange, trade_mode, executed_at, incident_link
       FROM trades
      WHERE signal_id = $1
        AND symbol = $2
        AND side = $3
        AND exchange = 'binance'
        AND incident_link = $4
      ORDER BY executed_at DESC
      LIMIT 1`,
    [signalId, symbol, side, incidentLink],
  );
}

async function getPendingReconcileAppliedSnapshot({
  signalId = null,
  symbol = null,
  side = null,
  orderId = null,
  clientOrderId = null,
} = {}) {
  const orderKey = String(orderId || clientOrderId || '').trim();
  if (!signalId || !symbol || !side || !orderKey) {
    return { appliedFilledQty: 0, appliedCost: 0 };
  }
  const prefix = `pending_reconcile_delta:${signalId}:${orderKey}:${String(side).toLowerCase()}:`;
  const likePattern = `${escapePendingReconcileLikePattern(prefix)}%`;
  const row = await db.get(
    `SELECT
       COALESCE(SUM(amount), 0) AS applied_filled_qty,
       COALESCE(SUM(total_usdt), 0) AS applied_cost
     FROM trades
     WHERE signal_id = $1
       AND symbol = $2
       AND side = $3
       AND exchange = 'binance'
       AND incident_link LIKE $4 ESCAPE '\\'`,
    [signalId, symbol, side, likePattern],
  );
  return {
    appliedFilledQty: Math.max(0, Number(row?.applied_filled_qty || 0)),
    appliedCost: Math.max(0, Number(row?.applied_cost || 0)),
  };
}

async function loadBinancePendingReconcileTrade({
  signalId = null,
  symbol = null,
  side = null,
  tradeId = null,
  incidentLink = null,
} = {}) {
  if (!signalId || !symbol || !side) return null;
  if (tradeId) {
    const byId = await db.get(
      `SELECT id, signal_id, symbol, side, amount, price, total_usdt, paper, exchange, trade_mode, incident_link,
              COALESCE(partial_exit, false) AS partial_exit, partial_exit_ratio, remaining_amount,
              execution_origin, quality_flag, exclude_from_learning
         FROM trades
        WHERE id = $1
          AND signal_id = $2
          AND exchange = 'binance'
        LIMIT 1`,
      [tradeId, signalId],
    ).catch(() => null);
    if (byId) return normalizePendingReconcileTradeRow(byId);
  }

  if (incidentLink) {
    const byIncident = await db.get(
      `SELECT id, signal_id, symbol, side, amount, price, total_usdt, paper, exchange, trade_mode, incident_link,
              COALESCE(partial_exit, false) AS partial_exit, partial_exit_ratio, remaining_amount,
              execution_origin, quality_flag, exclude_from_learning
         FROM trades
        WHERE signal_id = $1
          AND symbol = $2
          AND side = $3
          AND exchange = 'binance'
          AND incident_link = $4
        ORDER BY executed_at DESC
        LIMIT 1`,
      [signalId, symbol, side, incidentLink],
    ).catch(() => null);
    if (byIncident) return normalizePendingReconcileTradeRow(byIncident);
  }

  const latest = await db.get(
    `SELECT id, signal_id, symbol, side, amount, price, total_usdt, paper, exchange, trade_mode, incident_link,
            COALESCE(partial_exit, false) AS partial_exit, partial_exit_ratio, remaining_amount,
            execution_origin, quality_flag, exclude_from_learning
       FROM trades
      WHERE signal_id = $1
        AND symbol = $2
        AND side = $3
        AND exchange = 'binance'
      ORDER BY executed_at DESC
      LIMIT 1`,
    [signalId, symbol, side],
  ).catch(() => null);
  return latest ? normalizePendingReconcileTradeRow(latest) : null;
}

async function hasPendingReconcileJournalCoverage({
  signalId = null,
  symbol = null,
  incidentLink = null,
} = {}) {
  if (!signalId || !symbol || !incidentLink) return false;
  const row = await db.get(
    `SELECT trade_id
       FROM trade_journal
      WHERE signal_id = $1
        AND market = 'crypto'
        AND exchange = 'binance'
        AND symbol = $2
        AND incident_link = $3
      ORDER BY created_at DESC
      LIMIT 1`,
    [signalId, symbol, incidentLink],
  );
  return Boolean(row?.trade_id);
}

async function markBinancePendingReconcileJournalState(signalId, {
  pendingMeta = {},
  trade = null,
  followUpRequired = false,
  queueStatus = 'completed',
  attemptIncrement = 0,
  lastError = null,
  source = 'pending_reconcile_apply',
} = {}) {
  if (!signalId) return null;
  const providedPendingMeta = pendingMeta && typeof pendingMeta === 'object' ? pendingMeta : {};
  const currentPendingMeta = await loadSignalPendingReconcileMeta(signalId).catch(() => ({}));
  const basePendingMeta = {
    ...currentPendingMeta,
    ...providedPendingMeta,
  };
  const currentJournalPending = basePendingMeta?.journalPending && typeof basePendingMeta.journalPending === 'object'
    ? basePendingMeta.journalPending
    : {};
  const attemptsBase = Math.max(0, Number(currentJournalPending.attempts || 0));
  const safeAttemptIncrement = Math.max(0, Number(attemptIncrement || 0));
  const attempts = attemptsBase + safeAttemptIncrement;
  const nowIso = new Date().toISOString();
  const journalPendingPatch = {
    exchange: 'binance',
    symbol: trade?.symbol || basePendingMeta?.symbol || null,
    side: trade?.side || null,
    tradeId: trade?.id || currentJournalPending.tradeId || null,
    incidentLink: trade?.incidentLink || currentJournalPending.incidentLink || null,
    queueStatus,
    followUpRequired: Boolean(followUpRequired),
    attempts,
    source,
    nextRetryAt: followUpRequired
      ? new Date(Date.now() + BINANCE_PENDING_RECONCILE_JOURNAL_RETRY_DELAY_MS).toISOString()
      : null,
    lastError: followUpRequired ? String(lastError || 'journal_pending').slice(0, 240) : null,
    updatedAt: nowIso,
  };
  if (!followUpRequired) {
    journalPendingPatch.repairedAt = nowIso;
  }
  const nextPendingReconcile = {
    ...basePendingMeta,
    journalPending: {
      ...currentJournalPending,
      ...journalPendingPatch,
    },
  };
  await db.mergeSignalBlockMeta(signalId, {
    pendingReconcile: nextPendingReconcile,
  });
  return nextPendingReconcile.journalPending;
}

async function ensurePendingReconcileJournalRecorded({
  trade = null,
  signalId = null,
  pendingMeta = {},
  source = 'pending_reconcile_apply',
  exitReason = 'order_pending_reconcile_delta',
} = {}) {
  if (!trade || !signalId) {
    return { ok: false, reason: 'journal_input_missing' };
  }
  const canVerify = Boolean(trade.incidentLink && trade.symbol);
  if (canVerify) {
    const alreadyRecorded = await hasPendingReconcileJournalCoverage({
      signalId,
      symbol: trade.symbol,
      incidentLink: trade.incidentLink,
    });
    if (alreadyRecorded) {
      const pendingState = await markBinancePendingReconcileJournalState(signalId, {
        pendingMeta,
        trade,
        followUpRequired: false,
        queueStatus: 'completed',
        attemptIncrement: 0,
        source,
      }).catch(() => null);
      return {
        ok: true,
        alreadyRecorded: true,
        pendingState,
      };
    }
  }

  let journalError = null;
  try {
    await recordExecutedTradeJournal({
      trade,
      signalId,
      exitReason,
    });
  } catch (error) {
    journalError = error;
  }

  let verified = false;
  if (canVerify) {
    verified = await hasPendingReconcileJournalCoverage({
      signalId,
      symbol: trade.symbol,
      incidentLink: trade.incidentLink,
    }).catch(() => false);
  } else {
    verified = !journalError;
  }

  if (verified) {
    const pendingState = await markBinancePendingReconcileJournalState(signalId, {
      pendingMeta,
      trade,
      followUpRequired: false,
      queueStatus: 'completed',
      attemptIncrement: 1,
      source,
    }).catch(() => null);
    return {
      ok: true,
      alreadyRecorded: false,
      pendingState,
    };
  }

  const reason = journalError
    ? String(journalError?.message || journalError)
    : 'journal_record_unverified';
  const pendingState = await markBinancePendingReconcileJournalState(signalId, {
    pendingMeta,
    trade,
    followUpRequired: true,
    queueStatus: 'queued',
    attemptIncrement: 1,
    lastError: reason,
    source,
  }).catch(() => null);
  return {
    ok: false,
    reason,
    pendingState,
  };
}

async function acquirePendingReconcileTxLock(tx, lockKey) {
  const row = await tx.get(
    `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)::bigint) AS locked`,
    [String(lockKey || '')],
  );
  if (!row?.locked) {
    const lockError = /** @type {any} */ (new Error(`pending_reconcile_lock_unavailable:${lockKey}`));
    lockError.code = 'pending_reconcile_lock_unavailable';
    throw lockError;
  }
}

async function applyBinancePendingReconcileDelta({
  payload,
  deltaFilledQty = 0,
  deltaCost = 0,
  orderPrice = 0,
  stateCode = 'order_pending_reconcile',
} = {}) {
  if (!payload) return { applied: false, trade: null, tradeModeUsed: null, appliedFilledQty: 0, appliedCost: 0 };
  const normalizedDeltaFilled = Math.max(0, Number(deltaFilledQty || 0));
  if (normalizedDeltaFilled <= BINANCE_PENDING_RECONCILE_EPSILON) {
    return { applied: false, trade: null, tradeModeUsed: payload.tradeMode || 'normal', appliedFilledQty: 0, appliedCost: 0 };
  }

  const normalizedDeltaCost = Math.max(0, Number(deltaCost || 0));
  const normalizedOrderPrice = Math.max(0, Number(orderPrice || 0));
  const unitPrice = normalizedOrderPrice > 0
    ? normalizedOrderPrice
    : (normalizedDeltaCost > 0 ? (normalizedDeltaCost / normalizedDeltaFilled) : 0);
  const totalUsdt = normalizedDeltaCost > 0 ? normalizedDeltaCost : (normalizedDeltaFilled * unitPrice);
  const qualityContext = buildPendingReconcileQualityContext(payload.signal);
  const signalTradeMode = payload.tradeMode || 'normal';
  const targetFilledQty = Math.max(0, Number(payload.recordedFilledQty || 0) + normalizedDeltaFilled);
  const deltaIncidentLink = buildPendingReconcileDeltaIncidentLink({
    signalId: payload.signalId,
    orderId: payload.orderId,
    clientOrderId: payload.clientOrderId,
    action: payload.action,
    targetFilledQty,
  });
  const side = payload.action === ACTIONS.BUY ? 'buy' : 'sell';
  const orderKeyForLock = payload.orderId || payload.clientOrderId || 'none';
  const lockKey = `pending_reconcile_apply:${payload.signalId}:${orderKeyForLock}:${side}`;

  const transactional = await db.withTransaction(async (tx) => {
    await acquirePendingReconcileTxLock(tx, lockKey);

    const existingDeltaTradeRow = await tx.get(
      `SELECT id, signal_id, symbol, side, amount, price, total_usdt, paper, exchange, trade_mode, incident_link,
              NULL::boolean AS partial_exit,
              NULL::double precision AS partial_exit_ratio,
              NULL::double precision AS remaining_amount
         FROM trades
        WHERE signal_id = $1
          AND symbol = $2
          AND side = $3
          AND exchange = 'binance'
          AND incident_link = $4
        ORDER BY executed_at DESC
        LIMIT 1`,
      [payload.signalId, payload.symbol, side, deltaIncidentLink],
    );
    if (existingDeltaTradeRow) {
      const existingTrade = normalizePendingReconcileTradeRow(existingDeltaTradeRow);
      return {
        deduped: true,
        trade: existingTrade,
        tradeModeUsed: existingTrade.tradeMode || signalTradeMode,
      };
    }

    if (payload.action === ACTIONS.BUY) {
      const currentPosition = await tx.get(
        `SELECT symbol, amount, avg_price, unrealized_pnl, paper, exchange, COALESCE(trade_mode, 'normal') AS trade_mode
           FROM positions
          WHERE symbol = $1
            AND exchange = 'binance'
            AND paper = $2
            AND COALESCE(trade_mode, 'normal') = $3
          LIMIT 1
          FOR UPDATE`,
        [payload.symbol, Boolean(payload.paperMode), signalTradeMode],
      );
      const beforeAmount = Math.max(0, Number(currentPosition?.amount || 0));
      const beforeAvgPrice = Math.max(0, Number(currentPosition?.avg_price || 0));
      const nextAmount = beforeAmount + normalizedDeltaFilled;
      const weightedValue = (beforeAmount * beforeAvgPrice) + (normalizedDeltaFilled * unitPrice);
      const nextAvgPrice = nextAmount > BINANCE_PENDING_RECONCILE_EPSILON ? (weightedValue / nextAmount) : unitPrice;

      await tx.run(
        `INSERT INTO positions (symbol, amount, avg_price, unrealized_pnl, paper, exchange, trade_mode, updated_at)
         VALUES ($1, $2, $3, 0, $4, 'binance', $5, now())
         ON CONFLICT (symbol, exchange, paper, trade_mode)
         DO UPDATE SET
           amount = EXCLUDED.amount,
           avg_price = EXCLUDED.avg_price,
           unrealized_pnl = EXCLUDED.unrealized_pnl,
           updated_at = now()`,
        [payload.symbol, nextAmount, nextAvgPrice, Boolean(payload.paperMode), signalTradeMode],
      );

      const insertedTradeRow = await tx.get(
        `INSERT INTO trades
           (signal_id, symbol, side, amount, price, total_usdt, paper, exchange, trade_mode,
            execution_origin, quality_flag, exclude_from_learning, incident_link)
         VALUES
           ($1, $2, 'buy', $3, $4, $5, $6, 'binance', $7, $8, $9, $10, $11)
         RETURNING id, signal_id, symbol, side, amount, price, total_usdt, paper, exchange, trade_mode, incident_link`,
        [
          payload.signalId,
          payload.symbol,
          normalizedDeltaFilled,
          unitPrice,
          totalUsdt,
          Boolean(payload.paperMode),
          signalTradeMode,
          qualityContext.executionOrigin,
          qualityContext.qualityFlag,
          Boolean(qualityContext.excludeFromLearning),
          deltaIncidentLink,
        ],
      );
      const trade = normalizePendingReconcileTradeRow(insertedTradeRow);
      trade.executionOrigin = qualityContext.executionOrigin;
      trade.qualityFlag = qualityContext.qualityFlag;
      trade.excludeFromLearning = Boolean(qualityContext.excludeFromLearning);
      trade.incidentLink = deltaIncidentLink;
      return {
        deduped: false,
        trade,
        tradeModeUsed: signalTradeMode,
      };
    }

    if (payload.action === ACTIONS.SELL) {
      const currentPosition = await tx.get(
        `SELECT symbol, amount, avg_price, unrealized_pnl, paper, exchange, COALESCE(trade_mode, 'normal') AS trade_mode
           FROM positions
          WHERE symbol = $1
            AND exchange = 'binance'
            AND paper = $2
            AND COALESCE(trade_mode, 'normal') = $3
          LIMIT 1
          FOR UPDATE`,
        [payload.symbol, Boolean(payload.paperMode), signalTradeMode],
      );
      const effectiveTradeMode = currentPosition?.trade_mode || signalTradeMode;
      const beforeAmount = Math.max(0, Number(currentPosition?.amount || 0));
      const soldAmount = beforeAmount > BINANCE_PENDING_RECONCILE_EPSILON
        ? Math.min(normalizedDeltaFilled, beforeAmount)
        : normalizedDeltaFilled;
      const remainingAmount = beforeAmount > BINANCE_PENDING_RECONCILE_EPSILON
        ? Math.max(0, beforeAmount - soldAmount)
        : 0;

      if (beforeAmount > BINANCE_PENDING_RECONCILE_EPSILON) {
        if (remainingAmount > BINANCE_PENDING_RECONCILE_EPSILON) {
          const scaledUnrealized = beforeAmount > BINANCE_PENDING_RECONCILE_EPSILON
            ? Number(currentPosition?.unrealized_pnl || 0) * (remainingAmount / beforeAmount)
            : 0;
          await tx.run(
            `UPDATE positions
                SET amount = $1,
                    avg_price = $2,
                    unrealized_pnl = $3,
                    updated_at = now()
              WHERE symbol = $4
                AND exchange = 'binance'
                AND paper = $5
                AND COALESCE(trade_mode, 'normal') = $6`,
            [
              remainingAmount,
              Math.max(0, Number(currentPosition?.avg_price || 0)),
              scaledUnrealized,
              payload.symbol,
              Boolean(payload.paperMode),
              effectiveTradeMode,
            ],
          );
        } else {
          await tx.run(
            `DELETE FROM positions
              WHERE symbol = $1
                AND exchange = 'binance'
                AND paper = $2
                AND COALESCE(trade_mode, 'normal') = $3`,
            [payload.symbol, Boolean(payload.paperMode), effectiveTradeMode],
          );
        }
      }

      const isPartialExit = beforeAmount > BINANCE_PENDING_RECONCILE_EPSILON
        ? remainingAmount > BINANCE_PENDING_RECONCILE_EPSILON
        : false;
      const partialExitRatio = beforeAmount > BINANCE_PENDING_RECONCILE_EPSILON
        ? normalizePartialExitRatio(Math.min(1, soldAmount / beforeAmount))
        : null;
      const insertedTradeRow = await tx.get(
        `INSERT INTO trades
           (signal_id, symbol, side, amount, price, total_usdt, paper, exchange, trade_mode,
            partial_exit, partial_exit_ratio, remaining_amount,
            execution_origin, quality_flag, exclude_from_learning, incident_link)
         VALUES
           ($1, $2, 'sell', $3, $4, $5, $6, 'binance', $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id, signal_id, symbol, side, amount, price, total_usdt, paper, exchange, trade_mode, incident_link,
                   COALESCE(partial_exit, false) AS partial_exit, partial_exit_ratio, remaining_amount`,
        [
          payload.signalId,
          payload.symbol,
          soldAmount,
          unitPrice,
          totalUsdt,
          Boolean(payload.paperMode),
          effectiveTradeMode,
          isPartialExit,
          partialExitRatio,
          isPartialExit ? remainingAmount : 0,
          qualityContext.executionOrigin,
          qualityContext.qualityFlag,
          Boolean(qualityContext.excludeFromLearning),
          deltaIncidentLink,
        ],
      );
      const trade = normalizePendingReconcileTradeRow(insertedTradeRow);
      trade.executionOrigin = qualityContext.executionOrigin;
      trade.qualityFlag = qualityContext.qualityFlag;
      trade.excludeFromLearning = Boolean(qualityContext.excludeFromLearning);
      trade.incidentLink = deltaIncidentLink;
      return {
        deduped: false,
        trade,
        tradeModeUsed: effectiveTradeMode,
      };
    }

    return {
      deduped: false,
      trade: null,
      tradeModeUsed: signalTradeMode,
    };
  });

  if (!transactional?.trade) {
    return { applied: false, trade: null, tradeModeUsed: transactional?.tradeModeUsed || signalTradeMode, appliedFilledQty: 0, appliedCost: 0 };
  }

  const trade = transactional.trade;
  const journalResult = await ensurePendingReconcileJournalRecorded({
    trade,
    signalId: payload.signalId,
    pendingMeta: payload.pendingMeta,
    source: 'pending_reconcile_apply',
    exitReason: 'order_pending_reconcile_delta',
  });
  if (!journalResult.ok) {
    console.warn(`  ⚠️ pending reconcile journal 보강 대기: ${journalResult.reason}`);
    await notifyError(`헤파이스토스 pending reconcile journal 대기 — ${payload.symbol} ${payload.action}`, journalResult.reason).catch(() => {});
  }

  if (payload.action === ACTIONS.BUY) {
    await syncCryptoStrategyExecutionState({
      symbol: payload.symbol,
      tradeMode: transactional.tradeModeUsed || signalTradeMode,
      lifecycleStatus: stateCode === 'order_reconciled'
        ? 'position_open'
        : 'position_open_partial_fill_pending',
      recommendation: 'HOLD',
      reasonCode: stateCode,
      reason: 'BUY pending 체결 delta 정산',
      trade,
      executionMission: payload.signal?.executionMission || null,
      updatedBy: 'hephaestos_pending_reconcile_apply',
    }).catch(() => null);
  } else if (payload.action === ACTIONS.SELL) {
    const remainingAmount = Math.max(0, Number(trade?.remainingAmount || 0));
    const lifecycleStatus = remainingAmount > BINANCE_PENDING_RECONCILE_EPSILON
      ? (stateCode === 'order_reconciled' ? 'partial_exit_executed' : 'partial_exit_pending_reconcile')
      : (stateCode === 'order_reconciled' ? 'position_closed' : 'exit_order_pending_reconcile');
    await syncCryptoStrategyExecutionState({
      symbol: payload.symbol,
      tradeMode: transactional.tradeModeUsed || signalTradeMode,
      lifecycleStatus,
      recommendation: remainingAmount > BINANCE_PENDING_RECONCILE_EPSILON ? 'ADJUST' : 'EXIT',
      reasonCode: stateCode,
      reason: 'SELL pending 체결 delta 정산',
      trade,
      partialExitRatio: trade?.partialExitRatio ?? null,
      executionMission: payload.signal?.executionMission || null,
      updatedBy: 'hephaestos_pending_reconcile_apply',
    }).catch(() => null);
  }

  return {
    applied: true,
    deduped: Boolean(transactional.deduped),
    trade,
    tradeModeUsed: transactional.tradeModeUsed || signalTradeMode,
    appliedFilledQty: normalizedDeltaFilled,
    appliedCost: totalUsdt,
  };
}

async function syncPendingReconcileSnapshotState({
  payload,
  tradeMode,
  stateCode = 'order_reconciled',
} = {}) {
  if (!payload) return;
  const effectiveTradeMode = tradeMode || payload.tradeMode || 'normal';
  if (payload.action === ACTIONS.BUY) {
    await syncCryptoStrategyExecutionState({
      symbol: payload.symbol,
      tradeMode: effectiveTradeMode,
      lifecycleStatus: stateCode === 'order_reconciled'
        ? 'position_open'
        : 'position_open_partial_fill_pending',
      recommendation: 'HOLD',
      reasonCode: stateCode,
      reason: 'BUY pending 체결 상태 갱신',
      updatedBy: 'hephaestos_pending_reconcile_snapshot',
    }).catch(() => null);
    return;
  }

  if (payload.action === ACTIONS.SELL) {
    const position = payload.paperMode
      ? await db.getPaperPosition(payload.symbol, 'binance', effectiveTradeMode).catch(() => null)
      : await db.getLivePosition(payload.symbol, 'binance', effectiveTradeMode).catch(() => null);
    const remainingAmount = Math.max(0, Number(position?.amount || 0));
    const lifecycleStatus = remainingAmount > BINANCE_PENDING_RECONCILE_EPSILON
      ? (stateCode === 'order_reconciled' ? 'partial_exit_executed' : 'partial_exit_pending_reconcile')
      : (stateCode === 'order_reconciled' ? 'position_closed' : 'exit_order_pending_reconcile');
    await syncCryptoStrategyExecutionState({
      symbol: payload.symbol,
      tradeMode: effectiveTradeMode,
      lifecycleStatus,
      recommendation: remainingAmount > BINANCE_PENDING_RECONCILE_EPSILON ? 'ADJUST' : 'EXIT',
      reasonCode: stateCode,
      reason: 'SELL pending 체결 상태 갱신',
      updatedBy: 'hephaestos_pending_reconcile_snapshot',
    }).catch(() => null);
  }
}

async function markBinanceOrderPendingReconcileSignal(signalId, {
  symbol,
  action,
  amountUsdt = 0,
  tradeMode = 'normal',
  paperMode = false,
  orderMeta = {},
  existingRecordedFilledQty = 0,
  existingRecordedCost = 0,
  appliedFilledQty = 0,
  appliedCost = 0,
  reconcileError = null,
  orderStillOpen = null,
  pendingMeta = {},
} = {}) {
  if (!signalId) return null;
  const currentPendingMeta = await loadSignalPendingReconcileMeta(signalId).catch(() => ({}));
  const providedPendingMeta = pendingMeta && typeof pendingMeta === 'object' ? pendingMeta : {};
  const basePendingMeta = {
    ...currentPendingMeta,
    ...providedPendingMeta,
  };
  const preservedJournalPending = basePendingMeta?.journalPending && typeof basePendingMeta.journalPending === 'object'
    ? basePendingMeta.journalPending
    : null;
  const filledQty = Math.max(0, Number(orderMeta?.filled || 0));
  const expectedQty = Math.max(0, Number(orderMeta?.amount || 0));
  const price = Math.max(0, Number(orderMeta?.price || orderMeta?.average || 0));
  const cost = Math.max(0, Number(orderMeta?.cost || (filledQty * price)));
  const state = resolveBinancePendingQueueState({
    status: orderMeta?.status || 'unknown',
    filledQty,
    expectedQty,
    orderStillOpen,
  });
  const baseRecordedFilled = Math.max(0, Number(existingRecordedFilledQty || 0));
  const baseRecordedCost = Math.max(0, Number(existingRecordedCost || 0));
  const safeAppliedFilled = Math.max(0, Number(reconcileError ? 0 : (appliedFilledQty || 0)));
  const safeAppliedCost = Math.max(0, Number(reconcileError ? 0 : (appliedCost || 0)));
  const nextRecordedFilledQty = Math.min(
    filledQty,
    Math.max(baseRecordedFilled, baseRecordedFilled + safeAppliedFilled),
  );
  let nextRecordedCost = Math.max(baseRecordedCost, baseRecordedCost + safeAppliedCost);
  if (cost > BINANCE_PENDING_RECONCILE_EPSILON) {
    nextRecordedCost = Math.min(cost, nextRecordedCost);
  }
  const queueStatus = reconcileError ? 'retrying' : state.queueStatus;
  const followUpRequired = reconcileError ? true : state.followUpRequired;

  const reason = reconcileError
    ? `정산 반영 실패 — 재시도 대기 (${String(reconcileError).slice(0, 96)})`
    : state.code === 'order_reconciled'
      ? `주문 정산 완료 (${filledQty.toFixed(8)} @ ${price > 0 ? price.toFixed(8) : 'N/A'})`
      : state.code === 'partial_fill_pending'
        ? `부분체결 대기 (${filledQty.toFixed(8)} / ${expectedQty > 0 ? expectedQty.toFixed(8) : '?'})`
        : `주문 접수됨 — 체결 대기 (orderKey=${orderMeta?.orderId || orderMeta?.clientOrderId || 'N/A'})`;

  await db.updateSignalBlock(signalId, {
    status: SIGNAL_STATUS.EXECUTED,
    reason: reason.slice(0, 180),
    code: reconcileError ? 'order_pending_reconcile' : state.code,
  });

  await db.mergeSignalBlockMeta(signalId, {
    pendingReconcile: {
      ...basePendingMeta,
      exchange: 'binance',
      market: 'crypto',
      symbol,
      orderSymbol: String(orderMeta?.orderSymbol || basePendingMeta?.orderSymbol || symbol || '').trim().toUpperCase() || symbol,
      action,
      tradeMode,
      amountUsdt: Number(amountUsdt || 0),
      paperMode: Boolean(paperMode),
      orderId: orderMeta?.orderId || null,
      clientOrderId: orderMeta?.clientOrderId || basePendingMeta?.clientOrderId || null,
      submittedAt: orderMeta?.submittedAt
        || (orderMeta?.submittedAtMs ? new Date(Number(orderMeta.submittedAtMs)).toISOString() : null)
        || basePendingMeta?.submittedAt
        || new Date().toISOString(),
      submittedAtMs: Number(orderMeta?.submittedAtMs || 0) > 0
        ? Number(orderMeta.submittedAtMs)
        : (Number(basePendingMeta?.submittedAtMs || 0) > 0 ? Number(basePendingMeta.submittedAtMs) : undefined),
      verificationStatus: String(orderMeta?.status || 'unknown'),
      expectedQty,
      filledQty,
      recordedFilledQty: nextRecordedFilledQty,
      recordedCost: nextRecordedCost,
      lastAppliedFilledDelta: safeAppliedFilled,
      lastAppliedCostDelta: safeAppliedCost,
      price,
      rawPrice: Number(orderMeta?.rawPrice || 0) > 0 ? Number(orderMeta.rawPrice) : undefined,
      rawCost: Number(orderMeta?.rawCost || 0) > 0 ? Number(orderMeta.rawCost) : undefined,
      quoteAsset: orderMeta?.quoteAsset || basePendingMeta?.quoteAsset || undefined,
      signalQuoteAsset: orderMeta?.signalQuoteAsset || basePendingMeta?.signalQuoteAsset || undefined,
      quoteConversionApplied: Boolean(orderMeta?.quoteConversionApplied),
      quoteConversionPair: orderMeta?.quoteConversionPair || basePendingMeta?.quoteConversionPair || undefined,
      quoteConversionRate: Number(orderMeta?.quoteConversionRate || 0) > 0
        ? Number(orderMeta.quoteConversionRate)
        : (Number(basePendingMeta?.quoteConversionRate || 0) > 0 ? Number(basePendingMeta.quoteConversionRate) : undefined),
      btcReferencePrice: Number(orderMeta?.btcReferencePrice || 0) > 0
        ? Number(orderMeta.btcReferencePrice)
        : (Number(basePendingMeta?.btcReferencePrice || 0) > 0 ? Number(basePendingMeta.btcReferencePrice) : undefined),
      queueStatus,
      followUpRequired,
      reconcileError: reconcileError ? String(reconcileError).slice(0, 240) : null,
      updatedAt: new Date().toISOString(),
      ...(preservedJournalPending ? { journalPending: preservedJournalPending } : {}),
    },
  });

  return {
    ...state,
    queueStatus,
    followUpRequired,
    recordedFilledQty: nextRecordedFilledQty,
    recordedCost: nextRecordedCost,
  };
}

export async function processBinancePendingReconcileQueue({
  tradeModes = [],
  limit = 40,
  delayMs = 150,
  deps = {},
} = {}) {
  const fetchOrderFn = typeof deps?.fetchOrder === 'function'
    ? deps.fetchOrder
    : fetchBinanceOrder;
  const isOrderStillOpenFn = typeof deps?.isOrderStillOpen === 'function'
    ? deps.isOrderStillOpen
    : isBinanceOrderStillOpen;
  const applyDeltaFn = typeof deps?.applyDelta === 'function'
    ? deps.applyDelta
    : applyBinancePendingReconcileDelta;
  const markSignalFn = typeof deps?.markSignal === 'function'
    ? deps.markSignal
    : markBinanceOrderPendingReconcileSignal;

  const normalizedModes = Array.from(new Set(
    (Array.isArray(tradeModes) ? tradeModes : [])
      .map((mode) => String(mode || '').trim())
      .filter(Boolean),
  ));
  const modeFilter = normalizedModes.length > 0 ? normalizedModes : ['normal', 'validation'];

  const candidates = await db.query(
    `SELECT id, symbol, action, trade_mode, block_code, block_meta, amount_usdt
       FROM signals
      WHERE exchange = 'binance'
        AND status = 'executed'
        AND COALESCE(trade_mode, 'normal') = ANY($1::text[])
        AND COALESCE(block_code, '') IN ('order_pending_reconcile', 'partial_fill_pending')
      ORDER BY created_at ASC
      LIMIT $2`,
    [modeFilter, Math.max(1, Math.min(200, Number(limit || 40)))],
  );

  const results = [];
  for (const row of candidates) {
    const payload = buildBinancePendingReconcilePayload(row);
    if (!payload) {
      const rowMeta = parseSignalBlockMeta(row?.block_meta);
      const pendingMeta = rowMeta?.pendingReconcile && typeof rowMeta.pendingReconcile === 'object'
        ? rowMeta.pendingReconcile
        : null;
      if (pendingMeta?.followUpRequired === true && !pendingMeta?.orderId && !pendingMeta?.clientOrderId) {
        const reason = 'pending reconcile 키(orderId/clientOrderId) 누락 — 자동 정산 불가, 수동 정산 필요';
        await db.updateSignalBlock(row.id, {
          status: SIGNAL_STATUS.FAILED,
          reason: reason.slice(0, 180),
          code: 'manual_reconcile_required',
          meta: {
            exchange: 'binance',
            symbol: row.symbol,
            action: row.action,
            pendingReconcile: pendingMeta,
          },
        }).catch(() => {});
        if (!isSyntheticOrTestSignalContext({ signalId: row.id, reasoning: row.reasoning })) {
          await notifyError(`헤파이스토스 pending reconcile 수동 정산 필요 — ${row.symbol} ${row.action}`, reason).catch(() => {});
        }
        results.push({
          signalId: row.id,
          symbol: row.symbol,
          action: row.action,
          code: 'manual_reconcile_required',
          status: 'missing_order_keys',
          error: reason,
        });
      }
      continue;
    }
    if (!payload.followUpRequired) continue;
    try {
      const side = payload.action === ACTIONS.BUY ? 'buy' : 'sell';
      const order = await fetchOrderFn({
        symbol: payload.orderSymbol || payload.symbol,
        orderId: payload.orderId || null,
        clientOrderId: payload.clientOrderId || null,
        submittedAtMs: payload.submittedAtMs || null,
        side,
        allowAllOrdersFallback: true,
      }, payload.orderSymbol || payload.symbol);
      const status = String(order?.status || '').trim().toLowerCase() || 'unknown';
      const filledQty = Math.max(0, Number(order?.filled || 0));
      const expectedQty = Math.max(payload.expectedQty, Number(order?.amount || 0));
      const resolvedOrderId = extractExchangeOrderId(order) || payload.orderId || null;
      const resolvedClientOrderId = extractClientOrderId(order) || payload.clientOrderId || null;
      const appliedSnapshot = await getPendingReconcileAppliedSnapshot({
        signalId: payload.signalId,
        symbol: payload.symbol,
        side,
        orderId: resolvedOrderId,
        clientOrderId: resolvedClientOrderId,
      });
      const effectiveRecordedFilledQty = Math.max(payload.recordedFilledQty, Number(appliedSnapshot.appliedFilledQty || 0));
      const effectiveRecordedCost = Math.max(payload.recordedCost, Number(appliedSnapshot.appliedCost || 0));
      const effectivePayload = {
        ...payload,
        orderId: resolvedOrderId,
        clientOrderId: resolvedClientOrderId,
        recordedFilledQty: effectiveRecordedFilledQty,
        recordedCost: effectiveRecordedCost,
      };
      const rawPrice = Math.max(0, Number(order?.price || order?.average || 0));
      const rawCost = Math.max(0, Number(order?.cost || (filledQty * rawPrice)));
      const quoteNormalized = await normalizePendingReconcileOrderUnits({
        signalSymbol: payload.symbol,
        orderSymbol: payload.orderSymbol || payload.symbol,
        filledQty,
        price: rawPrice,
        cost: rawCost,
        pendingMeta: payload.pendingMeta,
        signalId: payload.signalId,
      });
      const price = quoteNormalized.convertedPrice;
      const cost = quoteNormalized.convertedCost;
      const orderStillOpen = await isOrderStillOpenFn(
        payload.orderSymbol || payload.symbol,
        resolvedOrderId,
        resolvedClientOrderId,
      );
      const state = resolveBinancePendingQueueState({
        status,
        filledQty,
        expectedQty,
        orderStillOpen,
      });
      const progress = computeBinancePendingRecordedProgress({
        exchangeFilledQty: filledQty,
        exchangeCost: cost,
        exchangePrice: price,
        recordedFilledQty: effectiveRecordedFilledQty,
        recordedCost: effectiveRecordedCost,
        applySucceeded: true,
      });

      let applyError = null;
      let applyResult = null;
      let applySucceeded = progress.deltaFilledQty <= BINANCE_PENDING_RECONCILE_EPSILON;
      if (progress.deltaFilledQty > BINANCE_PENDING_RECONCILE_EPSILON) {
        try {
          applyResult = await applyDeltaFn({
            payload: effectivePayload,
            deltaFilledQty: progress.deltaFilledQty,
            deltaCost: progress.deltaCost,
            orderPrice: price,
            stateCode: state.code,
          });
          applySucceeded = Boolean(applyResult?.applied);
        } catch (error) {
          applyError = error;
        }
      }

      const persistedProgress = computeBinancePendingRecordedProgress({
        exchangeFilledQty: filledQty,
        exchangeCost: cost,
        exchangePrice: price,
        recordedFilledQty: effectiveRecordedFilledQty,
        recordedCost: effectiveRecordedCost,
        applySucceeded: !applyError && applySucceeded,
      });
      let pendingState = null;
      try {
        pendingState = await markSignalFn(payload.signalId, {
          symbol: payload.symbol,
          action: payload.action,
          amountUsdt: payload.amountUsdt,
          tradeMode: applyResult?.tradeModeUsed || payload.tradeMode,
          paperMode: payload.paperMode,
          orderMeta: {
            orderId: resolvedOrderId,
            clientOrderId: resolvedClientOrderId,
            orderSymbol: payload.orderSymbol || payload.symbol,
            submittedAtMs: payload.submittedAtMs || null,
            status,
            amount: expectedQty,
            filled: filledQty,
            price,
            cost,
            rawPrice: quoteNormalized.rawPrice,
            rawCost: quoteNormalized.rawCost,
            quoteConversionApplied: quoteNormalized.conversionApplied,
            quoteConversionRate: quoteNormalized.conversionRate,
            quoteConversionPair: quoteNormalized.conversionPair,
            quoteAsset: quoteNormalized.orderQuote,
            signalQuoteAsset: quoteNormalized.signalQuote,
            btcReferencePrice: quoteNormalized.conversionRate,
          },
          existingRecordedFilledQty: effectiveRecordedFilledQty,
          existingRecordedCost: effectiveRecordedCost,
          appliedFilledQty: persistedProgress.appliedFilledQty,
          appliedCost: persistedProgress.appliedCost,
          reconcileError: applyError ? String(applyError?.message || applyError) : null,
          orderStillOpen,
          pendingMeta: payload.pendingMeta,
        });
      } catch (markError) {
        if (!applyError && persistedProgress.appliedFilledQty > BINANCE_PENDING_RECONCILE_EPSILON) {
          await notifyError(`헤파이스토스 pending reconcile meta 저장 실패 — ${payload.symbol} ${payload.action}`, markError).catch(() => {});
        }
        throw markError;
      }

      if (!applyError && progress.deltaFilledQty <= BINANCE_PENDING_RECONCILE_EPSILON && pendingState?.code === 'order_reconciled') {
        await syncPendingReconcileSnapshotState({
          payload: effectivePayload,
          tradeMode: applyResult?.tradeModeUsed || payload.tradeMode,
          stateCode: pendingState.code,
        }).catch(() => null);
      }

      results.push({
        signalId: payload.signalId,
        symbol: payload.symbol,
        orderSymbol: payload.orderSymbol || payload.symbol,
        action: payload.action,
        code: applyError
          ? 'reconcile_apply_failed'
          : (pendingState?.code || state.code),
        status,
        filledQty,
        appliedFilledQty: persistedProgress.appliedFilledQty,
        appliedCost: persistedProgress.appliedCost,
        queueStatus: pendingState?.queueStatus || null,
        error: applyError ? String(applyError?.message || applyError) : null,
      });

    } catch (error) {
      if (isPendingReconcileQuoteConversionError(error)) {
        const reason = `pending reconcile 단위 환산 불가 — 수동 정산 필요 (${String(error?.message || error).slice(0, 96)})`;
        await db.updateSignalBlock(payload.signalId, {
          status: SIGNAL_STATUS.FAILED,
          reason: reason.slice(0, 180),
          code: 'manual_reconcile_required',
          meta: {
            exchange: 'binance',
            symbol: payload.symbol,
            action: payload.action,
            orderId: payload.orderId || null,
            clientOrderId: payload.clientOrderId || null,
            orderSymbol: payload.orderSymbol || payload.symbol,
            pendingReconcile: payload.pendingMeta || null,
            conversionError: String(error?.message || error).slice(0, 240),
            ...(error?.meta || {}),
          },
        }).catch(() => {});
        if (!isSyntheticOrTestSignalContext({ signalId: payload.signalId, reasoning: payload.signal?.reasoning })) {
          await notifyError(`헤파이스토스 pending reconcile 수동 정산 필요 — ${payload.symbol} ${payload.action}`, reason).catch(() => {});
        }
        results.push({
          signalId: payload.signalId,
          symbol: payload.symbol,
          action: payload.action,
          code: 'manual_reconcile_required',
          status: 'quote_conversion_failed',
          error: String(error?.message || error),
        });
        if (delayMs > 0) await delay(delayMs);
        continue;
      }
      await db.mergeSignalBlockMeta(payload.signalId, {
        pendingReconcile: {
          ...payload.pendingMeta,
          exchange: 'binance',
          symbol: payload.symbol,
          orderSymbol: payload.orderSymbol || payload.symbol,
          action: payload.action,
          orderId: payload.orderId,
          clientOrderId: payload.clientOrderId || null,
          queueStatus: 'queued',
          followUpRequired: true,
          reconcileError: String(error?.message || error).slice(0, 240),
          updatedAt: new Date().toISOString(),
        },
      }).catch(() => {});
      results.push({
        signalId: payload.signalId,
        symbol: payload.symbol,
        action: payload.action,
        code: 'reconcile_fetch_failed',
        status: 'error',
        error: String(error?.message || error),
      });
    }
    if (delayMs > 0) await delay(delayMs);
  }

  const summary = {
    completed: results.filter((item) => item.code === 'order_reconciled').length,
    partial: results.filter((item) => item.code === 'partial_fill_pending').length,
    queued: results.filter((item) => item.code === 'order_pending_reconcile').length,
    failed: results.filter(
      (item) => item.code === 'reconcile_fetch_failed'
        || item.code === 'reconcile_apply_failed'
        || item.code === 'manual_reconcile_required',
    ).length,
  };

  return {
    candidates: candidates.length,
    processed: results.length,
    summary,
    results,
  };
}

export async function processBinancePendingJournalRepairQueue({
  tradeModes = [],
  limit = 40,
  delayMs = 120,
  deps = {},
} = {}) {
  const normalizedModes = Array.from(new Set(
    (Array.isArray(tradeModes) ? tradeModes : [])
      .map((mode) => String(mode || '').trim())
      .filter(Boolean),
  ));
  const modeFilter = normalizedModes.length > 0 ? normalizedModes : ['normal', 'validation'];
  const loadTradeFn = typeof deps?.loadTrade === 'function'
    ? deps.loadTrade
    : loadBinancePendingReconcileTrade;
  const ensureJournalFn = typeof deps?.ensureJournal === 'function'
    ? deps.ensureJournal
    : ensurePendingReconcileJournalRecorded;

  const candidates = await db.query(
    `SELECT id, symbol, action, trade_mode, block_code, block_meta, amount_usdt
       FROM signals
      WHERE exchange = 'binance'
        AND status = 'executed'
        AND COALESCE(trade_mode, 'normal') = ANY($1::text[])
        AND COALESCE(block_meta->'pendingReconcile'->'journalPending'->>'followUpRequired', 'false') = 'true'
      ORDER BY created_at ASC
      LIMIT $2`,
    [modeFilter, Math.max(1, Math.min(200, Number(limit || 40)))],
  );

  const results = [];
  for (const row of candidates) {
    const payload = buildBinancePendingReconcilePayload(row);
    if (!payload) continue;
    const journalPending = payload.pendingMeta?.journalPending && typeof payload.pendingMeta.journalPending === 'object'
      ? payload.pendingMeta.journalPending
      : {};
    if (journalPending.followUpRequired !== true) continue;
    const side = payload.action === ACTIONS.BUY ? 'buy' : 'sell';
    try {
      const trade = await loadTradeFn({
        signalId: payload.signalId,
        symbol: payload.symbol,
        side,
        tradeId: journalPending.tradeId || null,
        incidentLink: journalPending.incidentLink || null,
      });
      if (!trade) {
        const reason = 'journal_trade_not_found';
        await markBinancePendingReconcileJournalState(payload.signalId, {
          pendingMeta: payload.pendingMeta,
          trade: {
            id: journalPending.tradeId || null,
            symbol: payload.symbol,
            side,
            incidentLink: journalPending.incidentLink || null,
          },
          followUpRequired: true,
          queueStatus: 'queued',
          attemptIncrement: 1,
          lastError: reason,
          source: 'pending_reconcile_journal_repair',
        }).catch(() => {});
        results.push({
          signalId: payload.signalId,
          symbol: payload.symbol,
          action: payload.action,
          code: 'journal_repair_failed',
          reason,
        });
        continue;
      }

      const journalResult = await ensureJournalFn({
        trade,
        signalId: payload.signalId,
        pendingMeta: payload.pendingMeta,
        source: 'pending_reconcile_journal_repair',
        exitReason: 'order_pending_reconcile_delta',
      });
      results.push({
        signalId: payload.signalId,
        symbol: payload.symbol,
        action: payload.action,
        code: journalResult?.ok ? 'journal_repaired' : 'journal_repair_failed',
        reason: journalResult?.ok ? null : (journalResult?.reason || 'journal_repair_failed'),
      });
    } catch (error) {
      await markBinancePendingReconcileJournalState(payload.signalId, {
        pendingMeta: payload.pendingMeta,
        trade: {
          id: journalPending.tradeId || null,
          symbol: payload.symbol,
          side,
          incidentLink: journalPending.incidentLink || null,
        },
        followUpRequired: true,
        queueStatus: 'queued',
        attemptIncrement: 1,
        lastError: String(error?.message || error),
        source: 'pending_reconcile_journal_repair',
      }).catch(() => {});
      results.push({
        signalId: payload.signalId,
        symbol: payload.symbol,
        action: payload.action,
        code: 'journal_repair_failed',
        reason: String(error?.message || error),
      });
    }
    if (delayMs > 0) await delay(delayMs);
  }

  return {
    candidates: candidates.length,
    processed: results.length,
    summary: {
      repaired: results.filter((item) => item.code === 'journal_repaired').length,
      failed: results.filter((item) => item.code === 'journal_repair_failed').length,
    },
    results,
  };
}

async function cleanupDustLivePosition(symbol, position, tradeMode, meta = {}) {
  if (!position) return;
  await db.deletePosition(symbol, {
    exchange: position.exchange || 'binance',
    paper: false,
    tradeMode,
  });
  console.log(`  ⚠️ ${symbol} 실잔고 최소수량 미달 → DB 포지션 삭제 정리`);
  if (meta.signalId) {
    await db.updateSignalBlock(meta.signalId, {
      reason: `dust_position_cleaned:${meta.roundedAmount || 0}:${meta.minSellAmount || 0}`,
      code: 'dust_position_cleaned',
      meta: {
        exchange: position.exchange || 'binance',
        symbol,
        dbAmount: Number(position.amount || 0),
        freeBalance: Number(meta.freeBalance || 0),
        roundedAmount: Number(meta.roundedAmount || 0),
        minSellAmount: Number(meta.minSellAmount || 0),
      },
    }).catch(() => {});
  }
}

function roundSellAmount(symbol, amount) {
  try {
    const ex = getExchange();
    const precise = Number(ex.amountToPrecision(symbol, amount));
    return Number.isFinite(precise) ? precise : 0;
  } catch {
    return 0;
  }
}

function extractOrderId(orderLike) {
  if (!orderLike) return null;
  return extractExchangeOrderId(orderLike)
    ?? extractClientOrderId(orderLike)
    ?? null;
}

function toEpochMs(value = null) {
  if (value == null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function sanitizeClientOrderIdPart(value = '', fallback = 'x') {
  const text = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  if (!text) return fallback;
  return text;
}

function buildDeterministicClientOrderId({
  signalId = null,
  symbol = '',
  action = 'buy',
  scope = 'main',
} = {}) {
  const normalizedAction = String(action || 'buy').trim().toLowerCase() === 'sell' ? 's' : 'b';
  const symbolPart = sanitizeClientOrderIdPart(String(symbol || '').replace('/', ''), 'sym').slice(0, 8);
  const signalPart = sanitizeClientOrderIdPart(signalId || `sig${Date.now()}`, 'sig').slice(-12);
  const scopePart = sanitizeClientOrderIdPart(scope || 'main', 'main').slice(0, 8);
  const raw = `ln_${normalizedAction}_${scopePart}_${symbolPart}_${signalPart}`;
  return raw.slice(0, 36);
}

function extractOcoOrderIds(ocoResponse) {
  const reports = ocoResponse?.orderReports || ocoResponse?.info?.orderReports || [];
  const tpOrderId = reports?.[0]?.orderId?.toString?.() ?? ocoResponse?.orders?.[0]?.orderId?.toString?.() ?? null;
  const slOrderId = reports?.[1]?.orderId?.toString?.() ?? ocoResponse?.orders?.[1]?.orderId?.toString?.() ?? null;
  return { tpOrderId, slOrderId };
}

function getPriceStep(symbol) {
  try {
    const ex = getExchange();
    const market = ex.market(symbol);
    const rawPrecision = market?.precision?.price;
    if (typeof rawPrecision === 'number' && Number.isFinite(rawPrecision)) {
      return rawPrecision >= 1 ? (1 / (10 ** rawPrecision)) : rawPrecision;
    }
  } catch {
    // noop
  }
  return 0.00000001;
}

function normalizeProtectiveExitPrices(symbol, fillPrice, tpPrice, slPrice, source = 'fixed') {
  const ex = getExchange();
  const priceStep = getPriceStep(symbol);
  const fixedTpRaw = fillPrice * 1.06;
  const fixedSlRaw = fillPrice * 0.97;
  const requestedTp = Number(tpPrice || 0);
  const requestedSl = Number(slPrice || 0);
  const requestedValid = requestedTp > fillPrice && requestedSl > 0 && requestedSl < fillPrice;
  const baseTp = requestedValid ? requestedTp : fixedTpRaw;
  const baseSl = requestedValid ? requestedSl : fixedSlRaw;
  const normalizedTp = Number(ex.priceToPrecision(symbol, Math.max(baseTp, fillPrice + priceStep)));
  const normalizedSl = Number(ex.priceToPrecision(symbol, Math.max(priceStep, Math.min(baseSl, fillPrice - priceStep))));
  const normalizedSlLimit = Number(ex.priceToPrecision(symbol, Math.max(priceStep, normalizedSl - priceStep)));

  return {
    tpPrice: normalizedTp,
    slPrice: normalizedSl,
    slLimitPrice: normalizedSlLimit < normalizedSl ? normalizedSlLimit : Number(ex.priceToPrecision(symbol, Math.max(priceStep, normalizedSl * 0.999))),
    sourceUsed: requestedValid ? source : 'fixed_fallback',
    requestedValid,
  };
}

function safeFeatureValue(ex, symbol, method, feature) {
  try {
    if (typeof ex.featureValue === 'function') {
      return ex.featureValue(symbol, method, feature);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function getProtectiveExitCapabilities(ex, symbol) {
  const stopLossPrice = safeFeatureValue(ex, symbol, 'createOrder', 'stopLossPrice');
  const stopLoss = safeFeatureValue(ex, symbol, 'createOrder', 'stopLoss');
  const takeProfitPrice = safeFeatureValue(ex, symbol, 'createOrder', 'takeProfitPrice');
  const takeProfit = safeFeatureValue(ex, symbol, 'createOrder', 'takeProfit');

  return {
    rawOco: typeof ex.privatePostOrderOco === 'function',
    rawOrderListOco: typeof ex.privatePostOrderListOco === 'function',
    ccxtStopLossPrice: Boolean(stopLossPrice),
    ccxtStopLossObject: Boolean(stopLoss),
    ccxtTakeProfitPrice: Boolean(takeProfitPrice),
    ccxtTakeProfitObject: Boolean(takeProfit),
  };
}

async function fetchFreeAssetBalance(symbol) {
  const ex = getExchange();
  const base = String(symbol || '').split('/')[0];
  const balance = await ex.fetchBalance();
  return Number(balance.free?.[base] || 0);
}

async function fetchAssetBalances(symbol) {
  const ex = getExchange();
  const base = String(symbol || '').split('/')[0];
  const balance = await ex.fetchBalance();
  return {
    freeBalance: Number(balance?.free?.[base] || 0),
    totalBalance: Number(balance?.total?.[base] || balance?.free?.[base] || 0),
  };
}

async function cancelOpenSellOrdersForSymbol(symbol) {
  const ex = getExchange();
  if (typeof ex.fetchOpenOrders !== 'function') return { cancelledCount: 0 };

  const openOrders = await ex.fetchOpenOrders(symbol).catch(() => []);
  const sellOrders = (openOrders || []).filter((order) => String(order?.side || '').toLowerCase() === 'sell');
  let cancelledCount = 0;

  for (const order of sellOrders) {
    const orderId = extractOrderId(order);
    if (!orderId) continue;
    try {
      await ex.cancelOrder(orderId, symbol);
      cancelledCount += 1;
    } catch {
      // 이미 체결/취소된 주문은 무시
    }
  }

  return { cancelledCount };
}

function formatConvertAmount(amount, decimals = 12) {
  return Number(amount || 0).toFixed(decimals).replace(/0+$/u, '').replace(/\.$/u, '');
}

async function tryConvertResidualDustToUsdt(symbol, amount) {
  const ex = getExchange();
  const base = String(symbol || '').split('/')[0];
  const normalizedAmount = Number(amount || 0);
  if (!(normalizedAmount > 0.00000001)) return null;
  if (typeof ex.fetchConvertQuote !== 'function' || typeof ex.createConvertTrade !== 'function') return null;

  const convertAmount = formatConvertAmount(normalizedAmount);
  if (!convertAmount) return null;

  const quote = await ex.fetchConvertQuote(base, 'USDT', convertAmount);
  const quoteId = quote?.id || quote?.info?.quoteId;
  if (!quoteId) return null;

  const execution = await ex.createConvertTrade(quoteId, base, 'USDT', convertAmount);
  return {
    amount: normalizedAmount,
    toAmount: Number(execution?.toAmount || execution?.info?.toAmount || quote?.toAmount || 0),
    orderId: execution?.id || execution?.order || execution?.info?.orderId || quoteId,
  };
}

async function placeBinanceProtectiveExit(symbol, amount, fillPrice, tpPrice, slPrice) {
  const ex = getExchange();
  const marketId = symbol.replace('/', '');
  const requestedAmount = Number(amount || 0);
  const freeBalance = await fetchFreeAssetBalance(symbol).catch(() => 0);
  const effectiveAmount = freeBalance > 0 ? Math.min(requestedAmount, freeBalance) : requestedAmount;
  const quantity = ex.amountToPrecision(symbol, effectiveAmount);
  const normalizedPrices = normalizeProtectiveExitPrices(symbol, Number(fillPrice || 0), tpPrice, slPrice, 'provided');
  const tp = ex.priceToPrecision(symbol, normalizedPrices.tpPrice);
  const sl = ex.priceToPrecision(symbol, normalizedPrices.slPrice);
  const slLimit = ex.priceToPrecision(symbol, normalizedPrices.slLimitPrice);
  const errors = [];
  const capabilities = getProtectiveExitCapabilities(ex, symbol);
  const normalizedAmount = Number(quantity || 0);

  if (normalizedAmount <= 0) {
    return {
      ok: false,
      mode: 'failed',
      tpOrderId: null,
      slOrderId: null,
      requestedAmount,
      freeBalance,
      effectiveAmount,
      error: `protective_exit_zero_quantity | requested=${requestedAmount} | free=${freeBalance}`,
    };
  }

  if (capabilities.rawOco) {
    try {
      const response = await ex.privatePostOrderOco({
        symbol: marketId,
        side: 'SELL',
        quantity,
        price: tp,
        stopPrice: sl,
        stopLimitPrice: slLimit,
        stopLimitTimeInForce: 'GTC',
      });
      return {
        ok: true,
        mode: 'oco',
        requestedAmount,
        freeBalance,
        effectiveAmount: normalizedAmount,
        reconciled: freeBalance > 0 && freeBalance < requestedAmount,
        ...extractOcoOrderIds(response),
      };
    } catch (error) {
      errors.push(`privatePostOrderOco:${error.message}`);
    }
  }

  if (capabilities.rawOrderListOco) {
    try {
      const response = await ex.privatePostOrderListOco({
        symbol: marketId,
        side: 'SELL',
        quantity,
        aboveType: 'LIMIT_MAKER',
        abovePrice: tp,
        belowType: 'STOP_LOSS_LIMIT',
        belowStopPrice: sl,
        belowPrice: slLimit,
        belowTimeInForce: 'GTC',
      });
      return {
        ok: true,
        mode: 'oco_list',
        requestedAmount,
        freeBalance,
        effectiveAmount: normalizedAmount,
        reconciled: freeBalance > 0 && freeBalance < requestedAmount,
        ...extractOcoOrderIds(response),
      };
    } catch (error) {
      errors.push(`privatePostOrderListOco:${error.message}`);
    }
  }

  if (capabilities.ccxtStopLossPrice) {
    try {
      const stopOrder = await ex.createOrder(symbol, 'limit', 'sell', quantity, slLimit, {
        stopLossPrice: sl,
        timeInForce: 'GTC',
      });
      return {
        ok: false,
        mode: 'ccxt_stop_loss_only',
        tpOrderId: null,
        slOrderId: extractOrderId(stopOrder),
        requestedAmount,
        freeBalance,
        effectiveAmount: normalizedAmount,
        reconciled: freeBalance > 0 && freeBalance < requestedAmount,
        error: errors.join(' | ') || null,
      };
    } catch (error) {
      errors.push(`ccxtStopLossPrice:${error.message}`);
    }
  }

  try {
    const stopOrder = await ex.createOrder(symbol, 'stop_loss_limit', 'sell', quantity, slLimit, {
      stopPrice: sl,
      timeInForce: 'GTC',
    });
    return {
      ok: false,
      mode: 'exchange_stop_loss_only',
      tpOrderId: null,
      slOrderId: extractOrderId(stopOrder),
      requestedAmount,
      freeBalance,
      effectiveAmount: normalizedAmount,
      reconciled: freeBalance > 0 && freeBalance < requestedAmount,
      error: errors.join(' | ') || null,
    };
  } catch (error) {
    errors.push(`stop_loss_only:${error.message}`);
  }

  return {
    ok: false,
    mode: 'failed',
    tpOrderId: null,
    slOrderId: null,
    requestedAmount,
    freeBalance,
    effectiveAmount: normalizedAmount,
    reconciled: freeBalance > 0 && freeBalance < requestedAmount,
    error: `${errors.join(' | ')} | capabilities:${JSON.stringify(capabilities)} | requested=${requestedAmount} | free=${freeBalance} | qty=${quantity}`,
  };
}

function isCapitalShortageReason(reason = '') {
  return reason.includes('잔고 부족') || reason.includes('현금 보유 부족');
}

function buildProtectionSnapshot(protection = null, fallbackError = null) {
  const errorText = protection?.error || fallbackError || null;
  return {
    tpSlSet: Boolean(protection?.ok),
    tpOrderId: protection?.tpOrderId ?? null,
    slOrderId: protection?.slOrderId ?? null,
    tpSlMode: protection?.mode ?? null,
    tpSlError: errorText ? String(errorText).slice(0, 240) : null,
  };
}

function isStopLossOnlyMode(mode = null) {
  return mode === 'stop_loss_only'
    || mode === 'ccxt_stop_loss_only'
    || mode === 'exchange_stop_loss_only';
}

function normalizePartialExitRatio(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  if (parsed >= 1) return 1;
  return Number(parsed.toFixed(4));
}

function isEffectivePartialExit({
  entrySize = 0,
  soldAmount = 0,
  partialExitRatio = null,
}) {
  const normalizedEntrySize = Number(entrySize || 0);
  const normalizedSoldAmount = Math.max(0, Number(soldAmount || 0));
  const normalizedRatio = normalizePartialExitRatio(partialExitRatio);
  const remainingSize = Math.max(0, normalizedEntrySize - normalizedSoldAmount);
  return normalizedEntrySize > 0
    && remainingSize > 0.00000001
    && (
      normalizedRatio < 1
      || normalizedSoldAmount < (normalizedEntrySize - 0.00000001)
    );
}

function buildSignalQualityContext(signal = null) {
  const isReconciledExecution = signal?.block_code === 'position_balance_reconciled';
  const baseExecutionOrigin = signal?.execution_origin || signal?.executionOrigin || 'strategy';
  const baseQualityFlag = signal?.quality_flag || signal?.qualityFlag || 'trusted';
  const baseExclude = Boolean(signal?.exclude_from_learning ?? signal?.excludeFromLearning ?? false);
  const baseIncident = signal?.incident_link || signal?.incidentLink || null;

  return {
    executionOrigin: isReconciledExecution ? 'reconciliation' : baseExecutionOrigin,
    qualityFlag: isReconciledExecution
      ? (baseQualityFlag === 'exclude_from_learning' ? baseQualityFlag : 'degraded')
      : baseQualityFlag,
    excludeFromLearning: isReconciledExecution ? true : baseExclude,
    incidentLink: isReconciledExecution ? (baseIncident || 'position_balance_reconciled') : baseIncident,
  };
}

async function syncCryptoStrategyExecutionState({
  symbol,
  tradeMode = 'normal',
  lifecycleStatus,
  recommendation = null,
  reasonCode = null,
  reason = null,
  trade = null,
  partialExitRatio = null,
  executionMission = null,
  riskMission = null,
  watchMission = null,
  updatedBy = 'hephaestos_execute',
} = {}) {
  if (!symbol || !lifecycleStatus) return null;
  const timestamp = new Date().toISOString();
  return db.updatePositionStrategyProfileState(symbol, {
    exchange: 'binance',
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
      latestPartialExitRatio: partialExitRatio,
      latestExecutionMission: executionMission || null,
      latestRiskMission: riskMission || null,
      latestWatchMission: watchMission || null,
      updatedBy,
      updatedAt: timestamp,
    },
    lastEvaluationAt: timestamp,
    lastAttentionAt: timestamp,
  }).catch(() => null);
}

async function reconcileOpenJournalToTrackedAmount(symbol, isPaper, trackedAmount, tradeMode = null) {
  const effectiveTradeMode = tradeMode || getInvestmentTradeMode();
  const openEntries = await journalDb.getOpenJournalEntries('crypto');
  const entry = openEntries.find((e) =>
    e.symbol === symbol
      && Boolean(e.is_paper) === Boolean(isPaper)
      && (e.trade_mode || 'normal') === effectiveTradeMode
  );
  if (!entry) return null;

  const entrySize = Number(entry.entry_size || 0);
  const nextSize = Math.max(0, Number(trackedAmount || 0));
  if (!(entrySize > 0) || !(nextSize > 0) || nextSize >= entrySize) return null;

  const entryValue = Number(entry.entry_value || 0);
  const nextEntryValue = entrySize > 0
    ? entryValue * (nextSize / entrySize)
    : entryValue;

  await db.run(
    `UPDATE trade_journal
     SET entry_size = $1,
         entry_value = $2
     WHERE trade_id = $3`,
    [nextSize, nextEntryValue, entry.trade_id],
  );

  return {
    tradeId: entry.trade_id,
    fromSize: entrySize,
    toSize: nextSize,
    fromEntryValue: entryValue,
    toEntryValue: nextEntryValue,
  };
}

async function closeOpenJournalForSymbol(
  symbol,
  isPaper,
  exitPrice,
  exitValue,
  exitReason,
  tradeMode = null,
  {
    executionOrigin = null,
    qualityFlag = null,
    excludeFromLearning = null,
    incidentLink = null,
  } = {},
) {
  const openEntries = await journalDb.getOpenJournalEntries('crypto');
  const effectiveTradeMode = tradeMode || getInvestmentTradeMode();
  const entry = openEntries.find(e =>
    e.symbol === symbol
      && Boolean(e.is_paper) === Boolean(isPaper)
      && (e.trade_mode || 'normal') === effectiveTradeMode
  );
  if (!entry) return;

  const pnlAmount  = (exitValue || 0) - (entry.entry_value || 0);
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
  const weekly = await db.get(`
    SELECT
      COALESCE(SUM(pnl_net), 0) AS pnl,
      COUNT(*) AS total_trades,
      COUNT(*) FILTER (WHERE pnl_net > 0) AS wins
    FROM trade_journal
    WHERE exchange = 'binance'
      AND status = 'closed'
      AND exit_time IS NOT NULL
      AND exit_time >= ?
  `, [Date.now() - 7 * 24 * 60 * 60 * 1000]).catch(() => null);
  const settledAt = Date.now();
  const holdHours = entry.entry_time ? Math.max(0, ((settledAt - Number(entry.entry_time)) / 3600000)) : null;
  await notifySettlement({
    symbol,
    side: 'buy',
    market: 'crypto',
    exchange: 'binance',
    tradeMode: tradeMode || getInvestmentTradeMode(),
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

async function settleOpenJournalForSell(
  symbol,
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
  const openEntries = await journalDb.getOpenJournalEntries('crypto');
  const effectiveTradeMode = tradeMode || getInvestmentTradeMode();
  const entry = openEntries.find((e) =>
    e.symbol === symbol
      && Boolean(e.is_paper) === Boolean(isPaper)
      && (e.trade_mode || 'normal') === effectiveTradeMode
  );
  if (!entry) return { partial: false, updated: false };

  const normalizedRatio = normalizePartialExitRatio(partialExitRatio);
  const entrySize = Number(entry.entry_size || 0);
  const entryValue = Number(entry.entry_value || 0);
  const realizedSize = Math.min(entrySize, Math.max(0, Number(soldAmount || 0)));
  const isPartial = isEffectivePartialExit({
    entrySize,
    soldAmount: realizedSize,
    partialExitRatio: normalizedRatio,
  });

  if (!isPartial) {
    await closeOpenJournalForSymbol(symbol, isPaper, exitPrice, exitValue, exitReason, effectiveTradeMode, {
      executionOrigin,
      qualityFlag,
      excludeFromLearning,
      incidentLink,
    });
    return { partial: false, updated: true };
  }

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
    tp_order_id: entry.tp_order_id ?? null,
    sl_order_id: entry.sl_order_id ?? null,
    tp_sl_set: entry.tp_sl_set ?? false,
    tp_sl_mode: entry.tp_sl_mode ?? null,
    tp_sl_error: entry.tp_sl_error ?? null,
    market_regime: entry.market_regime ?? null,
    market_regime_confidence: entry.market_regime_confidence ?? null,
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

  await db.run(
    `UPDATE trade_journal
     SET entry_size = $1,
         entry_value = $2
     WHERE trade_id = $3`,
    [remainingSize, remainingEntryValue, entry.trade_id],
  );

  await journalDb.ensureAutoReview(partialTradeId).catch(() => {});
  return {
    partial: true,
    updated: true,
    realizedTradeId: partialTradeId,
    remainingSize,
    remainingEntryValue,
  };
}

async function findAnyLivePosition(symbol, exchange = 'binance') {
  return db.getPosition(symbol, { exchange, paper: false });
}

async function preparePendingSignalProcessing() {
  await initHubSecrets().catch(() => false);
  const tradeMode = getInvestmentTradeMode();
  const tradeModes = Array.from(new Set([tradeMode, 'normal', 'validation'].filter(Boolean)));
  const pendingReconcileResult = await processBinancePendingReconcileQueue({
    tradeModes,
    limit: 60,
    delayMs: 120,
  }).catch((error) => {
    console.warn(`[헤파이스토스] pending reconcile 정산 실패: ${error.message}`);
    return { candidates: 0, processed: 0, summary: null, results: [] };
  });
  const pendingJournalResult = await processBinancePendingJournalRepairQueue({
    tradeModes,
    limit: 60,
    delayMs: 80,
  }).catch((error) => {
    console.warn(`[헤파이스토스] pending reconcile journal 보강 실패: ${error.message}`);
    return { candidates: 0, processed: 0, summary: null, results: [] };
  });
  const syncResult = await syncPositionsAtMarketOpen('crypto').catch((error) => ({
    ok: false,
    reason: error?.message || String(error),
    mismatchCount: 0,
    mismatches: [],
  }));
  const stalePending = [];
  for (const mode of tradeModes) {
    const rows = await cleanupStalePendingSignals({
      exchange: 'binance',
      tradeMode: mode,
    }).catch((error) => {
      console.warn(`[헤파이스토스] stale pending 정리 실패 (${mode}): ${error.message}`);
      return [];
    });
    stalePending.push(...rows);
  }
  const reconciled = await reconcileLivePositionsWithBrokerBalance().catch((error) => {
    console.warn(`[헤파이스토스] 실지갑 포지션 동기화 실패: ${error.message}`);
    return [];
  });
  if (!syncResult.skipped && !syncResult.ok) {
    console.warn(`[헤파이스토스] 브로커↔DB 포지션 복구 실패: ${syncResult.reason}`);
  }
  if (syncResult.ok && Number(syncResult.mismatchCount || 0) > 0) {
    console.log(`[헤파이스토스] 브로커↔DB 포지션 복구 ${syncResult.mismatchCount}건`);
  }
  if (stalePending.length > 0) {
    console.log(`[헤파이스토스] stale pending 정리 ${stalePending.length}건 (modes=${tradeModes.join(',')})`);
  }
  if (Number(pendingReconcileResult.processed || 0) > 0) {
    const summary = pendingReconcileResult.summary || {};
    console.log(
      `[헤파이스토스] pending reconcile ${pendingReconcileResult.processed}건 `
      + `(완료 ${Number(summary.completed || 0)} / 부분 ${Number(summary.partial || 0)} / 대기 ${Number(summary.queued || 0)} / 실패 ${Number(summary.failed || 0)})`,
    );
  }
  if (Number(pendingJournalResult.processed || 0) > 0) {
    const summary = pendingJournalResult.summary || {};
    console.log(
      `[헤파이스토스] pending journal 보강 ${pendingJournalResult.processed}건 `
      + `(복구 ${Number(summary.repaired || 0)} / 실패 ${Number(summary.failed || 0)})`,
    );
  }
  if (reconciled.length > 0) {
    console.log(`[헤파이스토스] 실지갑 포지션 동기화 ${reconciled.length}건`);
  }
  return {
    tradeMode,
    tradeModes,
    reconciled,
    stalePending,
    pendingReconcileResult,
    pendingJournalResult,
  };
}

async function cleanupStalePendingSignals({
  exchange = 'binance',
  tradeMode = 'normal',
} = {}) {
  const executionConfig = getInvestmentExecutionRuntimeConfig();
  const stalePendingMinutes = Number(executionConfig?.pendingQueue?.stalePendingMinutes ?? 30);
  const safeMinutes = Number.isFinite(stalePendingMinutes) && stalePendingMinutes > 0
    ? Math.round(stalePendingMinutes)
    : 30;

  const staleRows = await db.query(
    `SELECT id, symbol, action, created_at, confidence, amount_usdt
       FROM signals
      WHERE exchange = $1
        AND status = 'pending'
        AND COALESCE(trade_mode, 'normal') = $2
        AND COALESCE(nemesis_verdict, '') = ''
        AND created_at < now() - make_interval(mins => $3)
      ORDER BY created_at ASC`,
    [exchange, tradeMode, safeMinutes],
  );

  for (const row of staleRows) {
    const ageMinutes = Math.max(0, Math.round((Date.now() - new Date(row.created_at).getTime()) / 60000));
    await db.updateSignalBlock(row.id, {
      status: SIGNAL_STATUS.FAILED,
      reason: `nemesis verdict 없이 ${ageMinutes}분 경과 (stale pending)`,
      code: 'stale_pending_signal',
      meta: {
        exchange,
        symbol: row.symbol,
        action: row.action,
        tradeMode,
        stalePendingMinutes: safeMinutes,
        ageMinutes,
        confidence: Number(row.confidence || 0),
        amountUsdt: Number(row.amount_usdt || 0),
        execution_blocked_by: 'approval_gate',
      },
    });
  }

  return staleRows;
}

async function runPendingSignalBatch(signals, { tradeMode, delayMs = 500 } = {}) {
  if (signals.length === 0) {
    console.log(`[헤파이스토스] 대기 신호 없음 (trade_mode=${tradeMode})`);
    return [];
  }

  console.log(`[헤파이스토스] ${signals.length}개 신호 처리 시작 (trade_mode=${tradeMode})`);
  const results = [];
  for (const signal of signals) {
    results.push(await executeSignal(signal));
    await delay(delayMs);
  }
  return results;
}

async function tryAbsorbUntrackedBalance({
  signalId,
  symbol,
  base,
  signalTradeMode,
  minOrderUsdt,
  effectivePaperMode,
}) {
  try {
    const walletBal = await getExchange().fetchBalance();
    const walletFree = walletBal.free?.[base] || 0;
    const trackedPos = await db.getLivePosition(symbol, null, signalTradeMode);
    const trackedAmt = trackedPos?.amount || 0;
    const untracked = walletFree - trackedAmt;
    if (!(untracked > 0)) return null;

    const curPrice = await fetchTicker(symbol).catch(() => 0);
    const untrackedUsd = untracked * curPrice;
    if (untrackedUsd < minOrderUsdt) {
      console.log(`  ℹ️ 미추적 ${base} ${untracked.toFixed(6)} (≈$${untrackedUsd.toFixed(2)}) — 최소금액 미만, 무시`);
      return null;
    }

    console.log(`  ✅ [헤파이스토스] 미추적 ${base} 흡수: ${untracked.toFixed(6)} (≈$${untrackedUsd.toFixed(2)}) → 포지션 등록 + TP/SL 설정`);

    const newAmount = trackedAmt + untracked;
    const newAvgPrice = trackedPos && trackedAmt > 0
      ? ((trackedAmt * trackedPos.avg_price) + untrackedUsd) / newAmount
      : curPrice;
    await db.upsertPosition({ symbol, amount: newAmount, avgPrice: newAvgPrice, unrealizedPnl: 0, paper: effectivePaperMode });

    const normalizedProtection = normalizeProtectiveExitPrices(symbol, curPrice, curPrice * 1.06, curPrice * 0.97, 'fixed');
    const tpPrice = normalizedProtection.tpPrice;
    const slPrice = normalizedProtection.slPrice;
    let protectionSnapshot = buildProtectionSnapshot();
    if (!effectivePaperMode && curPrice > 0) {
      try {
        const protection = await placeBinanceProtectiveExit(symbol, untracked, curPrice, tpPrice, slPrice);
        protectionSnapshot = buildProtectionSnapshot(protection);
        if (protection.ok) {
          console.log(`  🛡️ TP/SL OCO 설정 완료: TP=${tpPrice} SL=${slPrice}`);
        } else if (isStopLossOnlyMode(protection.mode)) {
          console.warn(`  ⚠️ TP/SL OCO 미지원 → SL-only 보호주문 설정: SL=${slPrice}`);
        } else {
          throw new Error(protection.error || 'protective_exit_failed');
        }
      } catch (tpslErr) {
        protectionSnapshot = buildProtectionSnapshot(null, tpslErr.message);
        console.warn(`  ⚠️ TP/SL 설정 실패: ${tpslErr.message}`);
      }
    }

    const paperTag = effectivePaperMode ? ' [PAPER]' : '';
    notifyTrade({
      signalId,
      symbol,
      side: 'absorb',
      amount: untracked,
      price: curPrice,
      totalUsdt: untrackedUsd,
      paper: effectivePaperMode,
      exchange: 'binance',
      tpPrice,
      slPrice,
      ...protectionSnapshot,
      memo: `미추적 잔고 흡수 — 봇 외부 매수 코인 포지션 등록${paperTag}`,
    }).catch(() => {});

    await db.updateSignalStatus(signalId, SIGNAL_STATUS.EXECUTED);
    return { success: true, absorbed: true, amount: untracked, price: curPrice };
  } catch (error) {
    console.warn(`  ⚠️ 미추적 잔고 흡수 실패 (일반 매수 계속): ${error.message}`);
    return null;
  }
}

async function checkBuyReentryGuards({
  persistFailure,
  symbol,
  action,
  signalTradeMode,
  effectivePaperMode,
}) {
  const livePosition = await db.getLivePosition(symbol, 'binance', signalTradeMode);
  const fallbackLivePosition = !livePosition
    ? await findAnyLivePosition(symbol, 'binance').catch(() => null)
    : null;
  const paperPosition = await db.getPaperPosition(symbol, 'binance', signalTradeMode);
  const sameDayBuyTrade = isSameDaySymbolReentryBlockEnabled()
    ? await db.getSameDayTrade({ symbol, side: 'buy', exchange: 'binance', tradeMode: signalTradeMode })
    : null;

  if (effectivePaperMode && livePosition) {
    const reason = '실포지션 보유 중에는 PAPER 추가매수로 혼합 포지션을 만들 수 없음';
    console.log(`  ⛔ [자본관리] ${reason}`);
    return rejectExecution({
      persistFailure,
      symbol,
      action,
      reason,
      code: 'position_mode_conflict',
      meta: {
        existingPaper: livePosition.paper,
        requestedPaper: effectivePaperMode,
      },
      notify: 'skip',
    });
  }
  if (effectivePaperMode && paperPosition) {
    const reason = `동일 ${signalTradeMode.toUpperCase()} PAPER 포지션 보유 중 — 추가매수 차단`;
    console.log(`  ⛔ [자본관리] ${reason}`);
    return rejectExecution({
      persistFailure,
      symbol,
      action,
      reason,
      code: 'paper_position_reentry_blocked',
      meta: {
        existingPaper: paperPosition.paper,
        requestedPaper: effectivePaperMode,
        tradeMode: signalTradeMode,
      },
      notify: 'skip',
    });
  }
  if (!effectivePaperMode && livePosition) {
    const validationLiveReentrySoftening = getValidationLiveReentrySofteningPolicy();
    const reentryReductionMultiplier = Number(validationLiveReentrySoftening?.reductionMultiplier || 0);
    if (
      signalTradeMode === 'validation'
      && validationLiveReentrySoftening?.enabled !== false
      && reentryReductionMultiplier > 0
      && reentryReductionMultiplier < 1
    ) {
      console.log(
        `  ⚖️ [가드 완화] ${symbol} validation 기존 LIVE 포지션 존재 → 감산 허용 x${reentryReductionMultiplier.toFixed(2)}`
      );
      return {
        livePosition,
        fallbackLivePosition,
        paperPosition,
        softGuardApplied: true,
        reducedAmountMultiplier: reentryReductionMultiplier,
        softGuards: [
          {
            kind: 'validation_live_reentry_softened',
            exchange: 'binance',
            tradeMode: signalTradeMode,
            reductionMultiplier: reentryReductionMultiplier,
            originReason: '동일 LIVE 포지션 보유 중 — validation 추가매수 감산 허용',
          },
        ],
      };
    }
    const reason = '동일 LIVE 포지션 보유 중 — 추가매수 차단';
    console.log(`  ⛔ [자본관리] ${reason}`);
    return rejectExecution({
      persistFailure,
      symbol,
      action,
      reason,
      code: 'live_position_reentry_blocked',
      meta: buildGuardTelemetryMeta(symbol, action, signalTradeMode, {
        existingPaper: livePosition.paper,
        requestedPaper: effectivePaperMode,
      }, {
        guardKind: 'validation_live_overlap',
        pressureSource: 'live_position_overlap',
      }),
      notify: 'skip',
    });
  }
  if (!livePosition && !paperPosition && sameDayBuyTrade) {
    const reason = `동일 ${signalTradeMode.toUpperCase()} 심볼 당일 재진입 차단`;
    console.log(`  ⛔ [자본관리] ${reason}`);
    return rejectExecution({
      persistFailure,
      symbol,
      action,
      reason,
      code: 'same_day_reentry_blocked',
      meta: {
        tradeMode: signalTradeMode,
        sameDayTradeId: sameDayBuyTrade.id,
        sameDayTradePaper: sameDayBuyTrade.paper === true,
      },
      notify: 'skip',
    });
  }

  return { livePosition, fallbackLivePosition, paperPosition };
}

async function persistBuyPosition({ symbol, order, effectivePaperMode, signalTradeMode }) {
  let managedAmount = Number(order.filled || 0);
  let managedAvgPrice = Number(order.price || 0);

  if (!effectivePaperMode) {
    try {
      const [walletBalances, liveLegRows] = await Promise.all([
        fetchAssetBalances(symbol).catch(() => null),
        db.query(
          `SELECT amount, avg_price, COALESCE(trade_mode, 'normal') AS trade_mode
             FROM investment.positions
            WHERE exchange = 'binance'
              AND paper = false
              AND symbol = $1
              AND amount > 0`,
          [symbol],
        ).catch(() => []),
      ]);

      const walletTotal = Number(walletBalances?.totalBalance || 0);
      const trackedAmount = liveLegRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
      const trackedValue = liveLegRows.reduce((sum, row) => sum + (Number(row.amount || 0) * Number(row.avg_price || 0)), 0);

      const baselineManagedAmount = trackedAmount + Number(order.filled || 0);
      const residualDustAmount = Math.max(0, walletTotal - baselineManagedAmount);
      managedAmount = Math.max(baselineManagedAmount, walletTotal, Number(order.filled || 0));

      if (managedAmount > 0) {
        const weightedValue = trackedValue + (Number(order.filled || 0) * Number(order.price || 0)) + (residualDustAmount * Number(order.price || 0));
        managedAvgPrice = weightedValue > 0 ? (weightedValue / managedAmount) : Number(order.price || 0);
      }

      if (residualDustAmount > 0.0000001) {
        console.log(`  🧹 ${symbol} 신규 관리 포지션에 dust ${residualDustAmount.toFixed(8)} 추가 흡수`);
      }
    } catch (error) {
      console.warn(`  ⚠️ ${symbol} dust 흡수형 포지션 저장 보정 실패: ${error.message}`);
    }
  }

  await db.upsertPosition({
    symbol,
    amount: managedAmount,
    avgPrice: managedAvgPrice,
    unrealizedPnl: 0,
    paper: effectivePaperMode,
    exchange: 'binance',
    tradeMode: signalTradeMode,
  });
}

async function applyBuyProtectiveExit({ trade, signal, order, effectivePaperMode, symbol }) {
  const fillPrice = order.price || order.average || 0;
  if (!(fillPrice > 0 && order.filled > 0)) return;

  const hasDynamic = !!(signal.tpPrice && signal.slPrice);
  trade.tpPrice = hasDynamic
    ? parseFloat(signal.tpPrice.toFixed(2))
    : parseFloat((fillPrice * 1.06).toFixed(2));
  trade.slPrice = hasDynamic
    ? parseFloat(signal.slPrice.toFixed(2))
    : parseFloat((fillPrice * 0.97).toFixed(2));
  trade.tpslSource = hasDynamic ? (signal.tpslSource || 'atr') : 'fixed';
  const tpslTag = hasDynamic ? '[동적 TP/SL]' : '[고정 TP/SL]';
  console.log(`  📐 ${tpslTag} TP=${trade.tpPrice} SL=${trade.slPrice} (${trade.tpslSource})`);

  if (effectivePaperMode) return;

  try {
    const normalizedProtection = normalizeProtectiveExitPrices(symbol, fillPrice, trade.tpPrice, trade.slPrice, trade.tpslSource);
    trade.tpPrice = normalizedProtection.tpPrice;
    trade.slPrice = normalizedProtection.slPrice;
    if (normalizedProtection.sourceUsed !== trade.tpslSource) {
      trade.tpslSource = normalizedProtection.sourceUsed;
    }
    const protection = await placeBinanceProtectiveExit(symbol, order.filled, fillPrice, trade.tpPrice, trade.slPrice);
    Object.assign(trade, buildProtectionSnapshot(protection));
    if (protection.ok) {
      console.log(`  🛡️ TP/SL OCO 설정 완료: TP=${trade.tpPrice} SL=${trade.slPrice}`);
    } else if (isStopLossOnlyMode(protection.mode)) {
      console.warn(`  ⚠️ TP/SL OCO 미지원 → SL-only 보호주문 설정: SL=${trade.slPrice}`);
    } else {
      throw new Error(protection.error || 'protective_exit_failed');
    }
  } catch (tpslErr) {
    console.error(`  ⚠️ TP/SL 설정 실패: ${tpslErr.message}`);
    Object.assign(trade, buildProtectionSnapshot(null, tpslErr.message));
    await notifyError(`헤파이스토스 TP/SL 설정 실패 — ${symbol}`, tpslErr);
  }
}

async function notifyExecutedTrade({ trade, signalTradeMode, capitalPolicy }) {
  const [curBalance, curPositions, curDailyPnl] = await Promise.all([
    getAvailableBalance().catch(() => null),
    getOpenPositions('binance', false, signalTradeMode).catch(() => []),
    getDailyPnL(trade.exchange || 'binance', signalTradeMode).catch(() => null),
  ]);

  await notifyTrade({
    ...trade,
    tradeMode: signalTradeMode,
    capitalInfo: {
      balance: curBalance,
      openPositions: curPositions.length,
      maxPositions: capitalPolicy.max_concurrent_positions,
      dailyPnL: curDailyPnl,
    },
  });
}

async function recordExecutedTradeJournal({ trade, signalId, exitReason }) {
  if (trade.side === 'buy') {
    const execTime = Date.now();
    const tradeId = await journalDb.generateTradeId();
    const signal = signalId ? await db.getSignalById(signalId).catch(() => null) : null;
    const executionOrigin = trade.executionOrigin || 'strategy';
    const excludeFromLearning = Boolean(trade.excludeFromLearning ?? false);
    await journalDb.insertJournalEntry({
      trade_id: tradeId,
      signal_id: signalId,
      market: 'crypto',
      exchange: trade.exchange,
      symbol: trade.symbol,
      is_paper: trade.paper,
      entry_time: execTime,
      entry_price: trade.price || 0,
      entry_size: trade.amount || 0,
      entry_value: trade.totalUsdt || 0,
      direction: 'long',
      tp_price: trade.tpPrice ?? null,
      sl_price: trade.slPrice ?? null,
      tp_order_id: trade.tpOrderId ?? null,
      sl_order_id: trade.slOrderId ?? null,
      tp_sl_set: trade.tpSlSet ?? false,
      tp_sl_mode: trade.tpSlMode ?? null,
      tp_sl_error: trade.tpSlError ?? null,
      strategy_family: signal?.strategy_family || null,
      strategy_quality: signal?.strategy_quality || null,
      strategy_readiness: signal?.strategy_readiness ?? null,
      strategy_route: signal?.strategy_route || null,
      execution_origin: executionOrigin,
      quality_flag: trade.qualityFlag || 'trusted',
      exclude_from_learning: excludeFromLearning,
      incident_link: trade.incidentLink || null,
    });
    await journalDb.linkRationaleToTrade(tradeId, signalId);
    const suppressUserFacingAlert = excludeFromLearning
      && ['reconciliation', 'cleanup'].includes(String(executionOrigin || '').toLowerCase());
    if (!suppressUserFacingAlert) {
      notifyJournalEntry({
        tradeId,
        symbol: trade.symbol,
        direction: 'long',
        market: 'crypto',
        entryPrice: trade.price,
        entryValue: trade.totalUsdt,
        isPaper: trade.paper,
        tpPrice: trade.tpPrice,
        slPrice: trade.slPrice,
        tpSlSet: trade.tpSlSet,
      });
    }
    return;
  }

  if (trade.side === 'sell') {
    await settleOpenJournalForSell(
      trade.symbol,
      trade.paper,
      trade.price,
      trade.totalUsdt,
      exitReason || 'signal_reverse',
      trade.tradeMode,
      {
        partialExitRatio: trade.partialExitRatio,
        soldAmount: trade.amount,
        signalId,
        executionOrigin: trade.executionOrigin || 'strategy',
        qualityFlag: trade.qualityFlag || 'trusted',
        excludeFromLearning: Boolean(trade.excludeFromLearning ?? false),
        incidentLink: trade.incidentLink || null,
      },
    );
  }
}

async function finalizeExecutedTrade({
  trade,
  signalId,
  signalTradeMode,
  capitalPolicy,
  exitReason,
  executionMeta = null,
  hephaestosRoleState = null,
}) {
  await db.insertTrade(trade);
  await db.updateSignalStatus(signalId, SIGNAL_STATUS.EXECUTED);
  if (executionMeta) {
    await db.updateSignalBlock(signalId, {
      meta: {
        exchange: trade.exchange || 'binance',
        symbol: trade.symbol,
        side: trade.side,
        tradeMode: signalTradeMode,
        executionMeta,
      },
    }).catch(() => {});
  }
  await notifyExecutedTrade({ trade, signalTradeMode, capitalPolicy });

  try {
    await recordExecutedTradeJournal({ trade, signalId, exitReason });
  } catch (journalErr) {
    console.warn(`  ⚠️ 매매일지 기록 실패: ${journalErr.message}`);
  }

  if (
    hephaestosRoleState?.mission === 'full_exit_cleanup'
    && trade?.exchange === 'binance'
    && trade?.paper !== true
    && trade?.side === 'sell'
    && !trade?.partialExit
  ) {
    await syncPositionsAtMarketOpen('crypto').catch(() => null);
  }
}

async function resolveSellExecutionContext({
  persistFailure,
  symbol,
  signalTradeMode,
  globalPaperMode,
}) {
  const livePosition = await db.getLivePosition(symbol, 'binance', signalTradeMode);
  const fallbackLivePosition = !livePosition
    ? await findAnyLivePosition(symbol, 'binance').catch(() => null)
    : null;
  const paperPosition = await db.getPaperPosition(symbol, 'binance', signalTradeMode);

  if (globalPaperMode && livePosition && !paperPosition) {
    const reason = '실포지션 보유 중에는 PAPER SELL로 혼합 청산을 실행할 수 없음';
    console.warn(`  ⚠️ ${reason}`);
    await persistFailure(reason, {
      code: 'position_mode_conflict',
      meta: {
        paperMode: globalPaperMode,
        liveAmount: livePosition.amount || 0,
        tradeMode: signalTradeMode,
      },
    });
    return { success: false, reason };
  }

  if (!globalPaperMode && !livePosition && fallbackLivePosition && fallbackLivePosition.trade_mode !== signalTradeMode) {
    const reason = `동일 심볼의 다른 trade_mode(${fallbackLivePosition.trade_mode}) LIVE 포지션만 존재 — ${signalTradeMode} SELL로 교차 청산 차단`;
    console.warn(`  ⚠️ ${symbol} ${reason}`);
    await persistFailure(reason, {
      code: 'cross_trade_mode_sell_blocked',
      meta: {
        requestedTradeMode: signalTradeMode,
        fallbackTradeMode: fallbackLivePosition.trade_mode || 'normal',
        fallbackAmount: Number(fallbackLivePosition.amount || 0),
      },
    });
    return { success: false, reason };
  }

  const position = paperPosition || livePosition || fallbackLivePosition;
  const sellPaperMode = globalPaperMode || (!livePosition && Boolean(paperPosition));
  const effectivePositionTradeMode = (!sellPaperMode && (livePosition || fallbackLivePosition)?.trade_mode)
    || paperPosition?.trade_mode
    || signalTradeMode;
  const base = symbol.split('/')[0];
  const balance = sellPaperMode ? null : await getExchange().fetchBalance();
  const freeBalance = Number(balance?.free?.[base] || 0);
  const totalBalance = Number(balance?.total?.[base] || freeBalance || 0);

  return {
    success: true,
    livePosition,
    fallbackLivePosition,
    paperPosition,
    position,
    sellPaperMode,
    effectivePositionTradeMode,
    base,
    freeBalance,
    totalBalance,
  };
}

async function resolveSellAmount({
  persistFailure,
  signalId,
  symbol,
  signalTradeMode,
  sellPaperMode,
  livePosition,
  fallbackLivePosition,
  paperPosition,
  position,
  freeBalance,
  totalBalance,
  partialExitRatio = null,
}) {
  let freeBalanceNow = Number(freeBalance || 0);
  let totalBalanceNow = Number(totalBalance || freeBalance || 0);
  let amount = position?.amount;
  const normalizedPartialExitRatio = normalizePartialExitRatio(partialExitRatio);

  if (!sellPaperMode && normalizedPartialExitRatio >= 1) {
    const { cancelledCount } = await cancelOpenSellOrdersForSymbol(symbol).catch(() => ({ cancelledCount: 0 }));
    if (cancelledCount > 0) {
      const refreshed = await fetchAssetBalances(symbol).catch(() => null);
      if (refreshed) {
        freeBalanceNow = refreshed.freeBalance;
        totalBalanceNow = refreshed.totalBalance;
      }
    }
  }

  if (!amount || amount <= 0) {
    amount = sellPaperMode
      ? Number(livePosition?.amount || fallbackLivePosition?.amount || paperPosition?.amount || 0)
      : totalBalanceNow;
    if (amount <= 0) {
      console.warn(`  ⚠️ ${symbol} 보유량 없음 (DB+바이낸스 모두 0) — SELL 스킵`);
      await persistFailure('보유량 없음', {
        code: 'missing_position',
        meta: { sellPaperMode },
      });
      return { success: false, reason: '보유량 없음' };
    }
    console.log(`  ℹ️ DB 포지션 없음 → 바이낸스 실잔고 사용: ${amount} ${symbol.split('/')[0]}`);
  } else if (!livePosition && fallbackLivePosition && fallbackLivePosition.trade_mode !== signalTradeMode) {
    console.warn(`  ⚠️ ${symbol} SELL 신호(${signalTradeMode})에 대응되는 live 포지션 없음 → ${fallbackLivePosition.trade_mode} 포지션 기준으로 청산`);
  } else if (!sellPaperMode && freeBalanceNow <= 0 && amount > 0 && totalBalanceNow <= 0) {
    const reason = `가용 잔고 없음 (free=${freeBalanceNow}, total=${totalBalanceNow || 0})`;
    console.warn(`  ⚠️ ${symbol} ${reason} — SELL 스킵`);
    await persistFailure(reason, {
      code: 'no_free_balance_for_sell',
      meta: {
        exchange: 'binance',
        symbol,
        dbAmount: position?.amount || 0,
        freeBalance: freeBalanceNow,
        totalBalance: totalBalanceNow,
        sellPaperMode,
      },
    });
    return { success: false, reason };
  } else if (!sellPaperMode && normalizedPartialExitRatio >= 1 && totalBalanceNow > 0) {
    if (Math.abs(amount - totalBalanceNow) > Math.max(0.000001, totalBalanceNow * 0.001)) {
      console.warn(`  ⚠️ ${symbol} 전량 청산 모드 — 전체 잔고 기준으로 SELL 수량 조정 ${amount} → ${totalBalanceNow}`);
    }
    amount = totalBalanceNow;
  } else if (!sellPaperMode && freeBalanceNow < amount) {
    const drift = amount - freeBalanceNow;
    console.warn(`  ⚠️ ${symbol} DB 포지션(${amount})과 가용잔고(free=${freeBalanceNow}, total=${totalBalanceNow || freeBalanceNow})가 어긋남 — free 기준으로 SELL 진행`);
    await reconcileOpenJournalToTrackedAmount(
      symbol,
      sellPaperMode,
      freeBalanceNow,
      position?.trade_mode || fallbackLivePosition?.trade_mode || signalTradeMode,
    ).catch(() => null);
    amount = freeBalanceNow;
    await db.updateSignalBlock(signalId, {
      reason: `position_reconciled_to_balance:${drift.toFixed(8)}`,
      code: 'position_balance_reconciled',
      meta: {
        exchange: 'binance',
        symbol,
        dbAmount: position?.amount || 0,
        freeBalance: freeBalanceNow,
        totalBalance: totalBalanceNow,
        drift,
      },
    }).catch(() => {});
  }

  const sourcePositionAmount = Number(amount || 0);
  if (normalizedPartialExitRatio < 1) {
    amount = sourcePositionAmount * normalizedPartialExitRatio;
  }

  if (!sellPaperMode) {
    const minSellAmount = await getMinSellAmount(symbol).catch(() => 0);
    const roundedAmount = roundSellAmount(symbol, amount);
    if (roundedAmount <= 0 || (minSellAmount > 0 && roundedAmount < minSellAmount)) {
      const reason = `최소 매도 수량 미달 (${roundedAmount || amount} < ${minSellAmount || 'exchange_min'})`;
      console.warn(`  ⚠️ ${symbol} ${reason} — SELL 스킵`);
      if (normalizedPartialExitRatio >= 1) {
        await cleanupDustLivePosition(symbol, livePosition, signalTradeMode, {
          signalId,
          freeBalance: freeBalanceNow,
          roundedAmount: roundedAmount || amount,
          minSellAmount,
        });
      }
      await persistFailure(reason, {
        code: normalizedPartialExitRatio < 1 ? 'partial_sell_below_minimum' : 'sell_amount_below_minimum',
        meta: {
          requestedAmount: amount,
          roundedAmount,
          minSellAmount,
          sellPaperMode,
          freeBalance: freeBalanceNow,
          totalBalance: totalBalanceNow,
          partialExitRatio: normalizedPartialExitRatio < 1 ? normalizedPartialExitRatio : null,
        },
      });
      return { success: false, reason };
    }
    amount = roundedAmount;
  }

  return {
    success: true,
    amount,
    sourcePositionAmount,
    partialExitRatio: normalizedPartialExitRatio,
    freeBalance: freeBalanceNow,
    totalBalance: totalBalanceNow,
  };
}

async function executeSellTrade({
  signalId,
  symbol,
  amount,
  sellPaperMode,
  effectivePositionTradeMode,
  position,
  sourcePositionAmount,
  partialExitRatio = null,
  qualityContext = null,
}) {
  const sellSubmittedAtMs = Date.now();
  const sellClientOrderId = !sellPaperMode
    ? buildDeterministicClientOrderId({
        signalId,
        symbol,
        action: ACTIONS.SELL,
        scope: effectivePositionTradeMode || 'main',
      })
    : null;
  const order = await marketSell(symbol, amount, sellPaperMode, {
    clientOrderId: sellClientOrderId,
    submittedAtMs: sellSubmittedAtMs,
  });
  const soldAmount = Number(order.filled || order.amount || amount || 0);
  const sellPrice = Number(order.price || order.average || 0);
  const settledUsdt = Number(order.totalUsdt || order.cost || (soldAmount * sellPrice));
  const effectiveRatio = normalizePartialExitRatio(partialExitRatio);
  const baselineAmount = Number(sourcePositionAmount || position?.amount || 0);
  const remainingAmount = Math.max(0, baselineAmount - soldAmount);
  const isPartialExit = isEffectivePartialExit({
    entrySize: baselineAmount,
    soldAmount,
    partialExitRatio: effectiveRatio,
  });
  const trade = {
    signalId,
    symbol,
    side: 'sell',
    amount: soldAmount,
    price: sellPrice,
    totalUsdt: settledUsdt,
    paper: sellPaperMode,
    exchange: 'binance',
    tradeMode: effectivePositionTradeMode,
    partialExitRatio: isPartialExit
      ? (effectiveRatio < 1
          ? effectiveRatio
          : normalizePartialExitRatio(baselineAmount > 0 ? soldAmount / baselineAmount : 1))
      : null,
    partialExit: isPartialExit,
    remainingAmount: isPartialExit ? remainingAmount : 0,
    ...(qualityContext || {}),
  };

  if (isPartialExit) {
    const remainingUnrealizedPnl = baselineAmount > 0
      ? Number(position?.unrealized_pnl || 0) * (remainingAmount / baselineAmount)
      : 0;
    await db.upsertPosition({
      symbol,
      amount: remainingAmount,
      avgPrice: Number(position?.avg_price || 0),
      unrealizedPnl: remainingUnrealizedPnl,
      paper: sellPaperMode,
      exchange: 'binance',
      tradeMode: effectivePositionTradeMode,
    });
    await syncCryptoStrategyExecutionState({
      symbol,
      tradeMode: effectivePositionTradeMode,
      lifecycleStatus: 'partial_exit_executed',
      recommendation: 'ADJUST',
      reasonCode: 'partial_exit_executed',
      reason: '부분청산 체결 완료',
      trade,
      partialExitRatio: trade.partialExitRatio,
      updatedBy: 'hephaestos_partial_sell',
    });
  } else {
    await db.deletePosition(symbol, {
      exchange: 'binance',
      paper: sellPaperMode,
      tradeMode: effectivePositionTradeMode,
    });

    if (!sellPaperMode) {
      const residual = await fetchAssetBalances(symbol).catch(() => null);
      const residualAmount = Number(residual?.totalBalance || 0);
      if (residualAmount > 0.00000001) {
        const converted = await tryConvertResidualDustToUsdt(symbol, residualAmount).catch(() => null);
        if (converted) {
          console.log(`  🧹 ${symbol} 전량 청산 후 잔여 ${residualAmount.toFixed(8)} 자동 convert → USDT`);
        }
      }
    }
  }

  return trade;
}

async function resolveBuyExecutionMode({
  persistFailure,
  signalId,
  symbol,
  action,
  amountUsdt,
  signalTradeMode,
  globalPaperMode,
  capitalPolicy,
}) {
  const check = await preTradeCheck(symbol, 'BUY', amountUsdt, 'binance', signalTradeMode);
  if (check.allowed) {
    if (check.softGuardApplied) {
      const guardSummary = (check.softGuards || []).map((guard) => guard.kind).join(', ');
      console.log(`  ⚖️ [가드 완화] ${symbol} ${guardSummary} → 감산 허용 x${Number(check.reducedAmountMultiplier || 1).toFixed(2)}`);
    }
    return {
      effectivePaperMode: globalPaperMode,
      softGuardApplied: Boolean(check.softGuardApplied),
      softGuards: check.softGuards || [],
      reducedAmountMultiplier: Number(check.reducedAmountMultiplier || 1),
    };
  }

  // L5 fail-closed: 실잔고 부족은 PAPER fallback이 아니라 capital_backpressure로 처리한다.
  // 명시 설정(LUNA_CAPITAL_ALLOW_PAPER_FALLBACK=true)이 있을 때만 PAPER 폴백 허용.
  const allowPaperFallback = process.env.LUNA_CAPITAL_ALLOW_PAPER_FALLBACK === 'true';
  if (!globalPaperMode && !check.circuit && isCapitalShortageReason(check.reason || '')) {
    if (allowPaperFallback) {
      console.log(`  📄 [자본관리] 실잔고 부족 → PAPER 폴백 (명시 허용): ${check.reason}`);
      await db.updateSignalBlock(signalId, {
        reason: `paper_fallback:${check.reason}`,
        code: 'paper_fallback',
        meta: { exchange: 'binance', symbol, action, amount: amountUsdt },
      });
      notifyTradeSkip({ symbol, action, reason: `실잔고 부족으로 PAPER 전환: ${check.reason}`, priority: 'low' }).catch(() => {});
      return { effectivePaperMode: true };
    }
    // 기본값: capital_backpressure fail-closed
    console.log(`  💰 [자본관리] 매수가능금액 부족 → capital_backpressure 처리: ${check.reason}`);
    return rejectExecution({
      persistFailure,
      symbol,
      action,
      reason: check.reason,
      code: 'capital_backpressure',
      meta: buildGuardTelemetryMeta(symbol, action, signalTradeMode, {
        capitalShortage: true,
      }, {
        guardKind: 'cash_constrained',
        pressureSource: 'capital_shortage',
      }),
      notify: 'digest',
    });
  }

  if (!globalPaperMode && signalTradeMode === 'normal') {
    const fallback = await maybeFallbackToValidationLane({
      symbol,
      action,
      amountUsdt,
      reason: check.reason || '',
      signalTradeMode,
    });
    if (fallback) {
      console.log(
        `  ⚖️ [validation fallback] ${symbol} normal 차단 → validation guarded live 전환 x${fallback.reducedAmountMultiplier.toFixed(2)}`
      );
      return {
        effectivePaperMode: false,
        effectiveTradeMode: 'validation',
        softGuardApplied: true,
        softGuards: [
          {
            kind: 'normal_to_validation_fallback',
            exchange: 'binance',
            tradeMode: 'validation',
            originTradeMode: signalTradeMode,
            reductionMultiplier: fallback.reducedAmountMultiplier,
            originReason: check.reason || '',
          },
          ...(fallback.validationCheck?.softGuards || []),
        ],
        reducedAmountMultiplier: fallback.reducedAmountMultiplier,
      };
    }
  }

  console.log(`  ⛔ [자본관리] 매매 스킵: ${check.reason}`);
  return rejectExecution({
    persistFailure,
    symbol,
    action,
    reason: check.reason,
    code: check.circuit ? 'capital_circuit_breaker' : 'capital_guard_rejected',
    meta: buildGuardTelemetryMeta(symbol, action, signalTradeMode, {
      circuit: Boolean(check.circuit),
      circuitType: check.circuitType ?? null,
      openPositions: !check.circuit ? (await getOpenPositions('binance', false, signalTradeMode).catch(() => [])).length : undefined,
      maxPositions: !check.circuit ? capitalPolicy.max_concurrent_positions : undefined,
    }, {
      guardKind: check.circuit ? 'capital_circuit_breaker' : 'capital_guard_rejected',
      pressureSource: check.circuit ? 'circuit_breaker' : 'pre_trade_check',
    }),
    notify: check.circuit ? 'circuit' : 'skip',
  });
}

function getNormalToValidationFallbackPolicy() {
  const execution = getInvestmentExecutionRuntimeConfig();
  return execution?.cryptoGuardSoftening?.byExchange?.binance?.tradeModes?.normal?.validationFallback || {};
}

function getMaxPositionsOverflowPolicy(signalTradeMode = 'normal') {
  const execution = getInvestmentExecutionRuntimeConfig();
  return execution?.cryptoGuardSoftening?.byExchange?.binance?.tradeModes?.[signalTradeMode || 'normal']?.maxPositions || {};
}

function getValidationLiveReentrySofteningPolicy() {
  const execution = getInvestmentExecutionRuntimeConfig();
  return execution?.cryptoGuardSoftening?.byExchange?.binance?.tradeModes?.validation?.livePositionReentry || {};
}

function classifyValidationFallbackGuard(reason = '') {
  const text = String(reason || '');
  if (text.includes('최대 포지션 도달')) return 'max_positions';
  if (text.includes('일간 매매 한도')) return 'daily_trade_limit';
  return null;
}

async function maybeFallbackToValidationLane({
  symbol,
  action,
  amountUsdt,
  reason,
  signalTradeMode,
}) {
  const policy = getNormalToValidationFallbackPolicy();
  if (policy?.enabled === false) return null;

  const guardKind = classifyValidationFallbackGuard(reason);
  const allowedGuardKinds = Array.isArray(policy?.allowedGuardKinds) ? policy.allowedGuardKinds : [];
  if (!guardKind || !allowedGuardKinds.includes(guardKind)) return null;

  const existingLive = await findAnyLivePosition(symbol, 'binance').catch(() => null);
  if (existingLive) return null;

  const reductionMultiplier = Number(policy?.reductionMultiplier || 0);
  if (!(reductionMultiplier > 0 && reductionMultiplier < 1)) return null;

  const reducedAmount = Number(amountUsdt || 0) * reductionMultiplier;
  const validationCheck = await preTradeCheck(symbol, 'BUY', reducedAmount, 'binance', 'validation');
  if (!validationCheck.allowed) return null;

  return {
    effectiveTradeMode: 'validation',
    reducedAmountMultiplier: reductionMultiplier,
    validationCheck,
    originTradeMode: signalTradeMode,
    guardKind,
    action,
  };
}

async function resolveBuyOrderAmount({
  persistFailure,
  symbol,
  action,
  amountUsdt,
  signal,
  effectivePaperMode,
  reducedAmountMultiplier = 1,
  softGuards = [],
}) {
  const slPrice = signal.slPrice || 0;
  const currentPrice = await fetchTicker(symbol).catch(() => 0);
  const sizing = await calculatePositionSize(symbol, currentPrice, slPrice, 'binance');
  const minOrderUsdt = await getDynamicMinOrderAmount('binance', signal?.trade_mode || getInvestmentTradeMode());
  if (sizing.skip && !effectivePaperMode) {
    console.log(`  ⛔ [자본관리] 포지션 크기 부족: ${sizing.reason}`);
    return rejectExecution({
      persistFailure,
      symbol,
      action,
      reason: sizing.reason,
      code: 'position_sizing_rejected',
      meta: {
        currentPrice,
        slPrice,
        capitalPct: sizing.capitalPct ?? null,
        riskPercent: sizing.riskPercent ?? null,
      },
      notify: 'skip',
    });
  }

  const softMultiplier = Number(reducedAmountMultiplier || 1);
  const baseAmount = effectivePaperMode ? amountUsdt : sizing.size;
  const actualAmount = softMultiplier > 0 && softMultiplier < 1
    ? baseAmount * softMultiplier
    : baseAmount;
  if (!effectivePaperMode && actualAmount < minOrderUsdt) {
    return rejectExecution({
      persistFailure,
      symbol,
      action,
      reason: `감산 후 주문금액 ${actualAmount.toFixed(2)} < 최소 ${minOrderUsdt}`,
      code: 'position_sizing_rejected',
      meta: {
        currentPrice,
        slPrice,
        minOrderUsdt,
        reducedAmountMultiplier: softMultiplier,
        softGuards,
      },
      notify: 'skip',
    });
  }
  if (effectivePaperMode) {
    console.log(`  📄 [PAPER] 시그널 원본 금액으로 가상 포지션 추적: ${actualAmount.toFixed(2)} USDT`);
  } else {
    console.log(`  📐 [자본관리] 포지션 ${actualAmount.toFixed(2)} USDT (자본의 ${sizing.capitalPct}% | 리스크 ${sizing.riskPercent}%)`);
    if (softMultiplier > 0 && softMultiplier < 1) {
      console.log(`  🧪 [개발단계 완화] ${symbol} guard 감산 적용 x${softMultiplier.toFixed(2)} (${softGuards.map((guard) => guard.kind).join(', ')})`);
    }
  }

  return { actualAmount };
}

function normalizeResponsibilityPlan(plan = null) {
  return plan && typeof plan === 'object' ? plan : {};
}

function normalizeExecutionPlan(plan = null) {
  return plan && typeof plan === 'object' ? plan : {};
}

function applyResponsibilityExecutionSizing(amount, {
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
  } else if (ownerMode === 'balanced_rotation') {
    multiplier *= 0.98;
    reasons.push('owner balanced_rotation');
  } else if (ownerMode === 'opportunity_capture' && Number(confidence || 0) >= 0.74) {
    multiplier *= 1.03;
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
    amount: numericAmount * normalizedMultiplier,
    multiplier: normalizedMultiplier,
    reason: reasons.length > 0 ? reasons.join(' + ') : null,
  };
}

async function fetchRecentBrokerExit(symbol, amountHint = 0) {
  try {
    const orders = await getExchange().fetchOrders(symbol, undefined, 20);
    const candidates = (orders || [])
      .filter((order) =>
        order?.side === 'sell'
        && order?.status === 'closed'
        && Number(order?.filled || 0) > 0,
      )
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
    if (candidates.length === 0) return null;
    if (!(amountHint > 0)) return candidates[0];
    return candidates.find((order) => {
      const filled = Number(order?.filled || 0);
      return filled > 0 && Math.abs(filled - amountHint) <= Math.max(1e-6, amountHint * 0.02);
    }) || candidates[0];
  } catch {
    return null;
  }
}

async function getUntrackedLiquidationQuarantineSummary(symbol) {
  const [recentTrade] = await db.query(
    `SELECT side, executed_at
       FROM trades
      WHERE symbol = $1
        AND exchange = 'binance'
        AND executed_at > now() - interval '24 hours'
      ORDER BY executed_at DESC
      LIMIT 1`,
    [symbol],
  ).catch(() => [[]]);

  const [recentPromotion] = await db.query(
    `SELECT trade_id, exit_time
       FROM trade_journal
      WHERE symbol = $1
        AND exchange = 'binance'
        AND exit_reason = 'promoted_to_live'
        AND exit_time IS NOT NULL
        AND to_timestamp(exit_time / 1000.0) > now() - interval '24 hours'
      ORDER BY exit_time DESC
      LIMIT 1`,
    [symbol],
  ).catch(() => [[]]);

  return {
    recentTrade: recentTrade || null,
    recentPromotion: recentPromotion || null,
    active: Boolean(recentTrade || recentPromotion),
  };
}

async function reconcileLivePositionsWithBrokerBalance() {
  const livePositions = await db.getAllPositions('binance', false).catch(() => []);
  if (livePositions.length === 0) return [];

  const wallet = await getExchange().fetchBalance();
  const walletTotals = wallet?.total || {};
  const results = [];

  for (const position of livePositions) {
    const symbol = position.symbol;
    const base = String(symbol || '').split('/')[0];
    const trackedAmount = Number(position.amount || 0);
    const walletAmount = Number(walletTotals?.[base] || 0);
    const drift = walletAmount - trackedAmount;
    const tradeMode = position.trade_mode || 'normal';

    if (walletAmount <= 0.000001) {
      const brokerExit = await fetchRecentBrokerExit(symbol, trackedAmount);
      const exitPrice = Number(brokerExit?.average || brokerExit?.price || 0)
        || await fetchTicker(symbol).catch(() => 0);
      const exitValue = trackedAmount * (exitPrice || 0);
      await db.deletePosition(symbol, {
        exchange: 'binance',
        paper: false,
        tradeMode,
      });
      await closeOpenJournalForSymbol(
        symbol,
        false,
        exitPrice || null,
        exitValue || null,
        'broker_wallet_zero_reconciled',
        tradeMode,
        {
          executionOrigin: 'cleanup',
          qualityFlag: 'exclude_from_learning',
          excludeFromLearning: true,
          incidentLink: 'broker_wallet_zero_reconcile',
        },
      ).catch(() => {});
      console.warn(`  ⚠️ [헤파이스토스] ${symbol} 실지갑 0 → 포지션 자동 정리 (${tradeMode})`);
      results.push({ symbol, tradeMode, action: 'deleted', trackedAmount, walletAmount, drift });
      continue;
    }

    if (Math.abs(drift) > Math.max(0.000001, trackedAmount * 0.001)) {
      await db.upsertPosition({
        symbol,
        amount: walletAmount,
        avgPrice: Number(position.avg_price || 0),
        unrealizedPnl: Number(position.unrealized_pnl || 0),
        paper: false,
        exchange: 'binance',
        tradeMode,
      });
      console.warn(`  ⚠️ [헤파이스토스] ${symbol} 실지갑 기준 수량 보정 ${trackedAmount} → ${walletAmount} (${tradeMode})`);
      results.push({ symbol, tradeMode, action: 'updated', trackedAmount, walletAmount, drift });
    }
  }

  return results;
}

async function maybePromotePaperPositions({ reserveSlots = 0 } = {}) {
  const capitalPolicy = getCapitalConfig('binance', 'normal');
  const minOrderUsdt = await getDynamicMinOrderAmount('binance', 'normal');
  const paperPositions = await db.getPaperPositions('binance', 'normal').catch(() => []);
  if (paperPositions.length === 0) return [];

  let liveOpenPositions = await getOpenPositions('binance', false, 'normal').catch(() => []);
  const maxPromotableOpenPositions = Math.max(0, capitalPolicy.max_concurrent_positions - Math.max(0, reserveSlots));
  if (liveOpenPositions.length >= maxPromotableOpenPositions) return [];

  const promoted = [];
  for (const paperPos of paperPositions) {
    if (liveOpenPositions.length >= maxPromotableOpenPositions) break;

    const desiredUsdt = (paperPos.amount || 0) * (paperPos.avg_price || 0);
    if (desiredUsdt < minOrderUsdt) continue;

    const freeUsdt = await getAvailableUSDT().catch(() => 0);
    if (freeUsdt < desiredUsdt) break;

    const check = await preTradeCheck(paperPos.symbol, 'BUY', desiredUsdt, 'binance', 'normal');
    if (!check.allowed) {
      if (isCapitalShortageReason(check.reason || '')) break;
      continue;
    }

    const order = await marketBuy(paperPos.symbol, desiredUsdt, false);
    const trade = {
      signalId:   null,
      symbol:     paperPos.symbol,
      side:       'buy',
      amount:     order.filled,
      price:      order.price,
      totalUsdt:  desiredUsdt,
      paper:      false,
      exchange:   'binance',
      executionOrigin: 'promotion',
      qualityFlag: 'exclude_from_learning',
      excludeFromLearning: true,
      incidentLink: 'paper_to_live_promotion',
    };

    await closeOpenJournalForSymbol(
      paperPos.symbol,
      true,
      order.price,
      (paperPos.amount || 0) * (order.price || 0),
      'promoted_to_live',
      paperPos.trade_mode || 'normal',
      {
        executionOrigin: 'promotion',
        qualityFlag: 'exclude_from_learning',
        excludeFromLearning: true,
        incidentLink: 'paper_to_live_promotion',
      },
    ).catch(() => {});

    await db.upsertPosition({
      symbol:        paperPos.symbol,
      amount:        order.filled || 0,
      avgPrice:      order.price || 0,
      unrealizedPnl: 0,
      exchange:      'binance',
      paper:         false,
    });
    await db.insertTrade(trade);

    try {
      const execTime = Date.now();
      const tradeId  = await journalDb.generateTradeId();
      await journalDb.insertJournalEntry({
        trade_id:      tradeId,
        signal_id:     null,
        market:        'crypto',
        exchange:      'binance',
        symbol:        trade.symbol,
        is_paper:      false,
        entry_time:    execTime,
        entry_price:   trade.price || 0,
        entry_size:    trade.amount || 0,
        entry_value:   trade.totalUsdt || 0,
        direction:     'long',
        execution_origin: 'promotion',
        quality_flag: 'exclude_from_learning',
        exclude_from_learning: true,
        incident_link: 'paper_to_live_promotion',
      });
      notifyJournalEntry({
        tradeId,
        symbol:     trade.symbol,
        direction:  'long',
        market:     'crypto',
        entryPrice: trade.price,
        entryValue: trade.totalUsdt,
        isPaper:    false,
      });
    } catch (journalErr) {
      console.warn(`  ⚠️ paper→live 승격 일지 기록 실패: ${journalErr.message}`);
    }

    await notifyTrade({
      ...trade,
      tradeMode: 'normal',
      memo: `기존 PAPER 포지션 실투자 승격 (${paperPos.amount?.toFixed(6)} → ${trade.amount?.toFixed(6)})`,
    }).catch(() => {});

    promoted.push({ symbol: paperPos.symbol, totalUsdt: desiredUsdt, amount: trade.amount });
    liveOpenPositions = await getOpenPositions('binance', false, 'normal').catch(() => liveOpenPositions);
  }

  return promoted;
}

export async function inspectPromotionCandidates() {
  const capitalPolicy = getCapitalConfig('binance', 'normal');
  const minOrderUsdt = await getDynamicMinOrderAmount('binance', 'normal');
  const freeUsdt = await getAvailableUSDT().catch(() => 0);
  const paperPositions = await db.getPaperPositions('binance', 'normal').catch(() => []);
  const results = [];

  for (const paperPos of paperPositions) {
    const desiredUsdt = (paperPos.amount || 0) * (paperPos.avg_price || 0);
    const minOrder = minOrderUsdt;
    const tooSmall = desiredUsdt < minOrder;
    const enoughUsdt = freeUsdt >= desiredUsdt;
    /** @type {any} */
    let check = { allowed: false, reason: tooSmall ? `최소 주문 미만: ${desiredUsdt.toFixed(2)} USDT` : 'USDT 부족' };

    if (!tooSmall && enoughUsdt) {
      check = await preTradeCheck(paperPos.symbol, 'BUY', desiredUsdt, 'binance', 'normal');
    }

    results.push({
      symbol: paperPos.symbol,
      paperAmount: paperPos.amount || 0,
      avgPrice: paperPos.avg_price || 0,
      desiredUsdt,
      freeUsdt,
      promotable: !tooSmall && enoughUsdt && check.allowed,
      reason: !tooSmall && enoughUsdt ? (check.allowed ? '승격 가능' : check.reason) : check.reason,
    });
  }

  return {
    freeUsdt,
    paperCount: paperPositions.length,
    candidates: results,
  };
}

export async function simulateBuyDecision({ symbol, amountUsdt = 100 }) {
  const capitalPolicy = getCapitalConfig('binance', getInvestmentTradeMode());
  const currentPrice = await fetchTicker(symbol).catch(() => 0);
  const slPrice = 0;
  const check = await preTradeCheck(symbol, 'BUY', amountUsdt, 'binance');
  const sizing = await calculatePositionSize(symbol, currentPrice, slPrice, 'binance');
  const paperFallback = !isPaperMode() && !check.circuit && !check.allowed && isCapitalShortageReason(check.reason || '');
  const reducedAmountMultiplier = Number(check.reducedAmountMultiplier || 1);
  const suggestedLiveAmountUsdt = sizing.skip ? 0 : sizing.size * (reducedAmountMultiplier > 0 && reducedAmountMultiplier < 1 ? reducedAmountMultiplier : 1);

  return {
    symbol,
    requestedAmountUsdt: amountUsdt,
    currentPrice,
    liveAllowed: check.allowed,
    liveReason: check.allowed ? 'LIVE 가능' : check.reason,
    paperFallback,
    finalMode: check.allowed ? 'live' : paperFallback ? 'paper' : 'blocked',
    suggestedLiveAmountUsdt,
    softGuardApplied: Boolean(check.softGuardApplied),
    softGuards: check.softGuards || [],
    reducedAmountMultiplier,
    capitalPolicy: {
      reserveRatio: capitalPolicy.reserve_ratio,
      minOrderUsdt,
      maxPositionPct: capitalPolicy.max_position_pct,
      maxConcurrentPositions: capitalPolicy.max_concurrent_positions,
    },
    sizing,
  };
}

// ─── BTC 직접 페어 매수 ──────────────────────────────────────────────

/**
 * 미추적 BTC → 직접 BTC 페어(ETH/BTC 등)로 매수
 * BTC→USDT 변환 없이 1회 수수료로 처리 (가격 갭 최소화)
 * @returns {Promise<any|null>} 성공 시 결과 객체, BTC 페어 없거나 미추적 BTC 없으면 null
 */
async function _tryBuyWithBtcPair(symbol, base, signalId, signal, paperMode) {
  const signalTradeMode = signal?.trade_mode || getInvestmentTradeMode();
  const capitalPolicy = getCapitalConfig('binance', signalTradeMode);
  const minOrderUsdt = await getDynamicMinOrderAmount('binance', signalTradeMode);
  if (base === 'BTC') return null;  // BTC 자체는 흡수 블록에서 처리

  // 미추적 BTC 확인
  const walletBal    = await getExchange().fetchBalance();
  const walletBtc    = walletBal.free?.BTC || 0;
  const trackedBtcPos = await db.getLivePosition('BTC/USDT', null, signalTradeMode).catch(() => null);
  const trackedBtc   = trackedBtcPos?.amount || 0;
  const untrackedBtc = walletBtc - trackedBtc;

  if (untrackedBtc <= 0) return null;

  // 미추적 BTC USD 환산 → 최소금액 체크
  const btcPrice     = await fetchTicker('BTC/USDT').catch(() => 0);
  const untrackedUsd = untrackedBtc * btcPrice;
  if (untrackedUsd < minOrderUsdt) return null;

  // BTC 직접 페어 존재 여부 확인
  const btcPair = `${base}/BTC`;
  const ex      = getExchange();
  const markets = await ex.loadMarkets();
  if (!markets[btcPair]) {
    console.log(`  ℹ️ ${btcPair} 페어 없음 → USDT 전환 폴백`);
    return null;
  }

  // ETH/BTC 현재가 → 살 수 있는 코인 수량
  const pairTicker = await ex.fetchTicker(btcPair);
  const btcPerCoin = Number(pairTicker.last || 0);  // 1 ETH = N BTC
  if (!Number.isFinite(btcPerCoin) || btcPerCoin <= 0) return null;
  const coinAmount = untrackedBtc / btcPerCoin;

  console.log(`  💱 [헤파이스토스] BTC 직접 매수: ${untrackedBtc.toFixed(6)} BTC → ${coinAmount.toFixed(6)} ${base} (${btcPair})`);

  // 시장가 매수 (주문 시도 이후 오류는 fallback 재매수 금지)
  let order;
  let orderStatus = 'closed';
  let orderId = null;
  let clientOrderId = null;
  const submittedAtMs = Date.now();
  let pairPriceBtc = btcPerCoin;
  let filledCoin = coinAmount;
  if (paperMode) {
    order = {
      id: null,
      amount: coinAmount,
      filled: coinAmount,
      price: btcPerCoin,
      average: btcPerCoin,
      cost: coinAmount * btcPerCoin,
      status: 'closed',
      dryRun: true,
      normalized: true,
    };
    console.log(`  📄 [헤파이스토스] PAPER BUY ${btcPair} ${coinAmount.toFixed(6)} @ ${btcPerCoin}`);
  } else {
    clientOrderId = buildDeterministicClientOrderId({
      signalId,
      symbol: btcPair,
      action: ACTIONS.BUY,
      scope: 'btc_pair',
    });
    try {
      const rawOrder = await ex.createOrder(
        btcPair,
        'market',
        'buy',
        coinAmount,
        undefined,
        { newClientOrderId: clientOrderId },
      );
      order = await normalizeBinanceMarketOrderExecution(btcPair, 'buy', rawOrder, {
        expectedClientOrderId: clientOrderId,
        submittedAtMs,
      });
    } catch (orderError) {
      const errorMeta = orderError?.meta && typeof orderError.meta === 'object' ? orderError.meta : {};
      const pendingAmount = Math.max(0, Number(errorMeta.amount || coinAmount || 0));
      const pendingFilled = Math.max(0, Number(errorMeta.filled || 0));
      const pendingPairPrice = Math.max(0, Number(errorMeta.price || btcPerCoin || 0));
      const pendingOrderId = errorMeta.orderId || null;
      const pendingClientOrderId = errorMeta.clientOrderId || clientOrderId || null;
      const pendingStatus = String(errorMeta.status || orderError?.code || 'unknown').trim().toLowerCase() || 'unknown';
      const pendingUsdtPrice = await fetchTicker(symbol).catch(() => btcPrice * (pendingPairPrice > 0 ? pendingPairPrice : btcPerCoin));
      const pendingCostBtc = Math.max(0, Number(errorMeta.cost || 0));
      const pendingCostUsdt = pendingCostBtc > 0 && btcPrice > 0
        ? (pendingCostBtc * btcPrice)
        : (pendingFilled * pendingUsdtPrice);
      throw buildBtcPairPendingReconcileError(orderError, {
        signalSymbol: symbol,
        orderSymbol: btcPair,
        orderId: pendingOrderId,
        clientOrderId: pendingClientOrderId,
        status: pendingStatus,
        amount: pendingAmount,
        filled: pendingFilled,
        usdtPrice: pendingUsdtPrice,
        usdtCost: pendingCostUsdt,
        pairPriceBtc: pendingPairPrice || btcPerCoin,
        btcReferencePrice: btcPrice,
        submittedAtMs,
      });
    }
    orderStatus = String(order?.status || 'closed').trim().toLowerCase() || 'closed';
    orderId = extractExchangeOrderId(order);
    clientOrderId = extractClientOrderId(order) || clientOrderId;
    pairPriceBtc = Math.max(0, Number(order?.price || order?.average || btcPerCoin || 0));
    filledCoin = Math.max(0, Number(order?.filled || coinAmount || 0));
  }

  const usdPrice = await fetchTicker(symbol).catch(() => btcPrice * (pairPriceBtc > 0 ? pairPriceBtc : btcPerCoin));
  const usdEquiv = filledCoin * usdPrice;

  try {
    // DB 포지션 등록 (USDT 환산 기준)
    await db.upsertPosition({
      symbol,
      amount: filledCoin,
      avgPrice: usdPrice,
      unrealizedPnl: 0,
      paper: paperMode,
      exchange: 'binance',
      tradeMode: signalTradeMode,
    });

    // TP/SL OCO — /USDT 페어 기준 설정 (일관성 유지)
    const normalizedProtection = normalizeProtectiveExitPrices(symbol, usdPrice, usdPrice * 1.06, usdPrice * 0.97, 'fixed');
    const tpPrice = normalizedProtection.tpPrice;
    const slPrice = normalizedProtection.slPrice;
    let protectionSnapshot = buildProtectionSnapshot();
    if (!paperMode && usdPrice > 0) {
      try {
        const protection = await placeBinanceProtectiveExit(symbol, filledCoin, usdPrice, tpPrice, slPrice);
        protectionSnapshot = buildProtectionSnapshot(protection);
        if (protection.ok) {
          console.log(`  🛡️ TP/SL OCO (${symbol}): TP=${tpPrice} SL=${slPrice}`);
        } else if (isStopLossOnlyMode(protection.mode)) {
          console.warn(`  ⚠️ TP/SL OCO 미지원 → SL-only 보호주문 설정: SL=${slPrice}`);
        } else {
          throw new Error(protection.error || 'protective_exit_failed');
        }
      } catch (e) {
        protectionSnapshot = buildProtectionSnapshot(null, e.message);
        console.warn(`  ⚠️ TP/SL 설정 실패: ${e.message}`);
        await notifyError(`헤파이스토스 TP/SL 설정 실패 — ${symbol}`, e);
      }
    }

    const trade = {
      signalId, symbol,
      side:      'buy',
      amount:    filledCoin,
      price:     usdPrice,
      totalUsdt: usdEquiv,
      paper:     paperMode,
      exchange:  'binance',
      tpPrice, slPrice,
      ...protectionSnapshot,
      tpslSource: 'fixed',
      ...buildSignalQualityContext(signal),
    };
    await db.insertTrade(trade);
    await db.updateSignalStatus(signalId, SIGNAL_STATUS.EXECUTED);

    await notifyTrade({
      ...trade,
      tradeMode: signalTradeMode,
      memo: `BTC 직접 매수 (${btcPair}) — 미추적 BTC ${untrackedBtc.toFixed(6)} 활용${paperMode ? ' [PAPER]' : ''}`,
    }).catch(() => {});
  } catch (persistError) {
    if (!paperMode) {
      throw buildBtcPairPendingReconcileError(persistError, {
        signalSymbol: symbol,
        orderSymbol: btcPair,
        orderId,
        clientOrderId,
        status: orderStatus || 'unknown',
        amount: Number(order?.amount || coinAmount || 0),
        filled: filledCoin,
        usdtPrice: usdPrice,
        usdtCost: usdEquiv,
        pairPriceBtc,
        btcReferencePrice: btcPrice,
        submittedAtMs,
        reasonCode: 'btc_pair_post_order_reconcile_required',
      });
    }
    throw persistError;
  }

  return { success: true, btcDirect: true, btcPair, amount: filledCoin, price: usdPrice };
}

// ─── 미추적 코인 청산 (자본 확보) ───────────────────────────────────

/**
 * 지갑에서 DB 포지션에 없는 코인(BTC 등)을 매도해 USDT 확보
 * @param {string} excludeBase  — 매수 대상 base 심볼 (예: 'ETH') → 이것은 매도 제외
 * @param {boolean} paperMode
 */
async function _liquidateUntrackedForCapital(excludeBasesInput, paperMode) {
  const capitalPolicy = getCapitalConfig('binance');
  const minOrderUsdt = await getDynamicMinOrderAmount('binance', getInvestmentTradeMode());
  const ex        = getExchange();
  const walletBal = await ex.fetchBalance();
  let totalUsd    = 0;
  const liquidated = [];
  const quarantined = [];
  const excludeBases = new Set(
    (Array.isArray(excludeBasesInput) ? excludeBasesInput : [excludeBasesInput])
      .filter(Boolean)
      .map((value) => String(value).trim().toUpperCase()),
  );

  for (const [coin, free] of Object.entries(walletBal.free || {})) {
    if (coin === 'USDT')        continue;  // 기축통화 제외
    if (excludeBases.has(String(coin).trim().toUpperCase())) continue;  // 매수/승격 대상 제외
    if (!free || free <= 0)     continue;

    const sym        = `${coin}/USDT`;
    const trackedPos = await db.getLivePosition(sym, null, getInvestmentTradeMode()).catch(() => null);
    const trackedAmt = trackedPos?.amount || 0;
    const untracked  = free - trackedAmt;

    if (untracked <= 0) continue;

    const curPrice    = await fetchTicker(sym).catch(() => 0);
    const untrackedUsd = untracked * curPrice;

    if (untrackedUsd < minOrderUsdt) {
      console.log(`  ℹ️ 미추적 ${coin} ${untracked.toFixed(6)} (≈$${untrackedUsd.toFixed(2)}) — 최소금액 미만, 스킵`);
      continue;
    }

    const quarantine = await getUntrackedLiquidationQuarantineSummary(sym);
    if (quarantine.active) {
      const reasons = [
        quarantine.recentPromotion ? '최근 승격 이력' : null,
        quarantine.recentTrade ? `최근 ${String(quarantine.recentTrade.side || 'trade').toUpperCase()} 체결` : null,
      ].filter(Boolean);
      console.log(`  🧪 미추적 ${coin} ${untracked.toFixed(6)} (≈$${untrackedUsd.toFixed(2)}) — ${reasons.join(' + ')} 감지, 자동 청산 보류`);
      quarantined.push(`${coin} ${untracked.toFixed(6)} (≈$${untrackedUsd.toFixed(2)})`);
      continue;
    }

    console.log(`  💱 [헤파이스토스] 미추적 ${coin} ${untracked.toFixed(6)} (≈$${untrackedUsd.toFixed(2)}) → USDT 전환`);
    const liquidationOrder = await marketSell(sym, untracked, paperMode);
    const liquidatedAmount = Number(liquidationOrder?.filled || liquidationOrder?.amount || untracked || 0);
    const liquidatedPrice = Number(liquidationOrder?.price || liquidationOrder?.average || curPrice || 0);
    const liquidatedUsdt = Number(liquidationOrder?.totalUsdt || liquidationOrder?.cost || (liquidatedAmount * liquidatedPrice));
    await db.insertTrade({
      signalId: null,
      symbol: sym,
      side: 'liquidate',
      amount: liquidatedAmount,
      price: liquidatedPrice || null,
      totalUsdt: liquidatedUsdt,
      paper: paperMode,
      exchange: 'binance',
      tradeMode: getInvestmentTradeMode(),
      executionOrigin: 'cleanup',
      qualityFlag: 'exclude_from_learning',
      excludeFromLearning: true,
      incidentLink: 'untracked_liquidation',
    }).catch((err) => {
      console.warn(`  ⚠️ 미추적 청산 체결 기록 실패 (${sym}): ${err.message}`);
    });
    totalUsd += liquidatedUsdt;
    liquidated.push(`${coin} ${liquidatedAmount.toFixed(6)} (≈$${liquidatedUsdt.toFixed(2)})`);
  }

  if (totalUsd > 0) {
    console.log(`  ✅ 미추적 코인 청산 완료: 총 ≈$${totalUsd.toFixed(2)} USDT 확보`);
    notifyTrade({
      symbol:    `미추적코인→USDT`,
      side:      'liquidate',
      totalUsdt: totalUsd,
      paper:     paperMode,
      exchange:  'binance',
      tradeMode: getInvestmentTradeMode(),
      memo:      `미추적 코인 청산 → 신규 매수 자본 확보${paperMode ? ' [PAPER]' : ''}${liquidated.length ? ` | ${liquidated.join(', ')}` : ''}`,
    }).catch(() => {});
  }

  if (quarantined.length > 0) {
    console.log(`  🧪 미추적 코인 자동 청산 보류: ${quarantined.join(', ')}`);
  }
}

// ─── 신호 실행 ──────────────────────────────────────────────────────

export async function enqueueClientOrderPendingRetry({
  signalId,
  symbol,
  action,
  amountUsdt = 0,
  signalTradeMode = 'normal',
  effectivePaperMode = false,
  pendingOrder = {},
  pendingMeta = {},
  pendingFilled = 0,
  pendingRawPrice = 0,
  pendingRawCost = 0,
  persistFailure = async () => {},
  signal = null,
  deps = {},
} = {}) {
  const markSignalFn = typeof deps?.markSignal === 'function'
    ? deps.markSignal
    : markBinanceOrderPendingReconcileSignal;
  const reconcilePositionsFn = typeof deps?.reconcileLivePositions === 'function'
    ? deps.reconcileLivePositions
    : reconcileLivePositionsWithBrokerBalance;
  const notifyErrorFn = typeof deps?.notifyError === 'function'
    ? deps.notifyError
    : notifyError;

  try {
    await markSignalFn(signalId, {
      symbol,
      action,
      amountUsdt,
      tradeMode: signalTradeMode,
      paperMode: effectivePaperMode,
      orderMeta: {
        orderId: null,
        clientOrderId: pendingOrder?.clientOrderId || null,
        orderSymbol: pendingOrder?.orderSymbol || symbol,
        submittedAtMs: pendingOrder?.submittedAtMs || null,
        status: pendingOrder?.status || 'unknown',
        amount: Number(pendingOrder?.amount || 0),
        filled: pendingFilled,
        price: 0,
        cost: 0,
        rawPrice: pendingRawPrice,
        rawCost: pendingRawCost,
        quoteConversionApplied: false,
        quoteConversionRate: null,
        quoteConversionPair: null,
        quoteAsset: null,
        signalQuoteAsset: null,
        btcReferencePrice: null,
      },
      existingRecordedFilledQty: 0,
      existingRecordedCost: 0,
      appliedFilledQty: 0,
      appliedCost: 0,
      reconcileError: pendingOrder?.recoveryError || 'client_order_lookup_retry',
      orderStillOpen: null,
      pendingMeta,
    });
  } catch (markError) {
    const reason = `${symbol} pending reconcile 큐 기록 실패 — 자동 재시도 상태 저장 실패`;
    await persistFailure(reason, {
      code: 'pending_reconcile_enqueue_failed',
      meta: {
        exchange: 'binance',
        symbol,
        action,
        orderId: null,
        clientOrderId: pendingOrder?.clientOrderId || null,
        orderSymbol: pendingOrder?.orderSymbol || symbol,
        status: pendingOrder?.status || 'unknown',
        submittedAtMs: pendingOrder?.submittedAtMs || null,
        recoveryError: pendingOrder?.recoveryError || null,
        enqueueError: String(markError?.message || markError).slice(0, 240),
        source: pendingMeta?.source || null,
        orderAttempted: true,
      },
    });
    if (!isSyntheticOrTestSignalContext({ signalId, reasoning: signal?.reasoning })) {
      await notifyErrorFn(`헤파이스토스 pending reconcile 큐 기록 실패 — ${symbol} ${action}`, markError).catch(() => {});
    }
    return {
      success: false,
      pendingReconcile: false,
      code: 'pending_reconcile_enqueue_failed',
      verificationStatus: pendingOrder?.status || 'unknown',
      orderId: null,
      clientOrderId: pendingOrder?.clientOrderId || null,
      orderSymbol: pendingOrder?.orderSymbol || symbol,
      error: String(markError?.message || markError),
    };
  }

  await reconcilePositionsFn().catch(() => []);
  console.warn(`  ⚠️ ${symbol} orderId 미확인(clientOrderId=${pendingOrder?.clientOrderId || 'N/A'}) — pending reconcile 재시도 큐로 유지`);
  return {
    success: true,
    pendingReconcile: true,
    orderId: null,
    clientOrderId: pendingOrder?.clientOrderId || null,
    orderSymbol: pendingOrder?.orderSymbol || symbol,
    verificationStatus: pendingOrder?.status || 'unknown',
    queuedForRetry: true,
    error: pendingOrder?.recoveryError || null,
  };
}

/**
 * 단일 바이낸스 신호 실행
 * @param {object} signal  { id, symbol, action, amountUsdt, confidence, reasoning }
 */
export async function executeSignal(signal) {
  await initHubSecrets().catch(() => false);
  const preflight = await buildHephaestosExecutionPreflight(signal, {
    globalPaperMode: isPaperMode(),
    defaultTradeMode: getInvestmentTradeMode(),
    getCapitalConfig,
    getDynamicMinOrderAmount,
  });
  const { globalPaperMode, executionContext, signalTradeMode, capitalPolicy, minOrderUsdt } = preflight;
  const {
    signalId,
    symbol,
    action,
    amountUsdt,
    base,
    tag,
  } = executionContext;
  let { effectivePaperMode } = executionContext;

  // ★ SEC-004 가드: 네메시스 승인/실행 freshness 재검증 (BUY 전용 — SELL은 포지션 청산이므로 예외)
  if (action !== ACTIONS.SELL && !globalPaperMode) {
    const executionGuard = buildExecutionRiskApprovalGuard(signal, {
      market: 'binance',
      codePrefix: 'sec004',
      executionBlockedBy: 'hephaestos_entry_guard',
      paperMode: globalPaperMode,
    });
    if (!executionGuard.approved) {
      const reason = `SEC-004: ${executionGuard.reason}`;
      console.error(`  🛡️ [헤파이스토스] ${reason}`);
      if (signalId) {
        await db.updateSignalBlock(signalId, {
          status: SIGNAL_STATUS.FAILED,
          reason: reason.slice(0, 180),
          code: executionGuard.code,
          meta: executionGuard.meta,
        }).catch(() => {});
      }
      notifyTradeSkip({ symbol, action, reason }).catch(() => {});
      return { success: false, reason, code: executionGuard.code, riskApprovalExecution: executionGuard.meta?.risk_approval_execution || null };
    }
  }

  const exitReasonOverride = signal.exit_reason_override || null;
  const partialExitRatio = normalizePartialExitRatio(signal.partial_exit_ratio || signal.partialExitRatio);
  const qualityContext = buildSignalQualityContext(signal);
  const hephaestosRoleState = await getInvestmentAgentRoleState('hephaestos', 'binance').catch(() => null);
  const persistFailure = createSignalFailurePersister({
    db,
    signalId,
    symbol,
    action,
    amountUsdt,
    failedStatus: SIGNAL_STATUS.FAILED,
  });

  if (!isBinanceSymbol(symbol)) {
    const reason = `바이낸스 심볼이 아님: ${symbol}`;
    console.log(`  ⛔ [헤파이스토스] ${reason}`);
    await persistFailure(reason, {
      code: 'invalid_binance_symbol',
      meta: {
        invalidSymbol: symbol,
        tradeMode: signalTradeMode,
      },
    });
    notifyTradeSkip({ symbol, action, reason }).catch(() => {});
    return { success: false, reason };
  }

  console.log(`\n⚡ [헤파이스토스] ${symbol} ${action} $${amountUsdt} ${tag}`);

  /** @type {any} */
  let trade;
  let executionMeta = null;
  let executionClientOrderId = null;
  let executionSubmittedAtMs = null;

  try {

    if (action === ACTIONS.BUY) {
      let promoted = [];
      if (!globalPaperMode && signalTradeMode === 'normal') {
        promoted = await maybePromotePaperPositions({ reserveSlots: 1 }).catch(err => {
          console.warn(`  ⚠️ PAPER 포지션 승격 체크 실패: ${err.message}`);
          return [];
        });
        if (promoted.length > 0) {
          console.log(`  🔁 PAPER→LIVE 승격 완료: ${promoted.map(p => p.symbol).join(', ')}`);
        }
      }

      const safetyRejected = await runBuySafetyGuards({
        persistFailure,
        symbol,
        action,
        signalTradeMode,
        capitalPolicy,
        signalConfidence: Number(signal?.confidence || 0),
        checkCircuitBreaker,
        getOpenPositions,
        getMaxPositionsOverflowPolicy,
        getDailyTradeCount,
        formatDailyTradeLimitReason,
      });
      if (safetyRejected) return safetyRejected;

      const absorbed = await tryAbsorbUntrackedBalance({
        signalId,
        symbol,
        base,
        signalTradeMode,
        minOrderUsdt,
        effectivePaperMode,
      });
      if (absorbed) return absorbed;

      const buyReentryState = await checkBuyReentryGuards({
        persistFailure,
        symbol,
        action,
        signalTradeMode,
        effectivePaperMode,
      });
      if (buyReentryState?.success === false) return buyReentryState;

      // ── 미추적 BTC로 직접 매수 (BTC 페어 우선) ─────────────────────
      // 1순위: ETH/BTC 같은 직접 페어 → BTC→USDT 변환 없이 1회 수수료로 매수
      // 2순위: BTC 페어 없으면 BTC→USDT 전환 후 매수 (USDT 폴백)
      try {
        const btcResult = await _tryBuyWithBtcPair(symbol, base, signalId, signal, effectivePaperMode);
        if (btcResult) return btcResult;
      } catch (e) {
        if (shouldBlockUsdtFallbackAfterBtcPairError(e)) {
          throw e;
        }
        console.warn(`  ⚠️ BTC 직접 매수 실패 (주문 전 오류, USDT 전환 폴백): ${e.message}`);
      }

      // USDT 폴백: BTC 페어 없는 종목일 때 BTC → USDT → 매수
      try {
        const excludeBases = [
          base,
          ...promoted.map((position) => String(position.symbol || '').split('/')[0]).filter(Boolean),
        ];
        await _liquidateUntrackedForCapital(excludeBases, effectivePaperMode);
      } catch (e) {
        console.warn(`  ⚠️ 미추적 코인 청산 실패 (매수 계속): ${e.message}`);
      }

      const executionModeState = await resolveBuyExecutionMode({
        persistFailure,
        signalId,
        symbol,
        action,
        amountUsdt,
        signalTradeMode,
        globalPaperMode,
        capitalPolicy,
      });
      if (executionModeState?.success === false) return executionModeState;
      effectivePaperMode = executionModeState.effectivePaperMode;
      if (executionModeState.effectiveTradeMode && executionModeState.effectiveTradeMode !== signalTradeMode) {
        signalTradeMode = executionModeState.effectiveTradeMode;
        signal.trade_mode = signalTradeMode;
      }

      const buyReentryMultiplier = Number(buyReentryState?.reducedAmountMultiplier || 1);
      const executionModeMultiplier = Number(executionModeState.reducedAmountMultiplier || 1);
      const combinedReducedAmountMultiplier = [buyReentryMultiplier, executionModeMultiplier]
        .filter((value) => value > 0 && value < 1)
        .reduce((acc, value) => acc * value, 1);
      const combinedSoftGuards = [
        ...(buyReentryState?.softGuards || []),
        ...(executionModeState.softGuards || []),
      ];
      const combinedSoftGuardApplied = Boolean(
        buyReentryState?.softGuardApplied
        || executionModeState.softGuardApplied
      );

      if (effectivePaperMode) {
        const paperPositionAfterFallback = await db.getPaperPosition(symbol, 'binance', signalTradeMode);
        if (paperPositionAfterFallback) {
          const reason = `동일 ${signalTradeMode.toUpperCase()} PAPER 포지션 보유 중 — 추가매수 차단`;
          console.log(`  ⛔ [자본관리] ${reason}`);
          return rejectExecution({
            persistFailure,
            symbol,
            action,
            reason,
            code: 'paper_position_reentry_blocked',
            meta: {
              existingPaper: paperPositionAfterFallback.paper,
              requestedPaper: effectivePaperMode,
              tradeMode: signalTradeMode,
            },
            notify: 'skip',
          });
        }
      }

      const orderAmountState = await resolveBuyOrderAmount({
        persistFailure,
        symbol,
        action,
        amountUsdt,
        signal,
        effectivePaperMode,
        reducedAmountMultiplier: combinedReducedAmountMultiplier,
        softGuards: combinedSoftGuards,
      });
      if (orderAmountState?.success === false) return orderAmountState;
      const responsibilitySizing = applyResponsibilityExecutionSizing(orderAmountState.actualAmount, {
        action,
        confidence: Number(signal?.confidence || 0),
        responsibilityPlan: signal.existingResponsibilityPlan || null,
        executionPlan: signal.existingExecutionPlan || null,
      });
      const actualAmount = responsibilitySizing.amount;
      if (!effectivePaperMode && actualAmount < minOrderUsdt) {
        return rejectExecution({
          persistFailure,
          symbol,
          action,
          reason: `책임계획 반영 후 주문금액 ${actualAmount.toFixed(2)} < 최소 ${minOrderUsdt}`,
          code: 'position_sizing_rejected',
          meta: {
            minOrderUsdt,
            responsibilityExecutionMultiplier: responsibilitySizing.multiplier,
            responsibilityExecutionReason: responsibilitySizing.reason,
          },
          notify: 'skip',
        });
      }
      executionMeta = {
        softGuardApplied: combinedSoftGuardApplied,
        softGuards: combinedSoftGuards,
        reducedAmountMultiplier: combinedReducedAmountMultiplier,
        requestedAmountUsdt: Number(amountUsdt || 0),
        actualAmountUsdt: Number(actualAmount || 0),
        responsibilityExecutionMultiplier: responsibilitySizing.multiplier,
        responsibilityExecutionReason: responsibilitySizing.reason,
        agentRole: hephaestosRoleState
          ? {
              mission: hephaestosRoleState.mission || null,
              roleMode: hephaestosRoleState.role_mode || null,
              priority: Number(hephaestosRoleState.priority || 0),
            }
          : null,
      };

      if (responsibilitySizing.reason && responsibilitySizing.multiplier !== 1) {
        console.log(`  🎛️ [execution tone] ${symbol} 책임계획 반영 x${responsibilitySizing.multiplier.toFixed(2)} (${responsibilitySizing.reason})`);
      }

      executionSubmittedAtMs = Date.now();
      executionClientOrderId = !effectivePaperMode
        ? buildDeterministicClientOrderId({
            signalId,
            symbol,
            action: action || ACTIONS.BUY,
            scope: signalTradeMode || 'main',
          })
        : null;
      const order = await marketBuy(symbol, actualAmount, effectivePaperMode, {
        clientOrderId: executionClientOrderId,
        submittedAtMs: executionSubmittedAtMs,
      });
      const settledUsdt = Number(order.cost || (Number(order.filled || 0) * Number(order.price || order.average || 0)) || actualAmount);
      trade = {
        signalId,
        symbol,
        side:      'buy',
        amount:    order.filled,
        price:     order.price,
        totalUsdt: settledUsdt,
        paper:     effectivePaperMode,
        exchange:  'binance',
        tradeMode: signalTradeMode,
        ...qualityContext,
      };

      await persistBuyPosition({ symbol, order, effectivePaperMode, signalTradeMode });
      if (!effectivePaperMode) {
        await attachExecutionToPositionStrategyTracked({
          trade,
          signal,
          dryRun: false,
          requireOpenPosition: true,
        }).catch((error) => {
          console.warn(`  ⚠️ ${symbol} execution attach 실패: ${error.message}`);
        });
      }
      await syncCryptoStrategyExecutionState({
        symbol,
        tradeMode: signalTradeMode,
        lifecycleStatus: 'position_open',
        recommendation: 'HOLD',
        reasonCode: 'buy_executed',
        reason: 'BUY 체결 완료',
        trade,
        executionMission: executionMeta?.agentRole?.mission || null,
        updatedBy: 'hephaestos_buy_execute',
      });
      await applyBuyProtectiveExit({ trade, signal, order, effectivePaperMode, symbol });

    } else if (action === ACTIONS.SELL) {
      const sellContext = await resolveSellExecutionContext({
        persistFailure,
        signalId,
        symbol,
        signalTradeMode,
        globalPaperMode,
      });
      if (sellContext?.success === false) return sellContext;

      const sellAmountState = await resolveSellAmount({
        persistFailure,
        signalId,
        symbol,
        signalTradeMode,
        sellPaperMode: sellContext.sellPaperMode,
        livePosition: sellContext.livePosition,
        fallbackLivePosition: sellContext.fallbackLivePosition,
        paperPosition: sellContext.paperPosition,
        position: sellContext.position,
        freeBalance: sellContext.freeBalance,
        totalBalance: sellContext.totalBalance,
        partialExitRatio,
      });
      if (sellAmountState?.success === false) return sellAmountState;

      trade = await executeSellTrade({
        signalId,
        symbol,
        amount: sellAmountState.amount,
        sellPaperMode: sellContext.sellPaperMode,
        effectivePositionTradeMode: sellContext.effectivePositionTradeMode,
        position: sellContext.position,
        sourcePositionAmount: sellAmountState.sourcePositionAmount,
        partialExitRatio: sellAmountState.partialExitRatio,
        qualityContext,
      });

    } else {
      console.log(`  ⏸️ HOLD — 실행 없음`);
      await db.updateSignalStatus(signalId, SIGNAL_STATUS.EXECUTED);
      return { success: true };
    }

    await finalizeExecutedTrade({
      trade,
      signalId,
      signalTradeMode,
      capitalPolicy,
      exitReason: exitReasonOverride,
      executionMeta,
      hephaestosRoleState,
    });

    const doneTag = trade.paper ? '[PAPER]' : '[LIVE]';
    console.log(`  ✅ ${doneTag} 완료: ${trade.side} ${trade.amount?.toFixed(6)} @ $${trade.price?.toLocaleString()}`);
    return { success: true, trade };

  } catch (e) {
    let pendingSourceError = e;
    const syntheticBridgePendingEligible = (() => {
      const code = String(e?.code || '').trim().toLowerCase();
      if (code !== 'binance_mcp_mutating_bridge_failed') return false;
      return Boolean(executionClientOrderId) && (action === ACTIONS.BUY || action === ACTIONS.SELL);
    })();
    if (syntheticBridgePendingEligible) {
      const bridgeMeta = e?.meta && typeof e.meta === 'object' ? e.meta : {};
      const syntheticPendingError = /** @type {any} */ (new Error(
        `order_fill_unverified:${symbol}:bridge_error_after_submit:0:0`,
      ));
      syntheticPendingError.code = 'order_fill_unverified';
      syntheticPendingError.meta = {
        symbol,
        side: String(action || '').trim().toLowerCase() || null,
        orderSymbol: String(bridgeMeta.orderSymbol || bridgeMeta.symbol || symbol || '').trim().toUpperCase() || symbol,
        orderId: bridgeMeta.orderId || null,
        clientOrderId: bridgeMeta.clientOrderId || executionClientOrderId || null,
        status: String(bridgeMeta.status || 'bridge_error_after_submit').trim().toLowerCase() || 'bridge_error_after_submit',
        amount: Number(bridgeMeta.amount || 0),
        filled: Number(bridgeMeta.filled || 0),
        price: Number(bridgeMeta.price || 0),
        cost: Number(bridgeMeta.cost || 0),
        amountUsdt: Number(bridgeMeta.amountUsdt || amountUsdt || 0),
        submittedAtMs: executionSubmittedAtMs,
        source: 'binance_mcp_mutating_bridge_failed',
      };
      syntheticPendingError.cause = e;
      pendingSourceError = syntheticPendingError;
    }
    const pendingReconcileEligible = (() => {
      const code = String(pendingSourceError?.code || '').trim().toLowerCase();
      if (code === 'order_pending_fill_verification') return true;
      if (code === 'order_fill_unverified') {
        const meta = pendingSourceError?.meta && typeof pendingSourceError.meta === 'object' ? pendingSourceError.meta : {};
        return Boolean(meta?.orderId || meta?.clientOrderId);
      }
      return false;
    })();
    if (pendingReconcileEligible) {
      const pendingMeta = pendingSourceError?.meta && typeof pendingSourceError.meta === 'object' ? pendingSourceError.meta : {};
      const pendingOrderSymbol = String(pendingMeta.orderSymbol || pendingMeta.symbol || symbol || '').trim().toUpperCase() || symbol;
      const pendingOrder = {
        id: pendingMeta.orderId || null,
        orderId: pendingMeta.orderId || null,
        clientOrderId: pendingMeta.clientOrderId || null,
        orderSymbol: pendingOrderSymbol,
        submittedAtMs: toEpochMs(pendingMeta.submittedAtMs || pendingMeta.submittedAt || signal?.created_at || null),
        status: String(pendingMeta.status || 'unknown').trim().toLowerCase() || 'unknown',
        amount: Number(pendingMeta.amount || 0),
        filled: Number(pendingMeta.filled || 0),
        price: Number(pendingMeta.price || 0),
        average: Number(pendingMeta.price || 0),
        cost: Number(pendingMeta.cost || (Number(pendingMeta.filled || 0) * Number(pendingMeta.price || 0))),
      };
      let pendingFilled = Math.max(0, Number(pendingOrder.filled || 0));
      let pendingRawPrice = Math.max(0, Number(pendingOrder.price || pendingOrder.average || 0));
      let pendingRawCost = Math.max(0, Number(pendingOrder.cost || (pendingFilled * pendingRawPrice)));

      if (!pendingOrder.orderId && pendingOrder.clientOrderId) {
        try {
          const recoveredOrder = await fetchBinanceOrder({
            symbol: pendingOrder.orderSymbol || symbol,
            clientOrderId: pendingOrder.clientOrderId,
            submittedAtMs: pendingOrder.submittedAtMs || null,
            side: action === ACTIONS.BUY ? 'buy' : 'sell',
            allowAllOrdersFallback: true,
          });
          if (recoveredOrder && typeof recoveredOrder === 'object') {
            pendingOrder.orderId = extractExchangeOrderId(recoveredOrder) || null;
            pendingOrder.clientOrderId = extractClientOrderId(recoveredOrder) || pendingOrder.clientOrderId;
            pendingOrder.status = String(recoveredOrder.status || pendingOrder.status || 'unknown').trim().toLowerCase() || 'unknown';
            pendingOrder.amount = Number(recoveredOrder.amount || pendingOrder.amount || 0);
            pendingOrder.filled = Number(recoveredOrder.filled || pendingOrder.filled || 0);
            pendingOrder.price = Number(recoveredOrder.price || recoveredOrder.average || pendingOrder.price || 0);
            pendingOrder.average = Number(recoveredOrder.average || pendingOrder.price || 0);
            pendingOrder.cost = Number(recoveredOrder.cost || (pendingOrder.filled * pendingOrder.price) || 0);
          }
        } catch (recoveryError) {
          pendingOrder.recoveryError = String(recoveryError?.message || recoveryError).slice(0, 240);
          pendingOrder.recoveryErrorCode = String(recoveryError?.code || '').trim().toLowerCase() || null;
        }
        pendingFilled = Math.max(0, Number(pendingOrder.filled || 0));
        pendingRawPrice = Math.max(0, Number(pendingOrder.price || pendingOrder.average || 0));
        pendingRawCost = Math.max(0, Number(pendingOrder.cost || (pendingFilled * pendingRawPrice)));
      }

      if (!pendingOrder.orderId) {
        const hasClientOrderKey = Boolean(pendingOrder.clientOrderId);
        const definitiveLookupFailure = isDefinitiveBinanceOrderLookupError(pendingOrder.recoveryErrorCode);
        if (!hasClientOrderKey || definitiveLookupFailure) {
          const reason = definitiveLookupFailure
            ? `${symbol} clientOrderId 조회 결과가 확정 실패(${pendingOrder.recoveryErrorCode}) — 수동 정산 필요`
            : `${symbol} 주문 식별키(orderId/clientOrderId) 누락 — 자동 pending reconcile 불가 (수동 정산 필요)`;
          await persistFailure(reason, {
            code: 'manual_reconcile_required',
            meta: {
              exchange: 'binance',
              symbol,
              action,
              orderId: null,
              clientOrderId: pendingOrder.clientOrderId || null,
              orderSymbol: pendingOrder.orderSymbol || symbol,
              status: pendingOrder.status,
              amount: Number(pendingOrder.amount || 0),
              filled: pendingFilled,
              rawPrice: pendingRawPrice,
              rawCost: pendingRawCost,
              submittedAtMs: pendingOrder.submittedAtMs || null,
              recoveryError: pendingOrder.recoveryError || null,
              recoveryErrorCode: pendingOrder.recoveryErrorCode || null,
              source: pendingMeta?.source || null,
              orderAttempted: true,
            },
          });
          if (!isSyntheticOrTestSignalContext({ signalId, reasoning: signal?.reasoning })) {
            await notifyError(`헤파이스토스 pending reconcile 수동 정산 필요 — ${symbol} ${action}`, reason).catch(() => {});
          }
          return {
            success: false,
            manualReconcileRequired: true,
            code: 'manual_reconcile_required',
            verificationStatus: pendingOrder.status,
            clientOrderId: pendingOrder.clientOrderId || null,
            orderSymbol: pendingOrder.orderSymbol || symbol,
            error: reason,
          };
        }

        return enqueueClientOrderPendingRetry({
          signalId,
          symbol,
          action,
          amountUsdt,
          signalTradeMode,
          effectivePaperMode,
          pendingOrder,
          pendingMeta,
          pendingFilled,
          pendingRawPrice,
          pendingRawCost,
          persistFailure,
          signal,
        });
      }

      const pendingQuoteNormalized = await normalizePendingReconcileOrderUnits({
        signalSymbol: symbol,
        orderSymbol: pendingOrder.orderSymbol || symbol,
        filledQty: pendingFilled,
        price: pendingRawPrice,
        cost: pendingRawCost,
        pendingMeta,
        signalId,
      }).catch(async (quoteError) => {
        if (isPendingReconcileQuoteConversionError(quoteError)) {
          const reason = `${symbol} pending reconcile 단위 환산 불가 — 수동 정산 필요`;
          await persistFailure(reason, {
            code: 'manual_reconcile_required',
            meta: {
              exchange: 'binance',
              symbol,
              action,
              orderId: pendingOrder.orderId || null,
              clientOrderId: pendingOrder.clientOrderId || null,
              orderSymbol: pendingOrder.orderSymbol || symbol,
              status: pendingOrder.status,
              amount: Number(pendingOrder.amount || 0),
              filled: pendingFilled,
              rawPrice: pendingRawPrice,
              rawCost: pendingRawCost,
              conversionError: String(quoteError?.message || quoteError).slice(0, 240),
              ...(quoteError?.meta || {}),
            },
          });
          if (!isSyntheticOrTestSignalContext({ signalId, reasoning: signal?.reasoning })) {
            await notifyError(`헤파이스토스 pending reconcile 수동 정산 필요 — ${symbol} ${action}`, reason).catch(() => {});
          }
          return null;
        }
        throw quoteError;
      });
      if (!pendingQuoteNormalized) {
        return {
          success: false,
          manualReconcileRequired: true,
          code: 'manual_reconcile_required',
          verificationStatus: pendingOrder.status,
          orderId: pendingOrder.orderId || null,
          clientOrderId: pendingOrder.clientOrderId || null,
          orderSymbol: pendingOrder.orderSymbol || symbol,
          error: 'pending_reconcile_quote_conversion_failed',
        };
      }
      const pendingPrice = pendingQuoteNormalized.convertedPrice;
      const pendingCost = pendingQuoteNormalized.convertedCost;
      const orderStillOpen = await isBinanceOrderStillOpen(
        pendingOrder.orderSymbol || symbol,
        pendingOrder.orderId,
        pendingOrder.clientOrderId || null,
      ).catch(() => null);
      const state = resolveBinancePendingQueueState({
        status: pendingOrder.status,
        filledQty: pendingFilled,
        expectedQty: Number(pendingOrder.amount || 0),
        orderStillOpen,
      });
      const side = action === ACTIONS.BUY ? 'buy' : 'sell';
      const appliedSnapshot = await getPendingReconcileAppliedSnapshot({
        signalId,
        symbol,
        side,
        orderId: pendingOrder.orderId || null,
        clientOrderId: pendingOrder.clientOrderId || null,
      });
      const effectiveRecordedFilledQty = Math.max(0, Number(appliedSnapshot.appliedFilledQty || 0));
      const effectiveRecordedCost = Math.max(0, Number(appliedSnapshot.appliedCost || 0));
      const payload = {
        signal,
        signalId,
        symbol,
        action,
        amountUsdt,
        tradeMode: signalTradeMode,
        paperMode: effectivePaperMode,
        orderId: pendingOrder.orderId || null,
        clientOrderId: pendingOrder.clientOrderId || null,
        orderSymbol: pendingOrder.orderSymbol || symbol,
        submittedAtMs: pendingOrder.submittedAtMs || null,
        pendingMeta,
        expectedQty: Number(pendingOrder.amount || 0),
        recordedFilledQty: effectiveRecordedFilledQty,
        recordedCost: effectiveRecordedCost,
      };
      const progress = computeBinancePendingRecordedProgress({
        exchangeFilledQty: pendingFilled,
        exchangeCost: pendingCost,
        exchangePrice: pendingPrice,
        recordedFilledQty: effectiveRecordedFilledQty,
        recordedCost: effectiveRecordedCost,
        applySucceeded: true,
      });

      let applyError = null;
      let applyResult = null;
      let applySucceeded = progress.deltaFilledQty <= BINANCE_PENDING_RECONCILE_EPSILON;
      if (progress.deltaFilledQty > BINANCE_PENDING_RECONCILE_EPSILON) {
        try {
          applyResult = await applyBinancePendingReconcileDelta({
            payload,
            deltaFilledQty: progress.deltaFilledQty,
            deltaCost: progress.deltaCost,
            orderPrice: pendingPrice,
            stateCode: state.code,
          });
          applySucceeded = Boolean(applyResult?.applied);
        } catch (pendingApplyError) {
          applyError = pendingApplyError;
        }
      }

      const persistedProgress = computeBinancePendingRecordedProgress({
        exchangeFilledQty: pendingFilled,
        exchangeCost: pendingCost,
        exchangePrice: pendingPrice,
        recordedFilledQty: effectiveRecordedFilledQty,
        recordedCost: effectiveRecordedCost,
        applySucceeded: !applyError && applySucceeded,
      });
      let pendingState = null;
      try {
        pendingState = await markBinanceOrderPendingReconcileSignal(signalId, {
          symbol,
          action,
          amountUsdt,
          tradeMode: applyResult?.tradeModeUsed || signalTradeMode,
          paperMode: effectivePaperMode,
          orderMeta: {
            orderId: pendingOrder.orderId,
            clientOrderId: pendingOrder.clientOrderId || null,
            orderSymbol: pendingOrder.orderSymbol || symbol,
            submittedAtMs: pendingOrder.submittedAtMs || null,
            status: pendingOrder.status,
            amount: pendingOrder.amount,
            filled: pendingFilled,
            price: pendingPrice,
            cost: pendingCost,
            rawPrice: pendingQuoteNormalized.rawPrice,
            rawCost: pendingQuoteNormalized.rawCost,
            quoteConversionApplied: pendingQuoteNormalized.conversionApplied,
            quoteConversionRate: pendingQuoteNormalized.conversionRate,
            quoteConversionPair: pendingQuoteNormalized.conversionPair,
            quoteAsset: pendingQuoteNormalized.orderQuote,
            signalQuoteAsset: pendingQuoteNormalized.signalQuote,
            btcReferencePrice: pendingQuoteNormalized.conversionRate,
          },
          existingRecordedFilledQty: effectiveRecordedFilledQty,
          existingRecordedCost: effectiveRecordedCost,
          appliedFilledQty: persistedProgress.appliedFilledQty,
          appliedCost: persistedProgress.appliedCost,
          reconcileError: applyError ? String(applyError?.message || applyError) : null,
          orderStillOpen,
          pendingMeta: payload.pendingMeta,
        });
      } catch (markError) {
        await notifyError(`헤파이스토스 pending reconcile meta 저장 실패 — ${symbol} ${action}`, markError).catch(() => {});
        return {
          success: false,
          pendingReconcile: true,
          orderId: pendingOrder.orderId || null,
          clientOrderId: pendingOrder.clientOrderId || null,
          verificationStatus: pendingOrder.status,
          error: `pending_reconcile_mark_failed:${markError?.message || markError}`,
        };
      }

      if (!applyError && progress.deltaFilledQty <= BINANCE_PENDING_RECONCILE_EPSILON && pendingState?.code === 'order_reconciled') {
        await syncPendingReconcileSnapshotState({
          payload,
          tradeMode: applyResult?.tradeModeUsed || signalTradeMode,
          stateCode: pendingState.code,
        }).catch(() => null);
      }

      await reconcileLivePositionsWithBrokerBalance().catch(() => []);
      console.warn(`  ⚠️ ${symbol} 주문 접수 후 체결 확정 대기 — pending reconcile 큐로 이관 (orderId=${pendingOrder.orderId || 'N/A'})`);
      return {
        success: true,
        pendingReconcile: true,
        trade: applyResult?.trade || null,
        applyFailed: Boolean(applyError),
        orderId: pendingOrder.orderId || null,
        clientOrderId: pendingOrder.clientOrderId || null,
        orderSymbol: pendingOrder.orderSymbol || symbol,
        verificationStatus: pendingOrder.status,
        error: applyError ? String(applyError?.message || applyError) : null,
      };
    }

    console.error(`  ❌ 실행 오류: ${pendingSourceError.message}`);
    const failureCode = pendingSourceError?.code === 'sell_amount_below_minimum'
      ? 'sell_amount_below_minimum'
      : 'broker_execution_error';
    await persistFailure(pendingSourceError.message, {
      code: failureCode,
      meta: {
        error: String(pendingSourceError.message).slice(0, 240),
        ...(pendingSourceError?.meta || {}),
      },
    });
    await notifyError(`헤파이스토스 - ${symbol} ${action}`, pendingSourceError);
    return { success: false, error: pendingSourceError.message };
  }
}

/**
 * 대기 중인 바이낸스 신호 전체 처리
 */
export async function processAllPendingSignals() {
  const { tradeModes } = await preparePendingSignalProcessing();
  const allResults = [];
  for (const tradeMode of tradeModes) {
    const signals = await db.getApprovedSignals('binance', tradeMode);
    const results = await runPendingSignalBatch(signals, { tradeMode, delayMs: 500 });
    allResults.push(...results);
  }
  return allResults;
}

// CLI 실행
if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: async () => {
      await db.initSchema();
      await initHubSecrets().catch(() => false);
    },
    run: async () => {
      const args              = process.argv.slice(2);
      const actionArg         = args.find(a => a.startsWith('--action='))?.split('=')[1];
      const symbolArg         = args.find(a => a.startsWith('--symbol='))?.split('=')[1];
      const amountArg         = args.find(a => a.startsWith('--amount='))?.split('=')[1];
      const inspectPromotions = args.includes('--inspect-promotions');
      const simulateBuy       = args.includes('--simulate-buy');

      if (inspectPromotions) {
        return inspectPromotionCandidates();
      }
      if (simulateBuy && symbolArg) {
        return simulateBuyDecision({
          symbol: symbolArg.toUpperCase(),
          amountUsdt: parseFloat(amountArg || '100'),
        });
      }
      if (actionArg && symbolArg) {
        return executeSignal({
          id:               `CLI-${Date.now()}`,
          symbol:           symbolArg.toUpperCase(),
          action:           actionArg.toUpperCase(),
          amountUsdt:       parseFloat(amountArg || '100'),
          confidence:       0.7,
          reasoning:        'CLI 수동 실행',
          nemesis_verdict:  'approved', // SEC-004: CLI 어드민 직접 실행 = 마스터 승인
          approved_at:      new Date().toISOString(),
        });
      }
      return processAllPendingSignals();
    },
    onSuccess: async (result) => {
      console.log('완료:', JSON.stringify(result));
    },
    errorPrefix: '❌ 헤파이스토스 오류:',
  });
}
