// @ts-nocheck
/**
 * Binance market order execution normalizer.
 *
 * Converts raw CCXT/Binance market-order responses into the closed-fill envelope
 * Hephaestos expects. If the exchange confirms an order id/client id but not a
 * closed fill yet, this throws a pending reconcile error so the caller can
 * queue automatic recovery instead of recording raw/partial units.
 */

import { fetchBinanceOrder } from './binance-client.ts';

const BINANCE_PENDING_RECONCILE_OPEN_STATUSES = new Set([
  'new',
  'open',
  'partially_filled',
  'partiallyfilled',
  'pending',
]);

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function toPositiveNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

export function inferOrderFillPrice(order = {}) {
  const directPrice = toPositiveNumber(order.price, 0) || toPositiveNumber(order.average, 0);
  if (directPrice > 0) return directPrice;
  const filled = toPositiveNumber(order.filled, 0);
  const cost = toPositiveNumber(order.cost, 0);
  if (filled > 0 && cost > 0) return cost / filled;
  return 0;
}

export function extractExchangeOrderId(orderLike) {
  if (!orderLike) return null;
  return orderLike.orderId?.toString?.()
    ?? orderLike.info?.orderId?.toString?.()
    ?? orderLike.id?.toString?.()
    ?? null;
}

export function extractClientOrderId(orderLike) {
  if (!orderLike) return null;
  return orderLike.clientOrderId?.toString?.()
    ?? orderLike.origClientOrderId?.toString?.()
    ?? orderLike.info?.clientOrderId?.toString?.()
    ?? orderLike.info?.origClientOrderId?.toString?.()
    ?? null;
}

export async function normalizeBinanceMarketOrderExecution(symbol, side, rawOrder = null, {
  maxAttempts = 4,
  pollDelayMs = 900,
  expectedClientOrderId = null,
  submittedAtMs = null,
} = {}) {
  let latest = rawOrder || {};
  const orderId = extractExchangeOrderId(latest);
  const clientOrderId = extractClientOrderId(latest) || (expectedClientOrderId ? String(expectedClientOrderId) : null);
  let attempt = 0;

  while (attempt <= maxAttempts) {
    const status = String(latest?.status || '').trim().toLowerCase();
    const filled = toPositiveNumber(latest?.filled, 0);
    const fillPrice = inferOrderFillPrice(latest);
    const isClosed = status === 'closed' || status === 'filled';

    if (filled > 0 && fillPrice > 0 && (isClosed || !status)) {
      const normalizedCost = toPositiveNumber(latest?.cost, filled * fillPrice);
      return {
        ...latest,
        id: orderId || latest?.id || clientOrderId || null,
        orderId: orderId || latest?.orderId || latest?.info?.orderId || null,
        clientOrderId,
        side: side || latest?.side || null,
        status: status || 'closed',
        filled,
        price: fillPrice,
        average: fillPrice,
        cost: normalizedCost,
        normalized: true,
      };
    }

    if ((!orderId && !clientOrderId) || attempt === maxAttempts) break;
    attempt += 1;
    await delay(pollDelayMs * attempt);
    try {
      const fetched = await fetchBinanceOrder({
        symbol,
        orderId,
        clientOrderId,
        submittedAtMs,
        side,
        allowAllOrdersFallback: true,
      });
      if (fetched && typeof fetched === 'object') latest = fetched;
    } catch {
      // Fetch failures are handled by the final verification branch below.
    }
  }

  const lastStatus = String(latest?.status || '').trim().toLowerCase() || 'unknown';
  const lastFilled = toPositiveNumber(latest?.filled, 0);
  const lastPrice = inferOrderFillPrice(latest);
  const lastCost = toPositiveNumber(latest?.cost, lastFilled * lastPrice);
  const lastAmount = toPositiveNumber(latest?.amount, toPositiveNumber(latest?.origQty, 0));
  const isOpenPendingStatus = BINANCE_PENDING_RECONCILE_OPEN_STATUSES.has(lastStatus);
  if (lastFilled > 0 && lastPrice > 0) {
    const pendingError = /** @type {any} */ (new Error(
      `order_pending_fill_verification:${symbol}:${lastStatus}:${lastFilled}:${lastPrice}:${lastCost}`,
    ));
    pendingError.code = 'order_pending_fill_verification';
    pendingError.meta = {
      symbol,
      side,
      orderId: orderId || null,
      clientOrderId,
      status: lastStatus,
      amount: lastAmount,
      filled: lastFilled,
      price: lastPrice,
      cost: lastCost,
      submittedAtMs: submittedAtMs || null,
      attempts: maxAttempts + 1,
    };
    throw pendingError;
  }
  if ((orderId || clientOrderId) && isOpenPendingStatus) {
    const pendingError = /** @type {any} */ (new Error(
      `order_pending_fill_verification:${symbol}:${lastStatus}:0:0:0`,
    ));
    pendingError.code = 'order_pending_fill_verification';
    pendingError.meta = {
      symbol,
      side,
      orderId: orderId || null,
      clientOrderId,
      status: lastStatus,
      amount: lastAmount,
      filled: 0,
      price: 0,
      cost: 0,
      submittedAtMs: submittedAtMs || null,
      attempts: maxAttempts + 1,
    };
    throw pendingError;
  }

  const verifyError = /** @type {any} */ (new Error(
    `order_fill_unverified:${symbol}:${lastStatus}:${lastFilled}:${lastPrice}`,
  ));
  verifyError.code = 'order_fill_unverified';
  verifyError.meta = {
    symbol,
    side,
    orderId: orderId || null,
    clientOrderId,
    status: lastStatus,
    filled: lastFilled,
    price: lastPrice,
    submittedAtMs: submittedAtMs || null,
    attempts: maxAttempts + 1,
  };
  throw verifyError;
}
