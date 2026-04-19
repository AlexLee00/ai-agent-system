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

import ccxt from 'ccxt';
import * as db from '../shared/db.ts';
import * as journalDb from '../shared/trade-journal-db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { loadSecrets, initHubSecrets, isPaperMode, getInvestmentTradeMode } from '../shared/secrets.ts';
import { isSameDaySymbolReentryBlockEnabled } from '../shared/runtime-config.ts';
import { SIGNAL_STATUS, ACTIONS } from '../shared/signal.ts';
import { notifyTrade, notifyError, notifyJournalEntry, notifyTradeSkip, notifyCircuitBreaker, notifySettlement } from '../shared/report.ts';
import { preTradeCheck, calculatePositionSize, getAvailableBalance, getAvailableUSDT, getOpenPositions, getDailyPnL, getDailyTradeCount, checkCircuitBreaker, getCapitalConfig, formatDailyTradeLimitReason, getDynamicMinOrderAmount } from '../shared/capital-manager.ts';

// ─── 심볼 유효성 ────────────────────────────────────────────────────

const BINANCE_SYMBOL_RE = /^[A-Z0-9]+\/USDT$/;

function isBinanceSymbol(symbol) {
  return BINANCE_SYMBOL_RE.test(symbol);
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── CCXT 바이낸스 클라이언트 (lazy init) ──────────────────────────

let _exchange = null;

function getExchange() {
  if (_exchange) return _exchange;
  const secrets = loadSecrets();
  _exchange = new ccxt.binance({
    apiKey: secrets.binance_api_key || '',
    secret: secrets.binance_api_secret || '',
    options: { defaultType: 'spot' },
  });
  return _exchange;
}

/**
 * 바이낸스 USDT 가용 잔고 조회 (LU-004: 잔고 부족 알림용)
 */
export async function fetchUsdtBalance() {
  const ex  = getExchange();
  const bal = await ex.fetchBalance();
  return bal.free?.USDT || 0;
}

/**
 * 현재가 조회 (PAPER_MODE에서도 사용)
 */
export async function fetchTicker(symbol) {
  const ex = getExchange();
  const ticker = await ex.fetchTicker(symbol);
  return ticker.last;
}

/**
 * 시장가 매수 (PAPER_MODE: 모의 주문)
 */
async function marketBuy(symbol, amountUsdt, paperMode) {
  if (paperMode) {
    const price  = await fetchTicker(symbol).catch(() => 0);
    const filled = price > 0 ? amountUsdt / price : 0;
    console.log(`  📄 [헤파이스토스] PAPER BUY ${symbol} $${amountUsdt} @ ~$${price?.toLocaleString()}`);
    return { filled, price, dryRun: true };
  }
  const ex = getExchange();
  return await ex.createOrder(symbol, 'market', 'buy', undefined, undefined, { quoteOrderQty: amountUsdt });
}

/**
 * 시장가 매도 (PAPER_MODE: 모의 주문)
 */
async function marketSell(symbol, amount, paperMode) {
  if (paperMode) {
    const price     = await fetchTicker(symbol).catch(() => 0);
    const totalUsdt = amount * price;
    console.log(`  📄 [헤파이스토스] PAPER SELL ${symbol} ${amount} @ ~$${price?.toLocaleString()}`);
    return { amount, price, totalUsdt, dryRun: true };
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
  return await ex.createOrder(symbol, 'market', 'sell', normalizedAmount);
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
  return orderLike.id?.toString?.()
    ?? orderLike.orderId?.toString?.()
    ?? orderLike.clientOrderId?.toString?.()
    ?? null;
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

async function closeOpenJournalForSymbol(symbol, isPaper, exitPrice, exitValue, exitReason, tradeMode = null) {
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
  }).catch(() => {});
}

async function findAnyLivePosition(symbol, exchange = 'binance') {
  return db.getPosition(symbol, { exchange, paper: false });
}

async function preparePendingSignalProcessing() {
  await initHubSecrets().catch(() => false);
  const tradeMode = getInvestmentTradeMode();
  const reconciled = await reconcileLivePositionsWithBrokerBalance().catch((error) => {
    console.warn(`[헤파이스토스] 실지갑 포지션 동기화 실패: ${error.message}`);
    return [];
  });
  if (reconciled.length > 0) {
    console.log(`[헤파이스토스] 실지갑 포지션 동기화 ${reconciled.length}건`);
  }
  return { tradeMode, reconciled };
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

async function rejectExecution({
  persistFailure,
  symbol,
  action,
  reason,
  code = 'broker_execution_error',
  meta = {},
  notify = 'skip',
}) {
  await persistFailure(reason, { code, meta });
  if (notify === 'circuit') {
    notifyCircuitBreaker({ reason, type: meta.circuitType ?? null }).catch(() => {});
  } else if (notify === 'skip') {
    notifyTradeSkip({
      symbol,
      action,
      reason,
      openPositions: meta.openPositions,
      maxPositions: meta.maxPositions,
    }).catch(() => {});
  }
  return { success: false, reason };
}

function buildGuardTelemetryMeta(symbol, action, signalTradeMode, meta = {}, extras = {}) {
  return {
    symbol,
    side: String(action || 'BUY').toLowerCase(),
    tradeMode: signalTradeMode,
    guardKind: extras.guardKind || meta.guardKind || null,
    pressureSource: extras.pressureSource || meta.pressureSource || null,
    ...meta,
  };
}

async function runBuySafetyGuards({
  persistFailure,
  symbol,
  action,
  signalTradeMode,
  capitalPolicy,
}) {
  const circuit = await checkCircuitBreaker();
  if (circuit.triggered) {
    console.log(`  ⛔ [서킷 브레이커] ${circuit.reason}`);
    return rejectExecution({
      persistFailure,
      symbol,
      action,
      reason: circuit.reason,
      code: 'capital_circuit_breaker',
      meta: { circuitType: circuit.type ?? null },
      notify: 'circuit',
    });
  }

  const openPositionsSafe = await getOpenPositions('binance', false, signalTradeMode).catch(() => []);
  if (openPositionsSafe.length >= capitalPolicy.max_concurrent_positions) {
    const reason = `최대 포지션 도달: ${openPositionsSafe.length}/${capitalPolicy.max_concurrent_positions}`;
    console.log(`  ⛔ [자본관리] ${reason}`);
    return rejectExecution({
      persistFailure,
      symbol,
      action,
      reason,
      code: 'capital_guard_rejected',
      meta: buildGuardTelemetryMeta(symbol, action, signalTradeMode, {
        openPositions: openPositionsSafe.length,
        maxPositions: capitalPolicy.max_concurrent_positions,
      }, {
        guardKind: 'max_positions',
        pressureSource: 'capital_policy',
      }),
      notify: 'skip',
    });
  }

  const dailyTradesSafe = await getDailyTradeCount({ exchange: 'binance', tradeMode: signalTradeMode, side: 'buy' }).catch(() => 0);
  if (dailyTradesSafe >= capitalPolicy.max_daily_trades) {
    const reason = formatDailyTradeLimitReason(dailyTradesSafe, capitalPolicy.max_daily_trades);
    console.log(`  ⛔ [자본관리] ${reason}`);
    return rejectExecution({
      persistFailure,
      symbol,
      action,
      reason,
      code: 'capital_guard_rejected',
      meta: buildGuardTelemetryMeta(symbol, action, signalTradeMode, {
        dailyTrades: dailyTradesSafe,
        maxDailyTrades: capitalPolicy.max_daily_trades,
      }, {
        guardKind: 'daily_trade_limit',
        pressureSource: 'capital_policy',
      }),
      notify: 'skip',
    });
  }

  return null;
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
  await db.upsertPosition({
    symbol,
    amount: order.filled || 0,
    avgPrice: order.price || 0,
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
    getDailyPnL().catch(() => null),
  ]);

  await notifyTrade({
    ...trade,
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
    });
    await journalDb.linkRationaleToTrade(tradeId, signalId);
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
    return;
  }

  if (trade.side === 'sell') {
    await closeOpenJournalForSymbol(
      trade.symbol,
      trade.paper,
      trade.price,
      trade.totalUsdt,
      exitReason || 'signal_reverse',
      trade.tradeMode,
    );
  }
}

async function finalizeExecutedTrade({ trade, signalId, signalTradeMode, capitalPolicy, exitReason }) {
  await db.insertTrade(trade);
  await db.updateSignalStatus(signalId, SIGNAL_STATUS.EXECUTED);
  await notifyExecutedTrade({ trade, signalTradeMode, capitalPolicy });

  try {
    await recordExecutedTradeJournal({ trade, signalId, exitReason });
  } catch (journalErr) {
    console.warn(`  ⚠️ 매매일지 기록 실패: ${journalErr.message}`);
  }
}

async function resolveSellExecutionContext({
  persistFailure,
  signalId,
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
}) {
  let amount = position?.amount;

  if (!amount || amount <= 0) {
    amount = sellPaperMode
      ? Number(livePosition?.amount || fallbackLivePosition?.amount || paperPosition?.amount || 0)
      : freeBalance;
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
  } else if (!sellPaperMode && freeBalance <= 0 && amount > 0) {
    const reason = `가용 잔고 없음 (free=${freeBalance}, total=${totalBalance || 0})`;
    console.warn(`  ⚠️ ${symbol} ${reason} — SELL 스킵`);
    await persistFailure(reason, {
      code: 'no_free_balance_for_sell',
      meta: {
        exchange: 'binance',
        symbol,
        dbAmount: position?.amount || 0,
        freeBalance,
        totalBalance,
        sellPaperMode,
      },
    });
    return { success: false, reason };
  } else if (!sellPaperMode && freeBalance < amount) {
    const drift = amount - freeBalance;
    console.warn(`  ⚠️ ${symbol} DB 포지션(${amount})과 가용잔고(free=${freeBalance}, total=${totalBalance || freeBalance})가 어긋남 — free 기준으로 SELL 진행`);
    amount = freeBalance;
    await db.updateSignalBlock(signalId, {
      reason: `position_reconciled_to_balance:${drift.toFixed(8)}`,
      code: 'position_balance_reconciled',
      meta: {
        exchange: 'binance',
        symbol,
        dbAmount: position?.amount || 0,
        freeBalance,
        totalBalance,
        drift,
      },
    }).catch(() => {});
  }

  if (!sellPaperMode) {
    const minSellAmount = await getMinSellAmount(symbol).catch(() => 0);
    const roundedAmount = roundSellAmount(symbol, amount);
    if (roundedAmount <= 0 || (minSellAmount > 0 && roundedAmount < minSellAmount)) {
      const reason = `최소 매도 수량 미달 (${roundedAmount || amount} < ${minSellAmount || 'exchange_min'})`;
      console.warn(`  ⚠️ ${symbol} ${reason} — SELL 스킵`);
      await cleanupDustLivePosition(symbol, livePosition, signalTradeMode, {
        signalId,
        freeBalance,
        roundedAmount: roundedAmount || amount,
        minSellAmount,
      });
      await persistFailure(reason, {
        code: 'sell_amount_below_minimum',
        meta: {
          requestedAmount: amount,
          roundedAmount,
          minSellAmount,
          sellPaperMode,
        },
      });
      return { success: false, reason };
    }
    amount = roundedAmount;
  }

  return { success: true, amount };
}

async function executeSellTrade({ signalId, symbol, amount, sellPaperMode, effectivePositionTradeMode }) {
  const order = await marketSell(symbol, amount, sellPaperMode);
  const trade = {
    signalId,
    symbol,
    side: 'sell',
    amount: order.amount || amount,
    price: order.price,
    totalUsdt: order.totalUsdt || ((order.amount || amount) * (order.price || 0)),
    paper: sellPaperMode,
    exchange: 'binance',
    tradeMode: effectivePositionTradeMode,
  };

  await db.deletePosition(symbol, {
    exchange: 'binance',
    paper: sellPaperMode,
    tradeMode: effectivePositionTradeMode,
  });

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
    return { effectivePaperMode: globalPaperMode };
  }

  if (!globalPaperMode && !check.circuit && isCapitalShortageReason(check.reason || '')) {
    console.log(`  📄 [자본관리] 실잔고 부족 → PAPER 폴백: ${check.reason}`);
    await db.updateSignalBlock(signalId, {
      reason: `paper_fallback:${check.reason}`,
      code: 'paper_fallback',
      meta: {
        exchange: 'binance',
        symbol,
        action,
        amount: amountUsdt,
      },
    });
    notifyTradeSkip({ symbol, action, reason: `실잔고 부족으로 PAPER 전환: ${check.reason}` }).catch(() => {});
    return { effectivePaperMode: true };
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

async function resolveBuyOrderAmount({
  persistFailure,
  symbol,
  action,
  amountUsdt,
  signal,
  effectivePaperMode,
}) {
  const slPrice = signal.slPrice || 0;
  const currentPrice = await fetchTicker(symbol).catch(() => 0);
  const sizing = await calculatePositionSize(symbol, currentPrice, slPrice, 'binance');
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

  const actualAmount = effectivePaperMode ? amountUsdt : sizing.size;
  if (effectivePaperMode) {
    console.log(`  📄 [PAPER] 시그널 원본 금액으로 가상 포지션 추적: ${actualAmount.toFixed(2)} USDT`);
  } else {
    console.log(`  📐 [자본관리] 포지션 ${actualAmount.toFixed(2)} USDT (자본의 ${sizing.capitalPct}% | 리스크 ${sizing.riskPercent}%)`);
  }

  return { actualAmount };
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
    };

    await closeOpenJournalForSymbol(
      paperPos.symbol,
      true,
      order.price,
      (paperPos.amount || 0) * (order.price || 0),
      'promoted_to_live',
      paperPos.trade_mode || 'normal',
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

  return {
    symbol,
    requestedAmountUsdt: amountUsdt,
    currentPrice,
    liveAllowed: check.allowed,
    liveReason: check.allowed ? 'LIVE 가능' : check.reason,
    paperFallback,
    finalMode: check.allowed ? 'live' : paperFallback ? 'paper' : 'blocked',
    suggestedLiveAmountUsdt: sizing.skip ? 0 : sizing.size,
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
  const capitalPolicy = getCapitalConfig('binance', signal?.trade_mode || getInvestmentTradeMode());
  const minOrderUsdt = await getDynamicMinOrderAmount('binance', signal?.trade_mode || getInvestmentTradeMode());
  if (base === 'BTC') return null;  // BTC 자체는 흡수 블록에서 처리

  // 미추적 BTC 확인
  const walletBal    = await getExchange().fetchBalance();
  const walletBtc    = walletBal.free?.BTC || 0;
  const trackedBtcPos = await db.getLivePosition('BTC/USDT', null, getInvestmentTradeMode()).catch(() => null);
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
  const btcPerCoin = pairTicker.last;  // 1 ETH = N BTC
  const coinAmount = untrackedBtc / btcPerCoin;

  console.log(`  💱 [헤파이스토스] BTC 직접 매수: ${untrackedBtc.toFixed(6)} BTC → ${coinAmount.toFixed(6)} ${base} (${btcPair})`);

  // 시장가 매수
  let order;
  if (paperMode) {
    order = { filled: coinAmount, price: btcPerCoin, dryRun: true };
    console.log(`  📄 [헤파이스토스] PAPER BUY ${btcPair} ${coinAmount.toFixed(6)} @ ${btcPerCoin}`);
  } else {
    order = await ex.createOrder(btcPair, 'market', 'buy', coinAmount);
  }

  const filledCoin  = order.filled || coinAmount;
  const usdPrice    = await fetchTicker(symbol).catch(() => btcPrice * btcPerCoin);
  const usdEquiv    = filledCoin * usdPrice;

  // DB 포지션 등록 (USDT 환산 기준)
  await db.upsertPosition({
    symbol,
    amount: filledCoin,
    avgPrice: usdPrice,
    unrealizedPnl: 0,
    paper: paperMode,
    exchange: 'binance',
    tradeMode: signal?.trade_mode || getInvestmentTradeMode(),
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
  };
  await db.insertTrade(trade);
  await db.updateSignalStatus(signalId, SIGNAL_STATUS.EXECUTED);

  await notifyTrade({
    ...trade,
    memo: `BTC 직접 매수 (${btcPair}) — 미추적 BTC ${untrackedBtc.toFixed(6)} 활용${paperMode ? ' [PAPER]' : ''}`,
  }).catch(() => {});

  return { success: true, btcDirect: true, btcPair, amount: filledCoin, price: usdPrice };
}

// ─── 미추적 코인 청산 (자본 확보) ───────────────────────────────────

/**
 * 지갑에서 DB 포지션에 없는 코인(BTC 등)을 매도해 USDT 확보
 * @param {string} excludeBase  — 매수 대상 base 심볼 (예: 'ETH') → 이것은 매도 제외
 * @param {boolean} paperMode
 */
async function _liquidateUntrackedForCapital(excludeBase, paperMode) {
  const capitalPolicy = getCapitalConfig('binance');
  const minOrderUsdt = await getDynamicMinOrderAmount('binance', getInvestmentTradeMode());
  const ex        = getExchange();
  const walletBal = await ex.fetchBalance();
  let totalUsd    = 0;

  for (const [coin, free] of Object.entries(walletBal.free || {})) {
    if (coin === 'USDT')        continue;  // 기축통화 제외
    if (coin === excludeBase)   continue;  // 매수 대상 제외
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

    console.log(`  💱 [헤파이스토스] 미추적 ${coin} ${untracked.toFixed(6)} (≈$${untrackedUsd.toFixed(2)}) → USDT 전환`);
    await marketSell(sym, untracked, paperMode);
    totalUsd += untrackedUsd;
  }

  if (totalUsd > 0) {
    console.log(`  ✅ 미추적 코인 청산 완료: 총 ≈$${totalUsd.toFixed(2)} USDT 확보`);
    notifyTrade({
      symbol:    `미추적코인→USDT`,
      side:      'liquidate',
      totalUsdt: totalUsd,
      paper:     paperMode,
      exchange:  'binance',
      memo:      `미추적 코인 청산 → 신규 매수 자본 확보${paperMode ? ' [PAPER]' : ''}`,
    }).catch(() => {});
  }
}

// ─── 신호 실행 ──────────────────────────────────────────────────────

/**
 * 단일 바이낸스 신호 실행
 * @param {object} signal  { id, symbol, action, amountUsdt, confidence, reasoning }
 */
export async function executeSignal(signal) {
  await initHubSecrets().catch(() => false);
  const globalPaperMode = isPaperMode();
  const { id: signalId, symbol, action } = signal;

  // ★ SEC-004 가드: 네메시스 승인 재검증 (BUY 전용 — SELL은 포지션 청산이므로 예외)
  if (action !== ACTIONS.SELL && !globalPaperMode) {
    const nemesisVerdict = signal.nemesis_verdict || signal.nemesisVerdict;
    const isApproved = ['approved', 'modified'].includes(String(nemesisVerdict || '').toLowerCase());
    if (!isApproved) {
      const reason = `SEC-004: 네메시스 승인 없는 BUY signal 실행 차단 (verdict=${nemesisVerdict || 'null'})`;
      console.error(`  🛡️ [헤파이스토스] ${reason}`);
      if (signalId) {
        await db.updateSignalBlock(signalId, {
          status: SIGNAL_STATUS.FAILED,
          reason: reason.slice(0, 180),
          code: 'sec004_nemesis_bypass_guard',
          meta: { symbol, action, nemesis_verdict: nemesisVerdict || null, execution_blocked_by: 'hephaestos_entry_guard' },
        }).catch(() => {});
      }
      notifyTradeSkip({ symbol, action, reason }).catch(() => {});
      return { success: false, reason, code: 'sec004_nemesis_bypass_guard' };
    }
    // stale signal 체크 (승인 후 5분 초과)
    if (signal.approved_at) {
      const ageMs = Date.now() - new Date(signal.approved_at).getTime();
      if (ageMs > 5 * 60 * 1000) {
        const reason = `SEC-004: 승인 후 ${Math.round(ageMs / 1000)}초 경과 (stale signal)`;
        console.error(`  🛡️ [헤파이스토스] ${reason}`);
        if (signalId) {
          await db.updateSignalBlock(signalId, {
            status: SIGNAL_STATUS.FAILED,
            reason: reason.slice(0, 180),
            code: 'sec004_stale_approval',
            meta: { symbol, action, approved_at: signal.approved_at, age_seconds: Math.round(ageMs / 1000) },
          }).catch(() => {});
        }
        notifyTradeSkip({ symbol, action, reason }).catch(() => {});
        return { success: false, reason, code: 'sec004_stale_approval' };
      }
    }
  }

  const amountUsdt = signal.amountUsdt || signal.amount_usdt || 100;
  const signalTradeMode = signal.trade_mode || getInvestmentTradeMode();
  const capitalPolicy = getCapitalConfig('binance', signalTradeMode);
  const minOrderUsdt = await getDynamicMinOrderAmount('binance', signalTradeMode);
  const exitReasonOverride = signal.exit_reason_override || null;
  const base = symbol.split('/')[0];
  let effectivePaperMode = globalPaperMode;
  const persistFailure = async (reason, {
    code = 'broker_execution_error',
    meta = {},
  } = {}) => {
    await db.updateSignalBlock(signalId, {
      status: SIGNAL_STATUS.FAILED,
      reason: reason ? String(reason).slice(0, 180) : null,
      code,
      meta: {
        exchange: 'binance',
        symbol,
        action,
        amount: amountUsdt,
        ...meta,
      },
    }).catch(() => {});
  };

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

  const tag = effectivePaperMode ? '[PAPER]' : '[LIVE]';
  console.log(`\n⚡ [헤파이스토스] ${symbol} ${action} $${amountUsdt} ${tag}`);

  try {
    /** @type {any} */
    let trade;

    if (action === ACTIONS.BUY) {
      if (!globalPaperMode && signalTradeMode === 'normal') {
        const promoted = await maybePromotePaperPositions({ reserveSlots: 1 }).catch(err => {
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
        console.warn(`  ⚠️ BTC 직접 매수 실패 (USDT 전환 폴백): ${e.message}`);
      }

      // USDT 폴백: BTC 페어 없는 종목일 때 BTC → USDT → 매수
      try {
        await _liquidateUntrackedForCapital(base, effectivePaperMode);
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
      });
      if (orderAmountState?.success === false) return orderAmountState;
      const actualAmount = orderAmountState.actualAmount;

      const order = await marketBuy(symbol, actualAmount, effectivePaperMode);
      trade = {
        signalId,
        symbol,
        side:      'buy',
        amount:    order.filled,
        price:     order.price,
        totalUsdt: actualAmount,
        paper:     effectivePaperMode,
        exchange:  'binance',
        tradeMode: signalTradeMode,
      };

      await persistBuyPosition({ symbol, order, effectivePaperMode, signalTradeMode });
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
      });
      if (sellAmountState?.success === false) return sellAmountState;

      trade = await executeSellTrade({
        signalId,
        symbol,
        amount: sellAmountState.amount,
        sellPaperMode: sellContext.sellPaperMode,
        effectivePositionTradeMode: sellContext.effectivePositionTradeMode,
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
    });

    const doneTag = trade.paper ? '[PAPER]' : '[LIVE]';
    console.log(`  ✅ ${doneTag} 완료: ${trade.side} ${trade.amount?.toFixed(6)} @ $${trade.price?.toLocaleString()}`);
    return { success: true, trade };

  } catch (e) {
    console.error(`  ❌ 실행 오류: ${e.message}`);
    const failureCode = e?.code === 'sell_amount_below_minimum'
      ? 'sell_amount_below_minimum'
      : 'broker_execution_error';
    await persistFailure(e.message, {
      code: failureCode,
      meta: {
        error: String(e.message).slice(0, 240),
        ...(e?.meta || {}),
      },
    });
    await notifyError(`헤파이스토스 - ${symbol} ${action}`, e);
    return { success: false, error: e.message };
  }
}

/**
 * 대기 중인 바이낸스 신호 전체 처리
 */
export async function processAllPendingSignals() {
  const { tradeMode } = await preparePendingSignalProcessing();
  const signals = await db.getApprovedSignals('binance', tradeMode);
  return runPendingSignalBatch(signals, { tradeMode, delayMs: 500 });
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
