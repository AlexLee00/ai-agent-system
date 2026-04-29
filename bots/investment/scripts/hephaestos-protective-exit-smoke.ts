#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { createProtectiveExitPolicy } from '../team/hephaestos/protective-exit.ts';

function createFakeExchange(overrides = {}) {
  return {
    market: () => ({ precision: { price: 2 } }),
    priceToPrecision: (_symbol, value) => Number(value).toFixed(2),
    amountToPrecision: (_symbol, value) => Number(value).toFixed(6),
    privatePostOrderOco: async () => ({
      orderReports: [{ orderId: 111 }, { orderId: 222 }],
    }),
    ...overrides,
  };
}

async function main() {
  let exchange = createFakeExchange();
  const policy = createProtectiveExitPolicy({
    getExchange: () => exchange,
    fetchFreeAssetBalance: async () => 2,
    extractOrderId: (order) => order?.id ?? null,
  });

  const prices = policy.normalizeProtectiveExitPrices('ETH/USDT', 100, 110, 95, 'provided');
  assert.equal(prices.tpPrice, 110);
  assert.equal(prices.slPrice, 95);
  assert.equal(prices.requestedValid, true);

  const fallback = policy.normalizeProtectiveExitPrices('ETH/USDT', 100, 90, 120, 'provided');
  assert.equal(fallback.sourceUsed, 'fixed_fallback');
  assert.equal(fallback.tpPrice, 106);
  assert.equal(fallback.slPrice, 97);

  const oco = await policy.placeBinanceProtectiveExit('ETH/USDT', 1.5, 100, 110, 95);
  assert.equal(oco.ok, true);
  assert.equal(oco.mode, 'oco');
  assert.equal(oco.tpOrderId, '111');
  assert.equal(oco.slOrderId, '222');

  exchange = createFakeExchange({
    privatePostOrderOco: undefined,
    featureValue: (_symbol, _method, feature) => feature === 'stopLossPrice',
    createOrder: async () => ({ id: 'sl-1' }),
  });
  const stopOnly = await policy.placeBinanceProtectiveExit('ETH/USDT', 3, 100, 110, 95);
  assert.equal(stopOnly.ok, false);
  assert.equal(policy.isStopLossOnlyMode(stopOnly.mode), true);
  assert.equal(stopOnly.effectiveAmount, 2);
  assert.equal(stopOnly.slOrderId, 'sl-1');

  const snapshot = policy.buildProtectionSnapshot(stopOnly, null);
  assert.equal(snapshot.tpSlSet, false);
  assert.equal(snapshot.tpSlMode, 'ccxt_stop_loss_only');

  console.log(JSON.stringify({ ok: true, mode: oco.mode, stopOnlyMode: stopOnly.mode }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
