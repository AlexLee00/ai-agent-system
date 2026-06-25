#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { createTelegramTradeAlerts } from '../team/hephaestos/telegram-trade-alerts.ts';
import { isEffectivePartialExit, normalizePartialExitRatio } from '../team/hephaestos/partial-exit-policy.ts';

const calls = [];
let tradeIdSeq = 0;

function buildAlerts({
  openEntries = [],
  signal = null,
} = {}) {
  calls.length = 0;
  tradeIdSeq = 0;
  return createTelegramTradeAlerts({
    SIGNAL_STATUS: { EXECUTED: 'executed' },
    db: {
      get: async () => ({ pnl: 12, total_trades: 4, wins: 3 }),
      run: async (...args) => calls.push(['run', ...args]),
      insertTrade: async (trade) => calls.push(['insertTrade', trade]),
      updateSignalStatus: async (...args) => calls.push(['updateSignalStatus', ...args]),
      updateSignalBlock: async (...args) => calls.push(['updateSignalBlock', ...args]),
      getSignalById: async () => signal,
    },
    journalDb: {
      getOpenJournalEntries: async () => openEntries,
      ratioToPercent: (value) => value * 100,
      closeJournalEntry: async (...args) => calls.push(['closeJournalEntry', ...args]),
      ensureAutoReview: async (...args) => calls.push(['ensureAutoReview', ...args]),
      getReviewByTradeId: async () => ({ max_favorable: 7, max_adverse: -2, signal_accuracy: 0.8, execution_speed: 0.9 }),
      generateTradeId: async () => `TRD-${++tradeIdSeq}`,
      insertJournalEntry: async (entry) => calls.push(['insertJournalEntry', entry]),
      getJournalEntryByTradeId: async (tradeId) => {
        const inserted = calls.find((item) => item[0] === 'insertJournalEntry' && item[1]?.trade_id === tradeId);
        return inserted?.[1] || null;
      },
      linkRationaleToTrade: async (...args) => calls.push(['linkRationaleToTrade', ...args]),
    },
    notifySettlement: async (payload) => calls.push(['notifySettlement', payload]),
    notifyTrade: async (payload) => calls.push(['notifyTrade', payload]),
    notifyJournalEntry: async (payload) => calls.push(['notifyJournalEntry', payload]),
    getInvestmentTradeMode: () => 'normal',
    normalizePartialExitRatio,
    isEffectivePartialExit,
    getAvailableBalance: async () => 1000,
    getOpenPositions: async () => [{ symbol: 'ORCA/USDT' }],
    getDailyPnL: async () => 15,
    syncPositionsAtMarketOpen: async (...args) => calls.push(['syncPositionsAtMarketOpen', ...args]),
  });
}

const openEntry = {
  trade_id: 'OPEN-1',
  signal_id: 'sig-open',
  market: 'crypto',
  exchange: 'binance',
  symbol: 'ORCA/USDT',
  is_paper: false,
  trade_mode: 'normal',
  entry_time: Date.now() - 2 * 60 * 60 * 1000,
  entry_price: 10,
  entry_size: 10,
  entry_value: 100,
  direction: 'long',
};

const settlementAlerts = buildAlerts({ openEntries: [openEntry] });
await settlementAlerts.closeOpenJournalForSymbol('ORCA/USDT', false, 12, 120, 'signal_reverse', 'normal');
assert.equal(calls.find((item) => item[0] === 'closeJournalEntry')?.[1], 'OPEN-1');
assert.equal(calls.find((item) => item[0] === 'notifySettlement')?.[1]?.pnl, 20);
assert.equal(calls.find((item) => item[0] === 'notifySettlement')?.[1]?.winRate, 0.75);

const buyJournalAlerts = buildAlerts({
  signal: {
    trade_mode: 'validation',
    strategy_family: 'breakout',
    strategy_quality: 'high',
    strategy_readiness: 0.8,
    strategy_route: 'smoke',
  },
});
await buyJournalAlerts.recordExecutedTradeJournal({
  signalId: 'sig-buy',
  trade: {
    side: 'buy',
    symbol: 'ORCA/USDT',
    exchange: 'binance',
    paper: false,
    price: 10,
    amount: 4,
    totalUsdt: 40,
    tradeMode: 'validation',
  },
});
const buyEntry = calls.find((item) => item[0] === 'insertJournalEntry')?.[1];
assert.equal(buyEntry.strategy_family, 'breakout');
assert.equal(buyEntry.trade_mode, 'validation');
assert.equal(calls.some((item) => item[0] === 'notifyJournalEntry'), true);

const validationOpenEntry = {
  ...openEntry,
  trade_id: 'OPEN-VALIDATION-1',
  symbol: 'BTC/USDT',
  trade_mode: 'validation',
  entry_size: 0.0006,
  entry_value: 48,
};
const unifiedScopeAlerts = buildAlerts({ openEntries: [validationOpenEntry] });
await unifiedScopeAlerts.settleOpenJournalForSell('BTC/USDT', false, 80000, 50, 'target', 'normal', {
  soldAmount: 0.0006,
});
assert.equal(calls.find((item) => item[0] === 'closeJournalEntry')?.[1], 'OPEN-VALIDATION-1');

const multiModeAmountMatchAlerts = buildAlerts({
  openEntries: [
    validationOpenEntry,
    {
      ...validationOpenEntry,
      trade_id: 'OPEN-VALIDATION-2',
      entry_size: 0.00062,
      entry_value: 49,
    },
  ],
});
const multiModeSettlement = await multiModeAmountMatchAlerts.settleOpenJournalForSell('BTC/USDT', false, 81254, 49.5, 'target', 'normal', {
  soldAmount: 0.0006,
});
assert.equal(multiModeSettlement.updated, true);
assert.equal(multiModeSettlement.matchType, 'cross_trade_mode_amount');
assert.equal(calls.find((item) => item[0] === 'closeJournalEntry')?.[1], 'OPEN-VALIDATION-1');

