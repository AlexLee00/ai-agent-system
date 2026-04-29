// @ts-nocheck

function extractOcoOrderIds(ocoResponse) {
  const reports = ocoResponse?.orderReports || ocoResponse?.info?.orderReports || [];
  const tpOrderId = reports?.[0]?.orderId?.toString?.() ?? ocoResponse?.orders?.[0]?.orderId?.toString?.() ?? null;
  const slOrderId = reports?.[1]?.orderId?.toString?.() ?? ocoResponse?.orders?.[1]?.orderId?.toString?.() ?? null;
  return { tpOrderId, slOrderId };
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

export function isStopLossOnlyMode(mode = null) {
  return mode === 'stop_loss_only'
    || mode === 'ccxt_stop_loss_only'
    || mode === 'exchange_stop_loss_only';
}

export function buildProtectionSnapshot(protection = null, fallbackError = null) {
  const errorText = protection?.error || fallbackError || null;
  return {
    tpSlSet: Boolean(protection?.ok),
    tpOrderId: protection?.tpOrderId ?? null,
    slOrderId: protection?.slOrderId ?? null,
    tpSlMode: protection?.mode ?? null,
    tpSlError: errorText ? String(errorText).slice(0, 240) : null,
  };
}

export function createProtectiveExitPolicy({
  getExchange,
  fetchFreeAssetBalance,
  extractOrderId,
} = {}) {
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

  return {
    buildProtectionSnapshot,
    isStopLossOnlyMode,
    normalizeProtectiveExitPrices,
    placeBinanceProtectiveExit,
  };
}
