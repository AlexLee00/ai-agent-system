#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildScopeMap,
  entryAgeHours,
  scopeKey,
  summarizeReconcileResults,
  tolerance,
} from './reconcile-open-journals.ts';

const entry = {
  exchange: 'binance',
  symbol: 'PHA/USDT',
  is_paper: false,
  trade_mode: 'validation',
  entry_time: Date.now() - 7 * 3600000,
};

assert.equal(scopeKey(entry), 'binance:PHA/USDT:live:validation');
assert.ok(tolerance(100) >= 1);
assert.ok(entryAgeHours(entry) >= 6.9);

const grouped = buildScopeMap([
  { ...entry, trade_id: 'old', entry_time: Date.now() - 10_000 },
  { ...entry, trade_id: 'new', entry_time: Date.now() },
]);
assert.equal(grouped.size, 1);
assert.equal(grouped.get(scopeKey(entry))[0].trade_id, 'new');

const summary = summarizeReconcileResults([
  { action: 'close_all_no_position', closedTradeIds: ['a', 'b'] },
  { action: 'close_stale_duplicates', staleTradeIds: ['c'] },
  { action: 'observe_latest_mismatch', openTradeIds: ['d'] },
]);
assert.equal(summary.affectedTradeCount, 3);
assert.equal(summary.noPositionScopes, 1);
assert.equal(summary.duplicateScopes, 1);
assert.equal(summary.observeScopes, 1);

console.log('reconcile open journals smoke ok');