const feeDustOpenEntry = {
  ...openEntry,
  trade_id: 'OPEN-FEE-DUST',
  symbol: 'PSG/USDT',
  entry_price: 1.0213867211440246,
  entry_size: 48.95,
  entry_value: 49.99688,
};
const feeDustAlerts = buildAlerts({ openEntries: [feeDustOpenEntry] });
await feeDustAlerts.settleOpenJournalForSell('PSG/USDT', false, 1.022, 49.9758, 'normal_exit', 'normal', {
  soldAmount: 48.9,
});
assert.equal(calls.find((item) => item[0] === 'closeJournalEntry')?.[1], 'OPEN-FEE-DUST');
assert.equal(calls.some((item) => item[0] === 'insertJournalEntry'), false);

const intentionalPartialOpenEntry = {
  ...openEntry,
  trade_id: 'OPEN-PARTIAL',
  symbol: 'ETH/USDT',
  entry_price: 100,
  entry_size: 1,
  entry_value: 100,
};
const intentionalPartialAlerts = buildAlerts({ openEntries: [intentionalPartialOpenEntry] });
await intentionalPartialAlerts.settleOpenJournalForSell('ETH/USDT', false, 110, 55, 'partial_profit', 'normal', {
  soldAmount: 0.5,
  partialExitRatio: 0.5,
});
assert.equal(calls.find((item) => item[0] === 'insertJournalEntry')?.[1]?.trade_id, 'TRD-1');
assert.equal(calls.find((item) => item[0] === 'run')?.[1]?.includes('UPDATE trade_journal'), true);

const suppressedAlerts = buildAlerts();
await suppressedAlerts.recordExecutedTradeJournal({
  signalId: 'sig-cleanup',
  trade: {
    side: 'buy',
    symbol: 'DUST/USDT',
    exchange: 'binance',
    paper: false,
    price: 1,
    amount: 1,
    totalUsdt: 1,
    executionOrigin: 'cleanup',
    excludeFromLearning: true,
  },
});
assert.equal(calls.some((item) => item[0] === 'notifyJournalEntry'), false);

const deltaAlerts = buildAlerts();
const deltaResult = await deltaAlerts.recordExecutedTradeJournal({
  signalId: 'sig-delta',
  trade: {
    side: 'buy',
    symbol: 'ORCA/USDT',
    exchange: 'binance',
    paper: false,
    price: 1.78,
    amount: 8,
    totalUsdt: 14.24,
    incidentLink: 'pending_reconcile_delta:sig-delta:ORD-DELTA:buy:8.00000000',
  },
});
assert.equal(deltaResult.skipped, true);
assert.equal(deltaResult.reason, 'pending_reconcile_delta_journal_skipped');
assert.equal(calls.some((item) => item[0] === 'insertJournalEntry'), false);

const unsafeDeltaOpenEntry = {
  ...openEntry,
  trade_id: 'OPEN-DELTA',
  symbol: 'ORCA/USDT',
  entry_price: 1.78,
  entry_size: 8,
  entry_value: 14.24,
  incident_link: 'pending_reconcile_delta:sig-delta:ORD-DELTA:buy:8.00000000',
};
const unsafeDeltaAlerts = buildAlerts({ openEntries: [unsafeDeltaOpenEntry] });
const unsafeDeltaSettlement = await unsafeDeltaAlerts.settleOpenJournalForSell('ORCA/USDT', false, 11.8575, 94.86, 'signal_reverse', 'normal', {
  soldAmount: 8,
});
assert.equal(unsafeDeltaSettlement.updated, false);
assert.equal(unsafeDeltaSettlement.reason, 'pending_reconcile_delta_journal_close_blocked');
assert.equal(calls.some((item) => item[0] === 'closeJournalEntry'), false);

const finalizeAlerts = buildAlerts({ openEntries: [openEntry] });
await finalizeAlerts.finalizeExecutedTrade({
  signalId: 'sig-sell',
  signalTradeMode: 'normal',
  capitalPolicy: { max_concurrent_positions: 5 },
  exitReason: 'target',
  hephaestosRoleState: { mission: 'full_exit_cleanup' },
  trade: {
    signalId: 'sig-sell',
    side: 'sell',
    symbol: 'ORCA/USDT',
    exchange: 'binance',
    tradeMode: 'normal',
    paper: false,
    price: 12,
    amount: 10,
    totalUsdt: 120,
    partialExit: false,
  },
});
assert.equal(calls.find((item) => item[0] === 'insertTrade')?.[1]?.side, 'sell');
assert.equal(calls.find((item) => item[0] === 'updateSignalStatus')?.[2], 'executed');
assert.equal(calls.some((item) => item[0] === 'notifyTrade'), true);
assert.equal(calls.find((item) => item[0] === 'syncPositionsAtMarketOpen')?.[1], 'crypto');

const payload = {
  ok: true,
  smoke: 'hephaestos-telegram-trade-alerts',
  settlementClosed: true,
  buyJournalStrategy: buyEntry.strategy_family,
  buyJournalTradeMode: buyEntry.trade_mode,
  unifiedLiveScopeClosed: true,
  multiModeAmountMatched: true,
  feeDustClosedAsFull: true,
  intentionalPartialRecorded: true,
  cleanupSuppressed: true,
  pendingReconcileDeltaJournalSkipped: true,
  pendingReconcileDeltaCloseBlocked: true,
  finalizeSynced: true,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('✅ hephaestos telegram trade alerts smoke passed');
}
