// @ts-nocheck
/**
 * Pure helpers for Hephaestos Binance order reconciliation.
 *
 * Keep DB writes, order fetches, and wallet mutations in hephaestos.ts while
 * moving deterministic queue policy here. This gives us a safe seam for the
 * larger binance-order-reconcile extraction without changing trading behavior.
 */

const DEFAULT_PENDING_RECONCILE_TRADE_MODES = ['normal', 'validation'];

const PENDING_RECONCILE_FAILURE_CODES = new Set([
  'reconcile_fetch_failed',
  'reconcile_apply_failed',
  'manual_reconcile_required',
]);

export function normalizePendingReconcileTradeModes(tradeModes = []) {
  const normalizedModes = Array.from(new Set(
    (Array.isArray(tradeModes) ? tradeModes : [])
      .map((mode) => String(mode || '').trim())
      .filter(Boolean),
  ));
  return normalizedModes.length > 0 ? normalizedModes : [...DEFAULT_PENDING_RECONCILE_TRADE_MODES];
}

export function buildMissingPendingReconcileKeysResult(row = {}, reason = '') {
  return {
    signalId: row.id,
    symbol: row.symbol,
    action: row.action,
    code: 'manual_reconcile_required',
    status: 'missing_order_keys',
    error: reason,
  };
}

export function buildQuoteConversionManualReconcileMeta({ payload = {}, error = null } = {}) {
  return {
    exchange: 'binance',
    symbol: payload.symbol,
    action: payload.action,
    orderId: payload.orderId || null,
    clientOrderId: payload.clientOrderId || null,
    orderSymbol: payload.orderSymbol || payload.symbol,
    pendingReconcile: payload.pendingMeta || null,
    conversionError: String(error?.message || error).slice(0, 240),
    ...(error?.meta || {}),
  };
}

export function buildFetchFailurePendingReconcileMeta({ payload = {}, error = null } = {}) {
  return {
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
  };
}

export function summarizePendingReconcileResults(results = []) {
  return {
    completed: results.filter((item) => item.code === 'order_reconciled').length,
    partial: results.filter((item) => item.code === 'partial_fill_pending').length,
    queued: results.filter((item) => item.code === 'order_pending_reconcile').length,
    failed: results.filter((item) => PENDING_RECONCILE_FAILURE_CODES.has(item.code)).length,
  };
}

export default {
  normalizePendingReconcileTradeModes,
  buildMissingPendingReconcileKeysResult,
  buildQuoteConversionManualReconcileMeta,
  buildFetchFailurePendingReconcileMeta,
  summarizePendingReconcileResults,
};
