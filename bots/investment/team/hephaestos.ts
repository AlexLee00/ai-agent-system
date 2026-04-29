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
  createPendingJournalRepairQueueProcessor,
  createPendingReconcileQueueProcessor,
} from './hephaestos/pending-reconcile-runner.ts';
import { createPendingReconcileLedger } from './hephaestos/pending-reconcile-ledger.ts';
import { createBinanceExecutionReconcileHandler } from './hephaestos/binance-order-reconcile.ts';
import { createRiskAndCapitalGatePolicy } from './hephaestos/risk-and-capital-gates.ts';
import { createPortfolioPositionDelta } from './hephaestos/portfolio-position-delta.ts';
import { createTelegramTradeAlerts } from './hephaestos/telegram-trade-alerts.ts';
import { createMarketSignalPersistence } from './hephaestos/market-signal-persistence.ts';
import { createSellExecutionResolution } from './hephaestos/sell-execution-resolution.ts';
import { applyResponsibilityExecutionSizing } from './hephaestos/execution-responsibility-sizing.ts';
import {
  createBuyProtectiveExitApplier,
  createStrategyExecutionStateSync,
} from './hephaestos/execution-side-effects.ts';
import { createPaperPromotionPolicy } from './hephaestos/paper-promotion.ts';
import {
  isEffectivePartialExit,
  normalizePartialExitRatio,
} from './hephaestos/partial-exit-policy.ts';
import { createProtectiveExitPolicy } from './hephaestos/protective-exit.ts';
import { createUntrackedCapitalPolicy } from './hephaestos/untracked-capital.ts';
import { createBtcPairDirectBuyPolicy } from './hephaestos/btc-pair-direct-buy.ts';
import { createBuyReentryGuardPolicy } from './hephaestos/buy-reentry-guards.ts';
import { createHephaestosExchangeHelpers } from './hephaestos/exchange-helpers.ts';
import { createLivePositionReconcile } from './hephaestos/live-position-reconcile.ts';
import { createMarketOrderExecution } from './hephaestos/market-order-execution.ts';
import { createPendingSignalProcessing } from './hephaestos/pending-signal-processing.ts';
import {
  createPendingReconcileContext,
  delay,
  isBinanceSymbol,
  isDefinitiveBinanceOrderLookupError,
  isSyntheticOrTestSignalContext,
  parseSignalBlockMeta,
  shouldBlockUsdtFallbackAfterBtcPairError,
} from './hephaestos/pending-reconcile-context.ts';
import { createHephaestosSignalExecutor } from './hephaestos/signal-executor.ts';
import { buildSellBalancePolicy } from './hephaestos/sell-balance-policy.ts';
export { buildHephaestosExecutionContext } from './hephaestos/execution-context.ts';
export { buildHephaestosExecutionPreflight } from './hephaestos/execution-preflight.ts';
export { createSignalFailurePersister, rejectExecution } from './hephaestos/execution-failure.ts';
export { buildGuardTelemetryMeta, runBuySafetyGuards } from './hephaestos/execution-guards.ts';
export {
  buildPendingReconcileDeltaIncidentLink,
  escapePendingReconcileLikePattern,
  normalizePendingReconcileTradeRow,
} from './hephaestos/pending-reconcile-core.ts';

const BINANCE_PENDING_RECONCILE_JOURNAL_RETRY_DELAY_MS = 30_000;
export { shouldBlockUsdtFallbackAfterBtcPairError } from './hephaestos/pending-reconcile-context.ts';

function getExchange() {
  return getBinanceExchange();
}

const exchangeHelpers = createHephaestosExchangeHelpers({
  getExchange,
  extractExchangeOrderId,
  extractClientOrderId,
});
const {
  roundSellAmount,
  extractOrderId,
  toEpochMs,
  buildDeterministicClientOrderId,
  fetchFreeAssetBalance,
  fetchAssetBalances,
  cancelOpenSellOrdersForSymbol,
} = exchangeHelpers;

const pendingReconcileContext = createPendingReconcileContext({
  db,
  normalizePendingReconcileOrderUnitsBase,
  quotePriceResolver: fetchTicker,
  toEpochMs,
});
const {
  loadSignalPendingReconcileMeta,
  normalizePendingReconcileOrderUnits,
  buildBtcPairPendingReconcileError,
} = pendingReconcileContext;

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

