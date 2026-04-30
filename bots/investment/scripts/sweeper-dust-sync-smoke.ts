#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildManualDustJournalSyncPlan } from '../team/sweeper.ts';

const baseJournal = {
  exchange: 'binance',
  status: 'open',
  is_paper: false,
  entry_price: 0.01,
  entry_value: 10,
};

const currentDust = buildManualDustJournalSyncPlan({
  walletOnlyRows: [
    { coin: 'TRU', symbol: 'TRU/USDT', total: 0.46, usdt_value: 0.001, class: 'dust' },
  ],
  positions: [],
  openJournals: [
    { ...baseJournal, trade_id: 'journal-tru-1', symbol: 'TRU/USDT', trade_mode: 'normal', entry_size: 1000 },
  ],
});

assert.equal(currentDust.candidates, 1);
assert.equal(currentDust.syncableCount, 0);
assert.equal(currentDust.awaitManualCleanupCount, 1);
assert.equal(currentDust.rows[0].action, 'await_manual_dust_cleanup');

const manualCleaned = buildManualDustJournalSyncPlan({
  walletOnlyRows: [],
  positions: [],
  openJournals: [
    { ...baseJournal, trade_id: 'journal-kat-1', symbol: 'KAT/USDT', trade_mode: 'normal', entry_size: 1, entry_value: 0.1 },
    { ...baseJournal, trade_id: 'journal-kat-2', symbol: 'KAT/USDT', trade_mode: 'normal', entry_size: 2, entry_value: 0.2 },
  ],
});

assert.equal(manualCleaned.candidates, 1);
assert.equal(manualCleaned.syncableCount, 1);
assert.equal(manualCleaned.affectedTradeCount, 2);
assert.equal(manualCleaned.rows[0].action, 'sync_manual_dust_cleaned');

const largeStaleJournal = buildManualDustJournalSyncPlan({
  walletOnlyRows: [],
  positions: [],
  openJournals: [
    { ...baseJournal, trade_id: 'journal-big-1', symbol: 'ORCA/USDT', trade_mode: 'normal', entry_size: 100, entry_value: 120 },
  ],
});
assert.equal(largeStaleJournal.candidates, 0);
assert.equal(largeStaleJournal.nonDustOpenJournalCount, 1);

const protectedByPosition = buildManualDustJournalSyncPlan({
  walletOnlyRows: [],
  positions: [{ symbol: 'KAT/USDT', amount: 1 }],
  openJournals: [
    { ...baseJournal, trade_id: 'journal-kat-1', symbol: 'KAT/USDT', trade_mode: 'normal', entry_size: 1000 },
  ],
});
assert.equal(protectedByPosition.candidates, 0);

const missingConfirm = buildManualDustJournalSyncPlan({
  walletOnlyRows: [],
  positions: [],
  openJournals: [
    { ...baseJournal, trade_id: 'journal-kat-1', symbol: 'KAT/USDT', trade_mode: 'normal', entry_size: 1, entry_value: 0.1 },
  ],
  apply: true,
});
assert.equal(missingConfirm.ok, false);
assert.ok(missingConfirm.blockers.includes('confirmation_required'));

const tooMany = buildManualDustJournalSyncPlan({
  walletOnlyRows: [],
  positions: [],
  openJournals: [
    { ...baseJournal, trade_id: 'journal-kat-1', symbol: 'KAT/USDT', trade_mode: 'normal', entry_size: 1, entry_value: 0.1 },
    { ...baseJournal, trade_id: 'journal-kat-2', symbol: 'KAT/USDT', trade_mode: 'normal', entry_size: 2, entry_value: 0.2 },
  ],
  apply: true,
  confirm: 'sync-manual-dust',
  maxAffectedTrades: 1,
});
assert.equal(tooMany.ok, false);
assert.ok(tooMany.blockers.some((item) => item.startsWith('max_affected_trades_exceeded:')));

const confirmed = buildManualDustJournalSyncPlan({
  walletOnlyRows: [],
  positions: [],
  openJournals: [
    { ...baseJournal, trade_id: 'journal-kat-1', symbol: 'KAT/USDT', trade_mode: 'normal', entry_size: 1, entry_value: 0.1 },
    { ...baseJournal, trade_id: 'journal-kat-2', symbol: 'KAT/USDT', trade_mode: 'normal', entry_size: 2, entry_value: 0.2 },
  ],
  apply: true,
  confirm: 'sync-manual-dust',
  maxAffectedTrades: 2,
});
assert.equal(confirmed.ok, true);
assert.equal(confirmed.syncableCount, 1);

console.log('sweeper dust sync smoke ok');
