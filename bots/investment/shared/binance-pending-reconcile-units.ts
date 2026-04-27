// @ts-nocheck

function positiveNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

export function getQuoteAsset(symbol = '') {
  const normalized = String(symbol || '').trim().toUpperCase();
  if (!normalized.includes('/')) return '';
  const [, quote] = normalized.split('/');
  return String(quote || '').trim().toUpperCase();
}

export async function normalizePendingReconcileOrderUnits({
  signalSymbol = '',
  orderSymbol = '',
  filledQty = 0,
  price = 0,
  cost = 0,
  pendingMeta = {},
  signalId = null,
  quotePriceResolver = null,
} = {}) {
  const normalizedSignalSymbol = String(signalSymbol || '').trim().toUpperCase();
  const normalizedOrderSymbol = String(orderSymbol || normalizedSignalSymbol).trim().toUpperCase() || normalizedSignalSymbol;
  const signalQuote = getQuoteAsset(normalizedSignalSymbol);
  const orderQuote = getQuoteAsset(normalizedOrderSymbol);
  const normalizedFilled = Math.max(0, Number(filledQty || 0));
  const rawPrice = Math.max(0, Number(price || 0));
  const rawCost = Math.max(0, Number(cost || (normalizedFilled * rawPrice)));

  if (!signalQuote || !orderQuote || signalQuote === orderQuote) {
    return {
      convertedPrice: rawPrice,
      convertedCost: rawCost,
      conversionApplied: false,
      conversionRate: null,
      conversionPair: null,
      rawPrice,
      rawCost,
      signalQuote,
      orderQuote,
    };
  }

  if (signalQuote === 'USDT' && orderQuote === 'BTC') {
    const pendingBtcRef = positiveNumber(pendingMeta?.btcReferencePrice, 0);
    const fallbackBtcRef = positiveNumber(pendingMeta?.lastBtcUsdtPrice, 0);
    let btcUsdtPrice = pendingBtcRef || fallbackBtcRef;
    if (btcUsdtPrice <= 0 && typeof quotePriceResolver === 'function') {
      btcUsdtPrice = await quotePriceResolver('BTC/USDT').catch(() => 0);
    }
    if (!Number.isFinite(btcUsdtPrice) || btcUsdtPrice <= 0) {
      const conversionError = /** @type {any} */ (new Error(
        `pending_reconcile_quote_conversion_unavailable:${normalizedSignalSymbol}:${normalizedOrderSymbol}`,
      ));
      conversionError.code = 'pending_reconcile_quote_conversion_unavailable';
      conversionError.meta = {
        signalId: signalId || null,
        signalSymbol: normalizedSignalSymbol,
        orderSymbol: normalizedOrderSymbol,
        signalQuote,
        orderQuote,
      };
      throw conversionError;
    }
    return {
      convertedPrice: rawPrice > 0 ? (rawPrice * btcUsdtPrice) : 0,
      convertedCost: rawCost > 0 ? (rawCost * btcUsdtPrice) : (normalizedFilled * rawPrice * btcUsdtPrice),
      conversionApplied: true,
      conversionRate: btcUsdtPrice,
      conversionPair: 'BTC/USDT',
      rawPrice,
      rawCost,
      signalQuote,
      orderQuote,
    };
  }

  const unsupportedError = /** @type {any} */ (new Error(
    `pending_reconcile_quote_conversion_unsupported:${normalizedSignalSymbol}:${normalizedOrderSymbol}:${orderQuote}->${signalQuote}`,
  ));
  unsupportedError.code = 'pending_reconcile_quote_conversion_unsupported';
  unsupportedError.meta = {
    signalId: signalId || null,
    signalSymbol: normalizedSignalSymbol,
    orderSymbol: normalizedOrderSymbol,
    signalQuote,
    orderQuote,
  };
  throw unsupportedError;
}

export function isPendingReconcileQuoteConversionError(error = null) {
  const code = String(error?.code || '').trim().toLowerCase();
  return (
    code === 'pending_reconcile_quote_conversion_unavailable'
    || code === 'pending_reconcile_quote_conversion_unsupported'
  );
}
