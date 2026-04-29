#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildProtectiveOrderRebalancePlan,
  summarizeProtectiveSellOrders,
} from './protective-order-rebalance-plan.ts';

const openOrders = [
  {
    id: 'stop-1',
    clientOrderId: 'oco-stop-1',
    orderListId: 1001,
    side: 'sell',
    type: 'STOP_LOSS_LIMIT',
    status: 'open',
    amount: 213.6,
    remaining: 213.6,
    stopPrice: 0.36,
    price: 0.3599,
  },
  {
    id: 'limit-1',
    clientOrderId: 'oco-limit-1',
    orderListId: 1001,
    side: 'sell',
    type: 'LIMIT_MAKER',
    status: 'open',
    amount: 213.6,
    remaining: 213.6,
    price: 0.4,
  },
  {
    id: 'buy-ignored',
    side: 'buy',
    status: 'open',
    amount: 1,
    remaining: 1,
  },
];

const groups = summarizeProtectiveSellOrders(openOrders);
assert.equal(groups.length, 1);
assert.deepEqual(groups[0].orderIds.sort(), ['limit-1', 'stop-1']);
assert.equal(groups[0].totalRemaining, 427.2);

const lockedPlan = await buildProtectiveOrderRebalancePlan({
  symbol: 'API3/USDT',
  exchange: 'binance',
  tradeMode: 'normal',
  positionAmount: 427.38219,
  estimatedExitAmount: 300.10777382,
}, {
  getBalanceSnapshot: async () => ({
    free: { API3: 0.00219 },
    total: { API3: 427.38219 },
  }),
  getOpenOrders: async () => openOrders,
});

assert.equal(lockedPlan.ok, true);
assert.equal(lockedPlan.status, 'protective_rebalance_required');
assert.equal(lockedPlan.executableNow, false);
assert.equal(lockedPlan.requiresLiveMutation, true);
assert.equal(lockedPlan.mutationExecuted, false);
assert.equal(lockedPlan.recommendedPlan.approvalRequired, true);
assert.deepEqual(lockedPlan.recommendedPlan.cancelOrderIds.sort(), ['limit-1', 'stop-1']);
assert.equal(lockedPlan.balances.residualPositionAmount, 127.27441618);

const clearPlan = await buildProtectiveOrderRebalancePlan({
  symbol: 'API3/USDT',
  exchange: 'binance',
  tradeMode: 'normal',
  positionAmount: 427.38219,
  estimatedExitAmount: 100,
}, {
  getBalanceSnapshot: async () => ({
    free: { API3: 120 },
    total: { API3: 427.38219 },
  }),
  getOpenOrders: async () => [],
});

assert.equal(clearPlan.status, 'protective_rebalance_not_required');
assert.equal(clearPlan.executableNow, true);
assert.equal(clearPlan.requiresLiveMutation, false);
assert.equal(clearPlan.recommendedPlan.policy, 'partial_adjust_can_execute_without_rebalance');

console.log(JSON.stringify({
  ok: true,
  smoke: 'protective-order-rebalance-plan',
  locked: lockedPlan.status,
  clear: clearPlan.status,
}, null, 2));
