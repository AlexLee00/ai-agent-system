#!/usr/bin/env node
// @ts-nocheck

import { createSellExecutionResolution } from '../team/hephaestos/sell-execution-resolution.ts';
import { buildSellBalancePolicy } from '../team/hephaestos/sell-balance-policy.ts';

const failures = [];
const signalBlocks = [];
let cancelledOrders = 0;
let cleanedDust = false;

const resolver = createSellExecutionResolution({
  db: {
    async getLivePosition(symbol, exchange, tradeMode) {
      if (symbol === 'LOCK/USDT') return { symbol, amount: 100, trade_mode: tradeMode, paper: false };
      if (symbol === 'DRIFT/USDT') return { symbol, amount: 100, trade_mode: tradeMode, paper: false };
      if (symbol === 'DUST/USDT') return { symbol, amount: 0.0001, trade_mode: tradeMode, paper: false };
      return null;
    },
    async getPaperPosition() {
      return null;
    },
    async updateSignalBlock(signalId, block) {
      signalBlocks.push({ signalId, block });
    },
  },
  getExchange() {
    return {
      async fetchBalance() {
        return {
          free: {
            LOCK: 20,
            DRIFT: 40,
            DUST: 0.0001,
          },
          total: {
            LOCK: 100,
            DRIFT: 40,
            DUST: 0.0001,
          },
        };
      },
    };
  },
  async findAnyLivePosition() {
    return null;
  },
  normalizePartialExitRatio(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0 || numeric >= 1) return 1;
    return Number(numeric.toFixed(4));
  },
  async cancelOpenSellOrdersForSymbol(symbol) {
    cancelledOrders += 1;
    return { cancelledCount: symbol === 'DRIFT/USDT' ? 0 : 1 };
  },
  async fetchAssetBalances(symbol) {
    if (symbol === 'LOCK/USDT') return { freeBalance: 20, totalBalance: 100 };
    return null;
  },
  buildSellBalancePolicy,
  async reconcileOpenJournalToTrackedAmount() {
    return { ok: true };
  },
  async getMinSellAmount(symbol) {
    return symbol === 'DUST/USDT' ? 1 : 0.001;
  },
  roundSellAmount(symbol, amount) {
    return Number(amount || 0);
  },
  async cleanupDustLivePosition() {
    cleanedDust = true;
  },
});

async function persistFailure(reason, payload) {
  failures.push({ reason, payload });
}

const context = await resolver.resolveSellExecutionContext({
  persistFailure,
  symbol: 'LOCK/USDT',
  signalTradeMode: 'normal',
  globalPaperMode: false,
});

const locked = await resolver.resolveSellAmount({
  persistFailure,
  signalId: 'sig-lock',
  symbol: 'LOCK/USDT',
  signalTradeMode: 'normal',
  sellPaperMode: false,
  livePosition: context.livePosition,
  fallbackLivePosition: null,
  paperPosition: null,
  position: context.position,
  freeBalance: context.freeBalance,
  totalBalance: context.totalBalance,
  partialExitRatio: 0.5,
});

const driftContext = await resolver.resolveSellExecutionContext({
  persistFailure,
  symbol: 'DRIFT/USDT',
  signalTradeMode: 'normal',
  globalPaperMode: false,
});
const drift = await resolver.resolveSellAmount({
  persistFailure,
  signalId: 'sig-drift',
  symbol: 'DRIFT/USDT',
  signalTradeMode: 'normal',
  sellPaperMode: false,
  livePosition: driftContext.livePosition,
  fallbackLivePosition: null,
  paperPosition: null,
  position: driftContext.position,
  freeBalance: driftContext.freeBalance,
  totalBalance: driftContext.totalBalance,
  partialExitRatio: 1,
});

const dustContext = await resolver.resolveSellExecutionContext({
  persistFailure,
  symbol: 'DUST/USDT',
  signalTradeMode: 'normal',
  globalPaperMode: false,
});
const dust = await resolver.resolveSellAmount({
  persistFailure,
  signalId: 'sig-dust',
  symbol: 'DUST/USDT',
  signalTradeMode: 'normal',
  sellPaperMode: false,
  livePosition: dustContext.livePosition,
  fallbackLivePosition: null,
  paperPosition: null,
  position: dustContext.position,
  freeBalance: dustContext.freeBalance,
  totalBalance: dustContext.totalBalance,
  partialExitRatio: 1,
});

if (locked.success !== false || failures[0]?.payload?.code !== 'balance_locked_by_protective_orders') {
  throw new Error(`locked protective order path mismatch: ${JSON.stringify({ locked, failures })}`);
}
if (drift.success !== true || drift.amount !== 40 || drift.sourcePositionAmount !== 40) {
  throw new Error(`drift reconcile path mismatch: ${JSON.stringify({ drift, signalBlocks })}`);
}
if (dust.success !== false || !cleanedDust) {
  throw new Error(`dust cleanup path mismatch: ${JSON.stringify({ dust, cleanedDust })}`);
}

const payload = {
  ok: true,
  smoke: 'hephaestos-sell-execution-resolution',
  locked,
  drift,
  dust,
  cancelledOrders,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('✅ hephaestos sell execution resolution smoke passed');
}