const marketOrderExecution = createMarketOrderExecution({
  fetchTicker,
  getExchange,
  roundSellAmount,
  createBinanceMarketBuy,
  createBinanceMarketSell,
  normalizeBinanceMarketOrderExecution,
  getBinanceOpenOrders,
  extractExchangeOrderId,
  extractClientOrderId,
});
const {
  marketBuy,
  marketSell,
  getMinSellAmount,
  isBinanceOrderStillOpen,
} = marketOrderExecution;

export function buildBinancePendingReconcilePayload(signal = {}) {
  return buildBinancePendingReconcilePayloadBase(signal, {
    defaultTradeMode: getInvestmentTradeMode(),
  });
}

const marketSignalPersistence = createMarketSignalPersistence({
  SIGNAL_STATUS,
  db,
  getInvestmentExecutionRuntimeConfig,
});

const {
  syncCryptoStrategyExecutionState,
} = createStrategyExecutionStateSync({ db });

const pendingReconcileLedger = createPendingReconcileLedger({
  ACTIONS,
  SIGNAL_STATUS,
  db,
  notifyError,
  loadSignalPendingReconcileMeta,
  buildSignalQualityContext,
  normalizePartialExitRatio,
  recordExecutedTradeJournal,
  syncCryptoStrategyExecutionState,
  journalRetryDelayMs: BINANCE_PENDING_RECONCILE_JOURNAL_RETRY_DELAY_MS,
});

const {
  getPendingReconcileAppliedSnapshot,
  loadBinancePendingReconcileTrade,
  markBinancePendingReconcileJournalState,
  ensurePendingReconcileJournalRecorded,
  applyBinancePendingReconcileDelta,
  syncPendingReconcileSnapshotState,
  markBinanceOrderPendingReconcileSignal,
} = pendingReconcileLedger;

const processBinancePendingReconcileQueueImpl = createPendingReconcileQueueProcessor({
  ACTIONS,
  SIGNAL_STATUS,
  db,
  delay,
  notifyError,
  parseSignalBlockMeta,
  isSyntheticOrTestSignalContext,
  buildBinancePendingReconcilePayload,
  fetchBinanceOrder,
  isBinanceOrderStillOpen,
  applyBinancePendingReconcileDelta,
  markBinanceOrderPendingReconcileSignal,
  getPendingReconcileAppliedSnapshot,
  normalizePendingReconcileOrderUnits,
  syncPendingReconcileSnapshotState,
});

export async function processBinancePendingReconcileQueue(options = {}) {
  return processBinancePendingReconcileQueueImpl(options);
}

const processBinancePendingJournalRepairQueueImpl = createPendingJournalRepairQueueProcessor({
  ACTIONS,
  db,
  delay,
  buildBinancePendingReconcilePayload,
  loadBinancePendingReconcileTrade,
  ensurePendingReconcileJournalRecorded,
  markBinancePendingReconcileJournalState,
});

export async function processBinancePendingJournalRepairQueue(options = {}) {
  return processBinancePendingJournalRepairQueueImpl(options);
}

const livePositionReconcile = createLivePositionReconcile({
  db,
  getExchange,
  fetchTicker,
  closeOpenJournalForSymbol,
});
const {
  reconcileLivePositionsWithBrokerBalance,
} = livePositionReconcile;

const binanceExecutionReconcileHandler = createBinanceExecutionReconcileHandler({
  ACTIONS,
  BINANCE_PENDING_RECONCILE_EPSILON,
  computeBinancePendingRecordedProgress,
  extractClientOrderId,
  extractExchangeOrderId,
  fetchBinanceOrder,
  isDefinitiveBinanceOrderLookupError,
  isPendingReconcileQuoteConversionError,
  normalizePendingReconcileOrderUnits,
  isSyntheticOrTestSignalContext,
  notifyError,
  toEpochMs,
  isBinanceOrderStillOpen,
  resolveBinancePendingQueueState,
  getPendingReconcileAppliedSnapshot,
  applyBinancePendingReconcileDelta,
  markBinanceOrderPendingReconcileSignal,
  syncPendingReconcileSnapshotState,
  reconcileLivePositionsWithBrokerBalance,
});

