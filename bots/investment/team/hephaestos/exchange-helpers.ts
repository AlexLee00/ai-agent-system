// @ts-nocheck

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

export function createHephaestosExchangeHelpers({
  getExchange,
  extractExchangeOrderId,
  extractClientOrderId,
} = {}) {
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

  return {
    roundSellAmount,
    extractOrderId,
    toEpochMs,
    buildDeterministicClientOrderId,
    fetchFreeAssetBalance,
    fetchAssetBalances,
    cancelOpenSellOrdersForSymbol,
  };
}
