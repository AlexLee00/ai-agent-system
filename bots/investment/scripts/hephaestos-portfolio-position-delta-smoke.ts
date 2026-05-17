#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { createPortfolioPositionDelta } from '../team/hephaestos/portfolio-position-delta.ts';

const calls = [];

function buildDelta({
  marketSellResult = null,
  assetBalances = { totalBalance: 0, freeBalance: 0 },
  openJournalEntries = null,
} = {}) {
  calls.length = 0;
  const journalEntries = openJournalEntries || [
    {
      trade_id: 'TRD-1',
      symbol: 'ORCA/USDT',
      is_paper: false,
      trade_mode: 'normal',
      entry_size: 10,
      entry_value: 100,
    },
  ];
  return createPortfolioPositionDelta({
    ACTIONS: { SELL: 'SELL' },
    db: {
      deletePosition: async (...args) => calls.push(['deletePosition', ...args]),
      updateSignalBlock: async (...args) => calls.push(['updateSignalBlock', ...args]),
      run: async (...args) => calls.push(['run', ...args]),
      query: async () => [{ amount: 2, avg_price: 9, trade_mode: 'normal' }],
      upsertPosition: async (...args) => calls.push(['upsertPosition', ...args]),
    },
    journalDb: {
      getOpenJournalEntries: async () => journalEntries,
    },
    getInvestmentTradeMode: () => 'normal',
    fetchAssetBalances: async () => assetBalances,
    marketSell: async (...args) => {
      calls.push(['marketSell', ...args]);
      return marketSellResult || {
      filled: 4,
      price: 12,
      cost: 48,
      status: 'closed',
      };
    },
    buildDeterministicClientOrderId: ({ scope }) => `ln_s_${scope}_smoke`,
    normalizePartialExitRatio: (value) => {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0 || n >= 1) return 1;
      return Number(n.toFixed(4));
    },
    isEffectivePartialExit: ({ entrySize, soldAmount, partialExitRatio }) =>
      Number(entrySize || 0) > 0 && Number(soldAmount || 0) < Number(entrySize || 0) && Number(partialExitRatio || 1) < 1,
    syncCryptoStrategyExecutionState: async (...args) => calls.push(['syncStrategy', ...args]),
    tryConvertResidualDustToUsdt: async (...args) => {
      calls.push(['convertDust', ...args]);
      return true;
    },
  });
}

const dustDelta = buildDelta();
await dustDelta.cleanupDustLivePosition('ORCA/USDT', { exchange: 'binance', amount: 0.0001 }, 'normal', {
  signalId: 'sig-dust',
  freeBalance: 0.0001,
  roundedAmount: 0,
  minSellAmount: 1,
});
assert.equal(calls[0][0], 'deletePosition');
assert.equal(calls[1][0], 'updateSignalBlock');
assert.equal(calls[1][2].code, 'dust_position_cleaned');

const journalDelta = buildDelta();
const journal = await journalDelta.reconcileOpenJournalToTrackedAmount('ORCA/USDT', false, 4, 'normal');
assert.equal(journal.tradeId, 'TRD-1');
assert.equal(journal.toSize, 4);
assert.equal(calls[0][0], 'run');

const buyDelta = buildDelta({ assetBalances: { totalBalance: 7, freeBalance: 7 } });
await buyDelta.persistBuyPosition({
  symbol: 'ORCA/USDT',
  order: { filled: 4, price: 10 },
  effectivePaperMode: false,
  signalTradeMode: 'normal',
});
const buyUpsert = calls.find((item) => item[0] === 'upsertPosition');
assert.equal(buyUpsert[1].amount, 7);
assert.equal(Math.round(buyUpsert[1].avgPrice * 1000) / 1000, 9.714);

const sellDelta = buildDelta({ assetBalances: { totalBalance: 0, freeBalance: 0 } });
const partialTrade = await sellDelta.executeSellTrade({
  signalId: 'sig-sell',
  symbol: 'ORCA/USDT',
  amount: 4,
  sellPaperMode: false,
  effectivePositionTradeMode: 'normal',
  position: { amount: 10, avg_price: 8, unrealized_pnl: 20 },
  sourcePositionAmount: 10,
  partialExitRatio: 0.4,
});
assert.equal(partialTrade.partialExit, true);
assert.equal(partialTrade.remainingAmount, 6);
assert.ok(calls.some((item) => item[0] === 'syncStrategy'));

const fullSellDelta = buildDelta({ assetBalances: { totalBalance: 0.0002, freeBalance: 0.0002 } });
const fullTrade = await fullSellDelta.executeSellTrade({
  signalId: 'sig-full',
  symbol: 'ORCA/USDT',
  amount: 10,
  sellPaperMode: false,
  effectivePositionTradeMode: 'normal',
  position: { amount: 10, avg_price: 8, unrealized_pnl: 20 },
  sourcePositionAmount: 10,
  partialExitRatio: 1,
});
assert.equal(fullTrade.partialExit, false);
assert.ok(calls.some((item) => item[0] === 'deletePosition'));
assert.ok(calls.some((item) => item[0] === 'convertDust'));

const missingJournalDelta = buildDelta({ openJournalEntries: [] });
await assert.rejects(
  missingJournalDelta.executeSellTrade({
    signalId: 'sig-missing-journal',
    symbol: 'ORCA/USDT',
    amount: 10,
    sellPaperMode: false,
    effectivePositionTradeMode: 'normal',
    position: { amount: 10, avg_price: 8, unrealized_pnl: 20 },
    sourcePositionAmount: 10,
    partialExitRatio: 1,
  }),
  (error) => error?.code === 'journal_open_entry_missing_for_sell',
);
assert.equal(calls.some((item) => item[0] === 'marketSell'), false);

const crossModeDelta = buildDelta({
  marketSellResult: {
    filled: 921.5775,
    price: 0.054,
    cost: 49.765185,
    status: 'closed',
  },
  assetBalances: { totalBalance: 0, freeBalance: 0 },
  openJournalEntries: [{
    trade_id: 'TRD-KAIA-VALIDATION',
    symbol: 'KAIA/USDT',
    is_paper: false,
    trade_mode: 'validation',
    entry_size: 922.5,
    entry_value: 49.9995,
  }],
});
const crossModeTrade = await crossModeDelta.executeSellTrade({
  signalId: 'sig-kaia-sell',
  symbol: 'KAIA/USDT',
  amount: 921.5775,
  sellPaperMode: false,
  effectivePositionTradeMode: 'normal',
  position: { amount: 921.5775, avg_price: 0.0542, unrealized_pnl: -2.1 },
  sourcePositionAmount: 921.5775,
  partialExitRatio: 1,
});
assert.equal(crossModeTrade.tradeMode, 'validation');
assert.equal(calls.find((item) => item[0] === 'marketSell')?.[4]?.clientOrderId, 'ln_s_validation_smoke');

const payload = {
  ok: true,
  smoke: 'hephaestos-portfolio-position-delta',
  dustCleanup: true,
  journalReconcile: journal.toSize,
  buyManagedAmount: buyUpsert[1].amount,
  partialRemaining: partialTrade.remainingAmount,
  fullSellPartial: fullTrade.partialExit,
  missingJournalBlockedBeforeSell: true,
  crossModeLiveJournalTradeMode: crossModeTrade.tradeMode,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('✅ hephaestos portfolio position delta smoke passed');
}
