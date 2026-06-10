#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildCryptoPartialAdjustPreflight,
  getStrategyAwarePartialExitRatio,
} from './partial-adjust-runner.ts';

const locked = await buildCryptoPartialAdjustPreflight({
  symbol: 'API3/USDT',
  estimatedExitAmount: 300,
}, {
  getBalanceSnapshot: async () => ({
    free: { API3: 0 },
    total: { API3: 427.38219 },
  }),
  getOpenOrders: async () => ([
    { symbol: 'API3/USDT', side: 'sell', status: 'open', remaining: 213.6 },
    { symbol: 'API3/USDT', side: 'sell', status: 'open', remaining: 213.78 },
  ]),
});

assert.equal(locked.ok, false);
assert.equal(locked.code, 'partial_adjust_balance_locked_by_open_sell_orders');
assert.equal(locked.openSellOrders, 2);

const clear = await buildCryptoPartialAdjustPreflight({
  symbol: 'API3/USDT',
  estimatedExitAmount: 100,
}, {
  getBalanceSnapshot: async () => ({
    free: { API3: 120 },
    total: { API3: 427.38219 },
  }),
  getOpenOrders: async () => ([]),
});

assert.equal(clear.ok, true);
assert.equal(clear.code, 'partial_adjust_crypto_preflight_clear');

const peakPolicyRatio = getStrategyAwarePartialExitRatio(
  'trend_following_trail',
  { setup_type: 'trend_following' },
  {
    deterministicExitPolicy: {
      symbolExitPolicy: {
        policy: 'peak_reversal_partial_trailing',
        priority: 'P0',
        effects: {
          partialProfit: 'prefer_partial_lock',
          trailingStop: 'tighten',
        },
      },
    },
  },
);
assert.equal(peakPolicyRatio, 0.5);

const continuationPolicyRatio = getStrategyAwarePartialExitRatio(
  'profit_lock_candidate',
  { setup_type: 'trend_following' },
  {
    deterministicExitPolicy: {
      symbolExitPolicy: {
        policy: 'winner_continuation_trailing',
        priority: 'P1',
        effects: {
          partialProfit: 'prefer_partial_take_profit',
          trailingStop: 'loosen_for_continuation',
        },
      },
    },
  },
);
assert.equal(continuationPolicyRatio, 0.25);

console.log(JSON.stringify({
  ok: true,
  smoke: 'partial-adjust-preflight-balance',
  locked: locked.code,
  clear: clear.code,
  peakPolicyRatio,
  continuationPolicyRatio,
}, null, 2));
