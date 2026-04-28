#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  allocateStockQuantities,
  buildRowsForBrokerHolding,
  estimatePositionNotionalUsdt,
  isMeaningfulTrackedPosition,
  normalizeBrokerQuantityForMarket,
  normalizeHolding,
} from '../shared/position-sync.ts';
import {
  buildParityRows,
  parseSyncMarkets,
  summarize,
} from './runtime-position-parity-report.ts';

const dust = {
  symbol: 'PHA/USDT',
  amount: 0.046,
  avg_price: 0.0317,
  unrealized_pnl: 0.0001,
};
assert.equal(Number(estimatePositionNotionalUsdt(dust).toFixed(6)), 0.001458);
assert.equal(isMeaningfulTrackedPosition(dust, 10), false);

const dustWithStaleJournal = {
  ...dust,
  openJournalSize: 1000,
};
assert.equal(isMeaningfulTrackedPosition(dustWithStaleJournal, 10), false);

const managed = {
  symbol: 'KITE/USDT',
  amount: 160,
  avg_price: 0.57,
};
assert.equal(isMeaningfulTrackedPosition(managed, 10), true);

const explicit = {
  symbol: 'ZEC/USDT',
  amount: 0,
  avg_price: 0,
  notional: 42,
};
assert.equal(estimatePositionNotionalUsdt(explicit), 42);
assert.equal(isMeaningfulTrackedPosition(explicit, 10), true);

const parityRows = buildParityRows({
  walletMap: new Map([
    ['PHA/USDT', { symbol: 'PHA/USDT', total: 0.046, free: 0.046, used: 0 }],
  ]),
  dbMap: new Map(),
  journalMap: new Map([
    ['PHA/USDT', { openSize: 1000, openValue: 31.7, avgPrice: 0.0317, openCount: 1 }],
  ]),
  tickerMap: {
    'PHA/USDT': { last: 0.0317 },
  },
  dustThresholdUsdt: 10,
});
assert.equal(parityRows[0].class, 'wallet_journal_dust');
assert.equal(summarize(parityRows).walletJournalDust, 1);
assert.equal(summarize(parityRows).walletJournalOnly, 0);

assert.equal(normalizeBrokerQuantityForMarket('domestic', 9.9), 9);
assert.equal(normalizeBrokerQuantityForMarket('overseas', 13.7), 13);
assert.equal(normalizeBrokerQuantityForMarket('crypto', 0.12345678), 0.12345678);

const overseasHolding = normalizeHolding('overseas', {
  symbol: 'POET',
  qty: 13.9,
  avg_price: 11.79,
  pnl_usd: -4,
});
assert.equal(overseasHolding.qty, 13);

assert.deepEqual(allocateStockQuantities(13.9, [
  { amount: 10 },
  { amount: 4 },
]), [9, 4]);

const overseasRows = buildRowsForBrokerHolding('overseas', overseasHolding, [
  { amount: 10, avg_price: 11, trade_mode: 'normal' },
  { amount: 4, avg_price: 12, trade_mode: 'defensive' },
]);
assert.equal(overseasRows.reduce((sum, row) => sum + row.amount, 0), 13);
assert.equal(overseasRows.every((row) => Number.isInteger(row.amount)), true);

const cryptoRows = buildRowsForBrokerHolding('crypto', {
  symbol: 'KITE/USDT',
  qty: 0.12345678,
  avgPrice: 0.57,
  unrealizedPnl: 0,
  notional: 0.0703703646,
}, [
  { amount: 0.12345678, avg_price: 0.57, trade_mode: 'normal' },
]);
assert.equal(cryptoRows[0].amount, 0.12345678);

assert.deepEqual(parseSyncMarkets([]), ['crypto']);
assert.deepEqual(parseSyncMarkets(['--markets=all']), ['domestic', 'overseas', 'crypto']);
assert.deepEqual(parseSyncMarkets(['--markets=overseas,crypto,unknown']), ['overseas', 'crypto']);

console.log('position sync dust smoke ok');
