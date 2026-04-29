#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { createPortfolioPositionDelta } from '../team/hephaestos/portfolio-position-delta.ts';

const calls = [];

function buildDelta({ marketSellResult = null, assetBalances = { totalBalance: 0, freeBalance: 0 } } = {}) {
  calls.length = 0;
  const journalEntries = [
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
    marketSell: async () => marketSellResult || {
      filled: 4,
      price: 12,
      cost: 48,
      status: 'closed',
    },
    buildDeterministicClientOrderId: () => 'ln_s_normal_orca_smoke',
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

const payload = {
  ok: true,
  smoke: 'hephaestos-portfolio-position-delta',
  dustCleanup: true,
  journalReconcile: journal.toSize,
  buyManagedAmount: buyUpsert[1].amount,
  partialRemaining: partialTrade.remainingAmount,
  fullSellPartial: fullTrade.partialExit,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('✅ hephaestos portfolio position delta smoke passed');
}