const riskAndCapitalGates = createRiskAndCapitalGatePolicy({
  getInvestmentExecutionRuntimeConfig,
  preTradeCheck,
  db,
  notifyTradeSkip,
  getOpenPositions,
  findAnyLivePosition,
  fetchTicker,
  calculatePositionSize,
  getDynamicMinOrderAmount,
  getInvestmentTradeMode,
});

const buyReentryGuardPolicy = createBuyReentryGuardPolicy({
  db,
  findAnyLivePosition,
  isSameDaySymbolReentryBlockEnabled,
  getValidationLiveReentrySofteningPolicy: () => riskAndCapitalGates.getValidationLiveReentrySofteningPolicy(),
  rejectExecution,
  buildGuardTelemetryMeta,
});
const {
  checkBuyReentryGuards,
} = buyReentryGuardPolicy;

const protectiveExitPolicy = createProtectiveExitPolicy({
  getExchange,
  fetchFreeAssetBalance,
  extractOrderId,
});

const {
  buildProtectionSnapshot,
  isStopLossOnlyMode,
  normalizeProtectiveExitPrices,
  placeBinanceProtectiveExit,
} = protectiveExitPolicy;

const {
  applyBuyProtectiveExit,
} = createBuyProtectiveExitApplier({
  notifyError,
  normalizeProtectiveExitPrices,
  placeBinanceProtectiveExit,
  buildProtectionSnapshot,
  isStopLossOnlyMode,
});

const untrackedCapitalPolicy = createUntrackedCapitalPolicy({
  SIGNAL_STATUS,
  db,
  getExchange,
  getCapitalConfig,
  getDynamicMinOrderAmount,
  getInvestmentTradeMode,
  fetchTicker,
  marketSell,
  normalizeProtectiveExitPrices,
  buildProtectionSnapshot,
  placeBinanceProtectiveExit,
  isStopLossOnlyMode,
  notifyError,
  notifyTrade,
});

const {
  tryConvertResidualDustToUsdt,
  tryAbsorbUntrackedBalance,
  liquidateUntrackedForCapital,
} = untrackedCapitalPolicy;

const btcPairDirectBuyPolicy = createBtcPairDirectBuyPolicy({
  ACTIONS,
  SIGNAL_STATUS,
  db,
  getInvestmentTradeMode,
  getCapitalConfig,
  getDynamicMinOrderAmount,
  getExchange,
  fetchTicker,
  buildDeterministicClientOrderId,
  normalizeBinanceMarketOrderExecution,
  buildBtcPairPendingReconcileError,
  extractExchangeOrderId,
  extractClientOrderId,
  normalizeProtectiveExitPrices,
  buildProtectionSnapshot,
  placeBinanceProtectiveExit,
  isStopLossOnlyMode,
  notifyError,
  notifyTrade,
  buildSignalQualityContext,
});

const { tryBuyWithBtcPair: _tryBuyWithBtcPair } = btcPairDirectBuyPolicy;

const portfolioPositionDelta = createPortfolioPositionDelta({
  ACTIONS,
  SIGNAL_STATUS,
  db,
  journalDb,
  getInvestmentTradeMode,
  fetchAssetBalances,
  marketSell,
  buildDeterministicClientOrderId,
  normalizePartialExitRatio,
  isEffectivePartialExit,
  syncCryptoStrategyExecutionState,
  tryConvertResidualDustToUsdt,
});

const telegramTradeAlerts = createTelegramTradeAlerts({
  SIGNAL_STATUS,
  db,
  journalDb,
  notifySettlement,
  notifyTrade,
  notifyJournalEntry,
  getInvestmentTradeMode,
  normalizePartialExitRatio,
  isEffectivePartialExit,
  getAvailableBalance,
  getOpenPositions,
  getDailyPnL,
  syncPositionsAtMarketOpen,
});

