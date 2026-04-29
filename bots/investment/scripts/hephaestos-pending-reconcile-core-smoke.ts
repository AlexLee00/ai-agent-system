#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildPendingReconcileDeltaIncidentLink,
  escapePendingReconcileLikePattern,
  normalizePendingReconcileTradeRow,
} from '../team/hephaestos/pending-reconcile-core.ts';

const incidentLink = buildPendingReconcileDeltaIncidentLink({
  signalId: 'sig-1',
  orderId: 'order-1',
  action: 'BUY',
  targetFilledQty: 1.234567891,
});
assert.equal(incidentLink, 'pending_reconcile_delta:sig-1:order-1:buy:1.23456789');

const clientIncidentLink = buildPendingReconcileDeltaIncidentLink({
  signalId: 'sig-2',
  clientOrderId: 'client-1',
  action: 'SELL',
  targetFilledQty: -1,
});
assert.equal(clientIncidentLink, 'pending_reconcile_delta:sig-2:client-1:sell:0.00000000');

assert.equal(escapePendingReconcileLikePattern('a%b_c\\d'), 'a\\%b\\_c\\\\d');

const normalized = normalizePendingReconcileTradeRow({
  id: 'trade-1',
  signal_id: 'sig-1',
  symbol: 'ORCA/USDT',
  side: 'buy',
  amount: '-1',
  price: '2.5',
  total_usdt: '5',
  paper: 1,
  exchange: null,
  trade_mode: null,
  incident_link: incidentLink,
  partial_exit: true,
  partial_exit_ratio: '0.25',
  remaining_amount: '3',
  execution_origin: null,
  quality_flag: null,
  exclude_from_learning: true,
});

assert.equal(normalized.amount, 0);
assert.equal(normalized.price, 2.5);
assert.equal(normalized.exchange, 'binance');
assert.equal(normalized.tradeMode, 'normal');
assert.equal(normalized.partialExit, true);
assert.equal(normalized.partialExitRatio, 0.25);
assert.equal(normalized.remainingAmount, 3);
assert.equal(normalized.executionOrigin, 'strategy');
assert.equal(normalized.qualityFlag, 'trusted');
assert.equal(normalized.excludeFromLearning, true);

const payload = {
  ok: true,
  smoke: 'hephaestos-pending-reconcile-core',
  incidentLink,
  clientIncidentLink,
  normalized,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('hephaestos-pending-reconcile-core-smoke ok');
}
