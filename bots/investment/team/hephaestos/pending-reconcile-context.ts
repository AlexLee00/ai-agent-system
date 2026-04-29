// @ts-nocheck

const BINANCE_SYMBOL_RE = /^[A-Z0-9]+\/USDT$/;

export function isBinanceSymbol(symbol) {
  return BINANCE_SYMBOL_RE.test(symbol);
}

export async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function toPositiveNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

export function parseSignalBlockMeta(blockMeta = null) {
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

export function isSyntheticOrTestSignalContext({
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

export function isDefinitiveBinanceOrderLookupError(errorCode = null) {
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

export function createPendingReconcileContext({
  db,
  normalizePendingReconcileOrderUnitsBase,
  quotePriceResolver,
  toEpochMs,
}) {
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
      quotePriceResolver,
    });
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
      pairPriceBtc: toPositiveNumber(pairPriceBtc),
      btcReferencePrice: toPositiveNumber(btcReferencePrice),
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

  return {
    loadSignalPendingReconcileMeta,
    normalizePendingReconcileOrderUnits,
    buildBtcPairPendingReconcileError,
  };
}
