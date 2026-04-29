#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildFetchFailurePendingReconcileMeta,
  buildMissingPendingReconcileKeysResult,
  buildQuoteConversionManualReconcileMeta,
  normalizePendingReconcileTradeModes,
  summarizePendingReconcileResults,
} from '../team/hephaestos/binance-order-reconcile.ts';

const modes = normalizePendingReconcileTradeModes(['normal', 'validation', 'normal', '', null]);
assert.deepEqual(modes, ['normal', 'validation']);
assert.deepEqual(normalizePendingReconcileTradeModes([]), ['normal', 'validation']);

const missing = buildMissingPendingReconcileKeysResult(
  { id: 'sig-1', symbol: 'ORCA/USDT', action: 'BUY' },
  'missing keys',
);
assert.deepEqual(missing, {
  signalId: 'sig-1',
  symbol: 'ORCA/USDT',
  action: 'BUY',
  code: 'manual_reconcile_required',
  status: 'missing_order_keys',
  error: 'missing keys',
});

const conversionError = new Error('unsupported_quote_mismatch');
conversionError.meta = { orderQuote: 'ETH', signalQuote: 'USDT' };
const conversionMeta = buildQuoteConversionManualReconcileMeta({
  payload: {
    symbol: 'ABC/USDT',
    orderSymbol: 'ABC/ETH',
    action: 'BUY',
    orderId: 'order-1',
    clientOrderId: 'client-1',
    pendingMeta: { followUpRequired: true },
  },
  error: conversionError,
});
assert.equal(conversionMeta.exchange, 'binance');
assert.equal(conversionMeta.orderSymbol, 'ABC/ETH');
assert.equal(conversionMeta.conversionError, 'unsupported_quote_mismatch');
assert.equal(conversionMeta.orderQuote, 'ETH');

const fetchMeta = buildFetchFailurePendingReconcileMeta({
  payload: {
    symbol: 'ABC/USDT',
    orderSymbol: 'ABC/USDT',
    action: 'SELL',
    orderId: 'order-2',
    clientOrderId: 'client-2',
    pendingMeta: { submittedAt: '2026-04-29T00:00:00.000Z' },
  },
  error: new Error('network_timeout'),
});
assert.equal(fetchMeta.pendingReconcile.queueStatus, 'queued');
assert.equal(fetchMeta.pendingReconcile.followUpRequired, true);
assert.equal(fetchMeta.pendingReconcile.reconcileError, 'network_timeout');
assert.equal(fetchMeta.pendingReconcile.submittedAt, '2026-04-29T00:00:00.000Z');

const summary = summarizePendingReconcileResults([
  { code: 'order_reconciled' },
  { code: 'partial_fill_pending' },
  { code: 'order_pending_reconcile' },
  { code: 'reconcile_fetch_failed' },
  { code: 'reconcile_apply_failed' },
  { code: 'manual_reconcile_required' },
  { code: 'ignored' },
]);
assert.deepEqual(summary, {
  completed: 1,
  partial: 1,
  queued: 1,
  failed: 3,
});

const payload = {
  ok: true,
  smoke: 'hephaestos-binance-order-reconcile-policy',
  modes,
  missing,
  conversionMeta,
  fetchMeta,
  summary,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('hephaestos-binance-order-reconcile-policy-smoke ok');
}