const sellExecutionResolution = createSellExecutionResolution({
  db,
  getExchange,
  findAnyLivePosition,
  normalizePartialExitRatio,
  cancelOpenSellOrdersForSymbol,
  fetchAssetBalances,
  buildSellBalancePolicy,
  reconcileOpenJournalToTrackedAmount,
  getMinSellAmount,
  roundSellAmount,
  cleanupDustLivePosition,
});

const paperPromotionPolicy = createPaperPromotionPolicy({
  getCapitalConfig,
  getDynamicMinOrderAmount,
  getAvailableUSDT,
  getOpenPositions,
  preTradeCheck,
  isCapitalShortageReason,
  db,
  journalDb,
  marketBuy,
  closeOpenJournalForSymbol,
  notifyJournalEntry,
  notifyTrade,
  fetchTicker,
  calculatePositionSize,
  isPaperMode,
  getInvestmentTradeMode,
});

async function cleanupDustLivePosition(symbol, position, tradeMode, meta = {}) {
  return portfolioPositionDelta.cleanupDustLivePosition(symbol, position, tradeMode, meta);
}

function isCapitalShortageReason(reason = '') {
  return riskAndCapitalGates.isCapitalShortageReason(reason);
}

function buildSignalQualityContext(signal = null) {
  return marketSignalPersistence.buildSignalQualityContext(signal);
}

async function reconcileOpenJournalToTrackedAmount(symbol, isPaper, trackedAmount, tradeMode = null) {
  return portfolioPositionDelta.reconcileOpenJournalToTrackedAmount(symbol, isPaper, trackedAmount, tradeMode);
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
  return telegramTradeAlerts.closeOpenJournalForSymbol(symbol, isPaper, exitPrice, exitValue, exitReason, tradeMode, {
    executionOrigin,
    qualityFlag,
    excludeFromLearning,
    incidentLink,
  });
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
  return telegramTradeAlerts.settleOpenJournalForSell(symbol, isPaper, exitPrice, exitValue, exitReason, tradeMode, {
    partialExitRatio,
    soldAmount,
    signalId,
    executionOrigin,
    qualityFlag,
    excludeFromLearning,
    incidentLink,
  });
}

async function findAnyLivePosition(symbol, exchange = 'binance') {
  return db.getPosition(symbol, { exchange, paper: false });
}

async function cleanupStalePendingSignals({
  exchange = 'binance',
  tradeMode = 'normal',
} = {}) {
  return marketSignalPersistence.cleanupStalePendingSignals({ exchange, tradeMode });
}

async function persistBuyPosition({ symbol, order, effectivePaperMode, signalTradeMode }) {
  return portfolioPositionDelta.persistBuyPosition({ symbol, order, effectivePaperMode, signalTradeMode });
}

async function notifyExecutedTrade({ trade, signalTradeMode, capitalPolicy }) {
  return telegramTradeAlerts.notifyExecutedTrade({ trade, signalTradeMode, capitalPolicy });
}

async function recordExecutedTradeJournal({ trade, signalId, exitReason }) {
  return telegramTradeAlerts.recordExecutedTradeJournal({ trade, signalId, exitReason });
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
  return telegramTradeAlerts.finalizeExecutedTrade({
    trade,
    signalId,
    signalTradeMode,
    capitalPolicy,
    exitReason,
    executionMeta,
    hephaestosRoleState,
  });
}

async function resolveSellExecutionContext({
  persistFailure,
  symbol,
  signalTradeMode,
  globalPaperMode,
}) {
  return sellExecutionResolution.resolveSellExecutionContext({
    persistFailure,
    symbol,
    signalTradeMode,
    globalPaperMode,
  });
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
  return sellExecutionResolution.resolveSellAmount({
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
    partialExitRatio,
  });
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
  return portfolioPositionDelta.executeSellTrade({
    signalId,
    symbol,
    amount,
    sellPaperMode,
    effectivePositionTradeMode,
    position,
    sourcePositionAmount,
    partialExitRatio,
    qualityContext,
  });
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
  return riskAndCapitalGates.resolveBuyExecutionMode({
    persistFailure,
    signalId,
    symbol,
    action,
    amountUsdt,
    signalTradeMode,
    globalPaperMode,
    capitalPolicy,
  });
}

