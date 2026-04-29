#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { ACTIONS, SIGNAL_STATUS } from '../shared/signal.ts';
import { createBtcPairDirectBuyPolicy } from '../team/hephaestos/btc-pair-direct-buy.ts';

const writes = {
  positions: [],
  trades: [],
  signalUpdates: [],
  notifications: [],
};

const fakeDb = {
  getLivePosition: async () => null,
  upsertPosition: async (row) => writes.positions.push(row),
  insertTrade: async (row) => writes.trades.push(row),
  updateSignalStatus: async (...args) => writes.signalUpdates.push(args),
};

const fakeExchange = {
  fetchBalance: async () => ({ free: { BTC: 0.02 } }),
  loadMarkets: async () => ({ 'ETH/BTC': { symbol: 'ETH/BTC' } }),
  fetchTicker: async (symbol) => {
    if (symbol === 'ETH/BTC') return { last: 0.05 };
    return { last: 0 };
  },
};

const policy = createBtcPairDirectBuyPolicy({
  ACTIONS,
  SIGNAL_STATUS,
  db: fakeDb,
  getInvestmentTradeMode: () => 'normal',
  getCapitalConfig: () => ({}),
  getDynamicMinOrderAmount: async () => 50,
  getExchange: () => fakeExchange,
  fetchTicker: async (symbol) => symbol === 'BTC/USDT' ? 50000 : symbol === 'ETH/USDT' ? 2500 : 0,
  buildDeterministicClientOrderId: () => 'ln_b_btc_pair_ethbtc_sig',
  normalizeBinanceMarketOrderExecution: async () => { throw new Error('not expected in paper smoke'); },
  buildBtcPairPendingReconcileError: (cause) => cause,
  extractExchangeOrderId: () => null,
  extractClientOrderId: () => null,
  normalizeProtectiveExitPrices: (_symbol, _entry, tpPrice, slPrice, tpslSource) => ({ tpPrice, slPrice, tpslSource }),
  buildProtectionSnapshot: () => ({ protectionMode: 'paper' }),
  placeBinanceProtectiveExit: async () => ({ ok: true }),
  isStopLossOnlyMode: () => false,
  notifyError: async () => {},
  notifyTrade: async (row) => writes.notifications.push(row),
  buildSignalQualityContext: () => ({ signalQuality: 'smoke' }),
});

const result = await policy.tryBuyWithBtcPair(
  'ETH/USDT',
  'ETH',
  'sig-btc-pair-1',
  { trade_mode: 'validation' },
  true,
);

assert.equal(result.success, true);
assert.equal(result.btcDirect, true);
assert.equal(result.btcPair, 'ETH/BTC');
assert.equal(Math.abs(result.amount - 0.4) < 1e-12, true);
assert.equal(result.price, 2500);
assert.equal(writes.positions.length, 1);
assert.equal(writes.positions[0].tradeMode, 'validation');
assert.equal(writes.trades.length, 1);
assert.equal(Math.abs(writes.trades[0].totalUsdt - 1000) < 1e-9, true);
assert.equal(writes.trades[0].protectionMode, 'paper');
assert.deepEqual(writes.signalUpdates[0], ['sig-btc-pair-1', SIGNAL_STATUS.EXECUTED]);
assert.equal(writes.notifications[0].memo.includes('BTC 직접 매수'), true);

const noPairPolicy = createBtcPairDirectBuyPolicy({
  ...policy,
  ACTIONS,
  SIGNAL_STATUS,
  db: fakeDb,
  getInvestmentTradeMode: () => 'normal',
  getDynamicMinOrderAmount: async () => 50,
  getExchange: () => ({
    ...fakeExchange,
    loadMarkets: async () => ({}),
  }),
  fetchTicker: async (symbol) => symbol === 'BTC/USDT' ? 50000 : 0,
});
const noPair = await noPairPolicy.tryBuyWithBtcPair('KITE/USDT', 'KITE', 'sig-no-pair', {}, true);
assert.equal(noPair, null);

const payload = {
  ok: true,
  smoke: 'hephaestos-btc-pair-direct-buy',
  checked: ['paper_btc_pair_buy', 'usdt_valuation', 'no_pair_fallback'],
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('✅ hephaestos BTC pair direct buy smoke passed');
}
