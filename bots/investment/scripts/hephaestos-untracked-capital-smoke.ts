#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { createUntrackedCapitalPolicy } from '../team/hephaestos/untracked-capital.ts';

async function main() {
  const trades = [];
  const positionUpdates = [];
  const notifications = [];
  const statuses = [];
  const exchange = {
    async fetchBalance() {
      return {
        free: { ABC: 3, XYZ: 1, USDT: 100 },
        total: { ABC: 3, XYZ: 1, USDT: 100 },
      };
    },
    async fetchConvertQuote(_from, _to, amount) {
      return { id: 'quote-1', toAmount: Number(amount) * 10 };
    },
    async createConvertTrade(id, _from, _to, amount) {
      return { id: `trade-${id}`, toAmount: Number(amount) * 10 };
    },
  };
  const db = {
    async getLivePosition(symbol) {
      if (symbol === 'ABC/USDT') return { amount: 1, avg_price: 10 };
      if (symbol === 'XYZ/USDT') return { amount: 0 };
      return null;
    },
    async upsertPosition(payload) {
      positionUpdates.push(payload);
    },
    async updateSignalStatus(id, status) {
      statuses.push({ id, status });
    },
    async query() {
      return [];
    },
    async insertTrade(payload) {
      trades.push(payload);
    },
  };
  const policy = createUntrackedCapitalPolicy({
    SIGNAL_STATUS: { EXECUTED: 'executed' },
    db,
    getExchange: () => exchange,
    getDynamicMinOrderAmount: async () => 5,
    getInvestmentTradeMode: () => 'normal',
    fetchTicker: async (symbol) => symbol.startsWith('ABC') ? 10 : 20,
    marketSell: async (symbol, amount) => ({
      filled: amount,
      price: symbol.startsWith('ABC') ? 10 : 20,
      totalUsdt: amount * (symbol.startsWith('ABC') ? 10 : 20),
    }),
    normalizeProtectiveExitPrices: (_symbol, price) => ({ tpPrice: price * 1.06, slPrice: price * 0.97 }),
    buildProtectionSnapshot: () => ({ tpSlSet: false }),
    placeBinanceProtectiveExit: async () => ({ ok: true, mode: 'oco' }),
    isStopLossOnlyMode: () => false,
    notifyTrade: async (payload) => notifications.push(payload),
    notifyError: async () => {},
  });

  const convert = await policy.tryConvertResidualDustToUsdt('ABC/USDT', 0.25);
  assert.equal(convert.orderId, 'trade-quote-1');
  assert.equal(convert.toAmount, 2.5);

  const absorbed = await policy.tryAbsorbUntrackedBalance({
    signalId: 'sig-1',
    symbol: 'ABC/USDT',
    base: 'ABC',
    signalTradeMode: 'normal',
    minOrderUsdt: 5,
    effectivePaperMode: false,
  });
  assert.equal(absorbed.success, true);
  assert.equal(absorbed.amount, 2);
  assert.equal(positionUpdates[0].amount, 3);
  assert.equal(statuses[0].status, 'executed');

  const liquidation = await policy.liquidateUntrackedForCapital(['ABC'], true);
  assert.equal(liquidation.totalUsd, 20);
  assert.equal(trades[0].symbol, 'XYZ/USDT');
  assert.equal(notifications.some((item) => item.side === 'liquidate'), true);

  console.log(JSON.stringify({
    ok: true,
    absorbedAmount: absorbed.amount,
    liquidationUsd: liquidation.totalUsd,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