function getNormalToValidationFallbackPolicy() {
  return riskAndCapitalGates.getNormalToValidationFallbackPolicy();
}

function getMaxPositionsOverflowPolicy(signalTradeMode = 'normal') {
  return riskAndCapitalGates.getMaxPositionsOverflowPolicy(signalTradeMode);
}

function getValidationLiveReentrySofteningPolicy() {
  return riskAndCapitalGates.getValidationLiveReentrySofteningPolicy();
}

function classifyValidationFallbackGuard(reason = '') {
  return riskAndCapitalGates.classifyValidationFallbackGuard(reason);
}

async function maybeFallbackToValidationLane({
  symbol,
  action,
  amountUsdt,
  reason,
  signalTradeMode,
}) {
  return riskAndCapitalGates.maybeFallbackToValidationLane({
    symbol,
    action,
    amountUsdt,
    reason,
    signalTradeMode,
  });
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
  return riskAndCapitalGates.resolveBuyOrderAmount({
    persistFailure,
    symbol,
    action,
    amountUsdt,
    signal,
    effectivePaperMode,
    reducedAmountMultiplier,
    softGuards,
  });
}

async function maybePromotePaperPositions({ reserveSlots = 0 } = {}) {
  return paperPromotionPolicy.maybePromotePaperPositions({ reserveSlots });
}

export async function inspectPromotionCandidates() {
  return paperPromotionPolicy.inspectPromotionCandidates();
}

export async function simulateBuyDecision({ symbol, amountUsdt = 100 }) {
  return paperPromotionPolicy.simulateBuyDecision({ symbol, amountUsdt });
}

// BTC 직접 페어 매수 정책은 team/hephaestos/btc-pair-direct-buy.ts로 분리.

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
  return binanceExecutionReconcileHandler.enqueueClientOrderPendingRetry({
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
    deps,
  });
}

/**
 * 단일 바이낸스 신호 실행
 * @param {object} signal  { id, symbol, action, amountUsdt, confidence, reasoning }
 */
const signalExecutor = createHephaestosSignalExecutor({
  ACTIONS,
  SIGNAL_STATUS,
  db,
  initHubSecrets,
  isPaperMode,
  getInvestmentTradeMode,
  getCapitalConfig,
  getDynamicMinOrderAmount,
  buildHephaestosExecutionPreflight,
  buildExecutionRiskApprovalGuard,
  notifyTradeSkip,
  normalizePartialExitRatio,
  buildSignalQualityContext,
  getInvestmentAgentRoleState,
  createSignalFailurePersister,
  isBinanceSymbol,
  maybePromotePaperPositions,
  runBuySafetyGuards,
  checkCircuitBreaker,
  getOpenPositions,
  getMaxPositionsOverflowPolicy,
  getDailyTradeCount,
  formatDailyTradeLimitReason,
  tryAbsorbUntrackedBalance,
  checkBuyReentryGuards,
  _tryBuyWithBtcPair,
  shouldBlockUsdtFallbackAfterBtcPairError,
  liquidateUntrackedForCapital,
  resolveBuyExecutionMode,
  rejectExecution,
  resolveBuyOrderAmount,
  applyResponsibilityExecutionSizing,
  buildDeterministicClientOrderId,
  marketBuy,
  persistBuyPosition,
  attachExecutionToPositionStrategyTracked,
  syncCryptoStrategyExecutionState,
  applyBuyProtectiveExit,
  resolveSellExecutionContext,
  resolveSellAmount,
  executeSellTrade,
  finalizeExecutedTrade,
  binanceExecutionReconcileHandler,
  notifyError,
});
export const { executeSignal } = signalExecutor;

const pendingSignalProcessing = createPendingSignalProcessing({
  db,
  initHubSecrets,
  getInvestmentTradeMode,
  processBinancePendingReconcileQueue,
  processBinancePendingJournalRepairQueue,
  syncPositionsAtMarketOpen,
  cleanupStalePendingSignals,
  reconcileLivePositionsWithBrokerBalance,
  executeSignal,
  delay,
});

/**
 * 대기 중인 바이낸스 신호 전체 처리
 */
export async function processAllPendingSignals() {
  return pendingSignalProcessing.processAllPendingSignals();
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
