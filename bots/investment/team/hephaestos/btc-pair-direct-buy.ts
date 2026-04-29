// @ts-nocheck
/**
 * BTC-pair direct buy policy.
 *
 * Keeps the live-order mutation boundary identical while moving the large
 * BTC-pair fallback/pending-reconcile contract out of team/hephaestos.ts.
 */

export function createBtcPairDirectBuyPolicy({
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
} = {}) {
  async function tryBuyWithBtcPair(symbol, base, signalId, signal, paperMode) {
    const signalTradeMode = signal?.trade_mode || getInvestmentTradeMode();
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

    // ETH/BTC 등 직접 페어 존재 여부 확인
    const btcPair = `${base}/BTC`;
    const ex      = getExchange();
    const markets = await ex.loadMarkets();
    if (!markets[btcPair]) {
      console.log(`  ℹ️ ${btcPair} 페어 없음 → USDT 전환 폴백`);
      return null;
    }

    const pairTicker = await ex.fetchTicker(btcPair);
    const btcPerCoin = Number(pairTicker.last || 0);
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

  return {
    tryBuyWithBtcPair,
  };
}

export default {
  createBtcPairDirectBuyPolicy,
};

