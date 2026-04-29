// @ts-nocheck

export function createMarketOrderExecution({
  fetchTicker,
  getExchange,
  roundSellAmount,
  createBinanceMarketBuy,
  createBinanceMarketSell,
  normalizeBinanceMarketOrderExecution,
  getBinanceOpenOrders,
  extractExchangeOrderId,
  extractClientOrderId,
}) {
  async function marketBuy(symbol, amountUsdt, paperMode, {
    clientOrderId = null,
    submittedAtMs = null,
  } = {}) {
    if (paperMode) {
      const price = await fetchTicker(symbol).catch(() => 0);
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

  async function marketSell(symbol, amount, paperMode, {
    clientOrderId = null,
    submittedAtMs = null,
  } = {}) {
    if (paperMode) {
      const price = await fetchTicker(symbol).catch(() => 0);
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

  return {
    marketBuy,
    marketSell,
    getMinSellAmount,
    isBinanceOrderStillOpen,
  };
}
