#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { createTelegramTradeAlerts } from '../team/hephaestos/telegram-trade-alerts.ts';

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
      linkRationaleToTrade: async (...args) => calls.push(['linkRationaleToTrade', ...args]),
    },
    notifySettlement: async (payload) => calls.push(['notifySettlement', payload]),
    notifyTrade: async (payload) => calls.push(['notifyTrade', payload]),
    notifyJournalEntry: async (payload) => calls.push(['notifyJournalEntry', payload]),
    getInvestmentTradeMode: () => 'normal',
    normalizePartialExitRatio: (value) => Number(value || 1),
    isEffectivePartialExit: ({ entrySize, soldAmount, partialExitRatio }) => (
      Number(partialExitRatio || 1) > 0
      && Number(partialExitRatio || 1) < 1
      && Number(soldAmount || 0) > 0
      && Number(soldAmount || 0) < Number(entrySize || 0)
    ),
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
  },
});
const buyEntry = calls.find((item) => item[0] === 'insertJournalEntry')?.[1];
assert.equal(buyEntry.strategy_family, 'breakout');
assert.equal(calls.some((item) => item[0] === 'notifyJournalEntry'), true);

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
  cleanupSuppressed: true,
  finalizeSynced: true,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('✅ hephaestos telegram trade alerts smoke passed');
}
