// @ts-nocheck
/**
 * Pure pending-reconcile queue helpers for Binance execution recovery.
 *
 * The mutating DB/notification work stays in Hephaestos; this module owns the
 * deterministic queue-state and progress math so those contracts are easier to
 * test without pulling the whole execution bot into scope.
 */

export const BINANCE_PENDING_RECONCILE_EPSILON = 0.00000001;

export const BINANCE_PENDING_RECONCILE_OPEN_STATUSES = new Set([
  'new',
  'open',
  'partially_filled',
  'partiallyfilled',
  'pending',
]);

function toEpochMs(value = null) {
  if (value == null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseBlockMeta(value = null) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function resolveBinancePendingQueueState({
  status = 'unknown',
  filledQty = 0,
  expectedQty = 0,
  orderStillOpen = null,
} = {}) {
  const normalizedStatus = String(status || '').trim().toLowerCase() || 'unknown';
  const filled = Math.max(0, Number(filledQty || 0));
  const expected = Math.max(0, Number(expectedQty || 0));
  const closed = normalizedStatus === 'closed' || normalizedStatus === 'filled';
  const openLike = BINANCE_PENDING_RECONCILE_OPEN_STATUSES.has(normalizedStatus);

  if (openLike) {
    if (filled > BINANCE_PENDING_RECONCILE_EPSILON) {
      return {
        code: 'partial_fill_pending',
        queueStatus: 'partial_pending',
        followUpRequired: true,
      };
    }
    return {
      code: 'order_pending_reconcile',
      queueStatus: 'queued',
      followUpRequired: true,
    };
  }

  if (closed && filled > BINANCE_PENDING_RECONCILE_EPSILON) {
    return {
      code: 'order_reconciled',
      queueStatus: 'completed',
      followUpRequired: false,
    };
  }
  if (
    orderStillOpen === false
    && expected > BINANCE_PENDING_RECONCILE_EPSILON
    && filled + BINANCE_PENDING_RECONCILE_EPSILON >= expected
  ) {
    return {
      code: 'order_reconciled',
      queueStatus: 'completed',
      followUpRequired: false,
    };
  }
  if (filled > BINANCE_PENDING_RECONCILE_EPSILON) {
    return {
      code: 'partial_fill_pending',
      queueStatus: 'partial_pending',
      followUpRequired: true,
    };
  }
  return {
    code: 'order_pending_reconcile',
    queueStatus: 'queued',
    followUpRequired: true,
  };
}

export function buildBinancePendingReconcilePayload(signal = {}, {
  defaultTradeMode = 'normal',
} = {}) {
  if (!signal || typeof signal !== 'object') return null;
  const blockMeta = parseBlockMeta(signal.block_meta);
  const pendingMeta = blockMeta.pendingReconcile && typeof blockMeta.pendingReconcile === 'object'
    ? blockMeta.pendingReconcile
    : null;
  if (!pendingMeta) return null;

  const symbol = String(pendingMeta.symbol || signal.symbol || '').trim().toUpperCase();
  const action = String(pendingMeta.action || signal.action || '').trim().toUpperCase();
  const orderId = pendingMeta.orderId ? String(pendingMeta.orderId) : null;
  const clientOrderId = pendingMeta.clientOrderId ? String(pendingMeta.clientOrderId) : null;
  if (!symbol || !action || (!orderId && !clientOrderId)) return null;
  const orderSymbol = String(pendingMeta.orderSymbol || symbol).trim().toUpperCase() || symbol;
  const submittedAtMs = toEpochMs(
    pendingMeta.submittedAt
      || pendingMeta.submittedAtMs
      || signal.created_at
      || signal.approved_at
      || signal.updated_at
      || null,
  );

  return {
    signal,
    blockMeta,
    pendingMeta,
    signalId: signal.id,
    symbol,
    action,
    tradeMode: signal.trade_mode || pendingMeta.tradeMode || defaultTradeMode,
    paperMode: pendingMeta.paperMode === true,
    orderId,
    clientOrderId,
    orderSymbol,
    submittedAtMs,
    expectedQty: Number(pendingMeta.expectedQty || 0),
    recordedFilledQty: Number(pendingMeta.recordedFilledQty ?? pendingMeta.filledQty ?? 0),
    recordedCost: Number(pendingMeta.recordedCost || 0),
    amountUsdt: Number(signal.amount_usdt || pendingMeta.amountUsdt || 0),
    followUpRequired: pendingMeta.followUpRequired !== false,
  };
}

export function computeBinancePendingRecordedProgress({
  exchangeFilledQty = 0,
  exchangeCost = 0,
  exchangePrice = 0,
  recordedFilledQty = 0,
  recordedCost = 0,
  applySucceeded = true,
} = {}) {
  const filled = Math.max(0, Number(exchangeFilledQty || 0));
  const cost = Math.max(0, Number(exchangeCost || 0));
  const recordedFilled = Math.max(0, Number(recordedFilledQty || 0));
  const recordedCostSafe = Math.max(0, Number(recordedCost || 0));

  const rawDeltaFilled = filled - recordedFilled;
  const deltaFilledQty = rawDeltaFilled > BINANCE_PENDING_RECONCILE_EPSILON
    ? rawDeltaFilled
    : 0;

  let deltaCost = 0;
  const referencePrice = Math.max(
    0,
    Number(exchangePrice || (filled > BINANCE_PENDING_RECONCILE_EPSILON && cost > 0 ? (cost / filled) : 0)),
  );
  if (deltaFilledQty > BINANCE_PENDING_RECONCILE_EPSILON) {
    const rawDeltaCost = cost - recordedCostSafe;
    if (rawDeltaCost > BINANCE_PENDING_RECONCILE_EPSILON) {
      deltaCost = rawDeltaCost;
    } else if (referencePrice > 0) {
      deltaCost = deltaFilledQty * referencePrice;
    }
  }

  if (!applySucceeded) {
    return {
      deltaFilledQty,
      deltaCost,
      appliedFilledQty: 0,
      appliedCost: 0,
      nextRecordedFilledQty: recordedFilled,
      nextRecordedCost: recordedCostSafe,
    };
  }

  const appliedFilledQty = deltaFilledQty;
  const appliedCost = Math.max(0, deltaCost);
  const nextRecordedFilledQty = Math.min(
    filled,
    Math.max(recordedFilled, recordedFilled + appliedFilledQty),
  );
  let nextRecordedCost = Math.max(recordedCostSafe, recordedCostSafe + appliedCost);
  if (cost > BINANCE_PENDING_RECONCILE_EPSILON) {
    nextRecordedCost = Math.min(cost, nextRecordedCost);
  }

  return {
    deltaFilledQty,
    deltaCost,
    appliedFilledQty,
    appliedCost,
    nextRecordedFilledQty,
    nextRecordedCost,
  };
}
