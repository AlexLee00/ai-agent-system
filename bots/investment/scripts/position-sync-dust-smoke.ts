#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  estimatePositionNotionalUsdt,
  isMeaningfulTrackedPosition,
} from '../shared/position-sync.ts';
import {
  buildParityRows,
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

console.log('position sync dust smoke ok');
