#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildLatestMismatchManualPlan,
  buildScopeMap,
  buildWriteImpactGuard,
  collectProtectiveOrderIds,
  deriveExpectedExitSide,
  entryAgeHours,
  isDustNoPositionScope,
  normalizeReconcileOpenJournalsMarket,
  parseReconcileOpenJournalsArgs,
  pickMatchingSellTradeForOpenScope,
  reconcileOpenJournals,
  RECONCILE_OPEN_JOURNAL_MARKETS,
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
assert.equal(isDustNoPositionScope(0.05, 1), true);
assert.equal(isDustNoPositionScope(1.01, 1), false);
assert.equal(deriveExpectedExitSide('BUY'), 'sell');
assert.equal(deriveExpectedExitSide('short'), 'buy');
assert.deepEqual(collectProtectiveOrderIds([
  { sl_order_id: 'sl-1', tp_order_id: 'tp-1' },
  { sl_order_id: 'sl-1', tp_order_id: null },
]), ['sl-1', 'tp-1']);

const grouped = buildScopeMap([
  { ...entry, trade_id: 'old', entry_time: Date.now() - 10_000 },
  { ...entry, trade_id: 'new', entry_time: Date.now() },
]);
assert.equal(grouped.size, 1);
assert.equal(grouped.get(scopeKey(entry))[0].trade_id, 'new');

const summary = summarizeReconcileResults([
  { action: 'close_all_no_position', closedTradeIds: ['a', 'b'] },
  { action: 'close_all_no_position_from_sell_trade', closedTradeIds: ['e'] },
  { action: 'close_stale_duplicates', staleTradeIds: ['c'] },
  { action: 'observe_latest_mismatch', openTradeIds: ['d'] },
]);
assert.equal(summary.affectedTradeCount, 4);
assert.equal(summary.noPositionScopes, 2);
assert.equal(summary.duplicateScopes, 1);
assert.equal(summary.observeScopes, 1);

const sellTrade = pickMatchingSellTradeForOpenScope([
  { id: 'too-large', amount: 14 },
  { id: 'exact', amount: 2 },
], 2);
assert.equal(sellTrade.id, 'exact');

const mismatchPlan = buildLatestMismatchManualPlan({
  scope: 'binance:APE/USDT:live:normal',
  latestEntry: { trade_id: 'latest', signal_id: 'sig-latest', symbol: 'APE/USDT', entry_size: 0.003, entry_value: 0.001, entry_price: 0.153 },
  rows: [
    { trade_id: 'latest', signal_id: 'sig-latest', entry_time: 2, entry_size: 0.003, entry_value: 0.001, entry_price: 0.153 },
    { trade_id: 'stale', signal_id: 'sig-stale', entry_time: 1, entry_size: 784.6, entry_value: 126.63, entry_price: 0.1614 },
  ],
  targetQty: 799.653,
  totalQty: 1539.833,
});
assert.equal(mismatchPlan.manualOnly, true);
assert.equal(mismatchPlan.writeSafe, false);
assert.equal(mismatchPlan.recommendedAction, 'manual_review_trade_journal_before_write');
assert.equal(mismatchPlan.openRows.length, 2);
assert.equal(mismatchPlan.openTradeIds.includes('stale'), true);

const impactGuard = buildWriteImpactGuard({ affectedTradeCount: 11 }, 10);
assert.equal(impactGuard.blocked, true);
assert.equal(impactGuard.reason, 'max_affected_trades_exceeded');
assert.equal(buildWriteImpactGuard({ affectedTradeCount: 10 }, 10), null);

const parsedOverseas = parseReconcileOpenJournalsArgs(['--market=overseas', '--symbols=POET,AAPL']);
assert.equal(parsedOverseas.market, 'overseas');
assert.deepEqual(parsedOverseas.symbols, ['POET', 'AAPL']);
assert.equal(parseReconcileOpenJournalsArgs(['--market=all']).market, 'all');
assert.equal(parseReconcileOpenJournalsArgs(['--market=kis']).market, 'domestic');
assert.equal(normalizeReconcileOpenJournalsMarket('KIS'), 'domestic');
const parsedDust = parseReconcileOpenJournalsArgs(['--dust-close-max-value-usdt=0.5']);
assert.equal(parsedDust.dustCloseMaxValueUsdt, 0.5);

const fixtureByMarket = {
  crypto: {
    ok: true,
    market: 'crypto',
    totalScopes: 1,
    candidates: 1,
    results: [{ action: 'close_all_no_position', closedTradeIds: ['c-1'] }],
    summary: summarizeReconcileResults([{ action: 'close_all_no_position', closedTradeIds: ['c-1'] }]),
  },
  domestic: {
    ok: true,
    market: 'domestic',
    totalScopes: 2,
    candidates: 1,
    results: [{ action: 'close_stale_duplicates', staleTradeIds: ['d-1'] }],
    summary: summarizeReconcileResults([{ action: 'close_stale_duplicates', staleTradeIds: ['d-1'] }]),
  },
  overseas: {
    ok: true,
    market: 'overseas',
    totalScopes: 3,
    candidates: 1,
    results: [{ action: 'observe_latest_mismatch', openTradeIds: ['o-1'] }],
    summary: summarizeReconcileResults([{ action: 'observe_latest_mismatch', openTradeIds: ['o-1'] }]),
  },
};

const calledMarkets = [];
const allDryRun = await reconcileOpenJournals({
  market: 'all',
  marketRunner: async ({ market }) => {
    calledMarkets.push(market);
    return fixtureByMarket[market];
  },
});
assert.deepEqual(calledMarkets, RECONCILE_OPEN_JOURNAL_MARKETS);
assert.equal(allDryRun.market, 'all');
assert.equal(allDryRun.totalScopes, 6);
assert.equal(allDryRun.candidates, 3);
assert.equal(allDryRun.summary.affectedTradeCount, 2);
assert.equal(allDryRun.summary.observeScopes, 1);

const guardCalls = [];
const allWriteBlocked = await reconcileOpenJournals({
  dryRun: false,
  confirmLive: true,
  market: 'all',
  maxAffectedTrades: 1,
  marketRunner: async ({ market, dryRun }) => {
    guardCalls.push(`${market}:${dryRun ? 'dry' : 'write'}`);
    return fixtureByMarket[market];
  },
});
assert.equal(allWriteBlocked.blocked, true);
assert.equal(allWriteBlocked.reason, 'max_affected_trades_exceeded');
assert.deepEqual(guardCalls, RECONCILE_OPEN_JOURNAL_MARKETS.map((market) => `${market}:dry`));

const blocked = await reconcileOpenJournals({ dryRun: false, confirmLive: false });
assert.equal(blocked.ok, false);
assert.equal(blocked.blocked, true);
assert.equal(blocked.reason, 'confirm_live_required');

console.log('reconcile open journals smoke ok');
