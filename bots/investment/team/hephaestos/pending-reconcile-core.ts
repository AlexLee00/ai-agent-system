// @ts-nocheck

export function buildPendingReconcileDeltaIncidentLink({
  signalId = null,
  orderId = null,
  clientOrderId = null,
  action = null,
  targetFilledQty = 0,
} = {}) {
  const normalizedTarget = Number(Math.max(0, Number(targetFilledQty || 0))).toFixed(8);
  const orderKey = String(orderId || clientOrderId || 'none');
  return [
    'pending_reconcile_delta',
    String(signalId || 'none'),
    orderKey,
    String(action || 'none').toLowerCase(),
    normalizedTarget,
  ].join(':');
}

export function escapePendingReconcileLikePattern(value = '') {
  return String(value || '').replace(/[\\%_]/g, '\\$&');
}

export function normalizePendingReconcileTradeRow(row = {}) {
  return {
    id: row?.id || null,
    signalId: row?.signal_id || null,
    symbol: row?.symbol || null,
    side: row?.side || null,
    amount: Math.max(0, Number(row?.amount || 0)),
    price: Math.max(0, Number(row?.price || 0)),
    totalUsdt: Math.max(0, Number(row?.total_usdt || 0)),
    paper: Boolean(row?.paper),
    exchange: row?.exchange || 'binance',
    tradeMode: row?.trade_mode || 'normal',
    incidentLink: row?.incident_link || null,
    partialExit: Boolean(row?.partial_exit),
    partialExitRatio: row?.partial_exit_ratio == null ? null : Number(row.partial_exit_ratio),
    remainingAmount: row?.remaining_amount == null ? null : Number(row.remaining_amount),
    executionOrigin: row?.execution_origin || 'strategy',
    qualityFlag: row?.quality_flag || 'trusted',
    excludeFromLearning: Boolean(row?.exclude_from_learning ?? false),
  };
}

export default {
  buildPendingReconcileDeltaIncidentLink,
  escapePendingReconcileLikePattern,
  normalizePendingReconcileTradeRow,
};
