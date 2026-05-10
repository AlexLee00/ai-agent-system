#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildTradingViewOpenPositionSubscriptionPlan,
  normalizeBinanceTradingViewSymbol,
  runTradingViewOpenPositionSubscriptionSync,
} from './runtime-tradingview-open-position-subscription-sync.ts';

export async function runSmoke() {
  assert.equal(normalizeBinanceTradingViewSymbol('BTC/USDT'), 'BINANCE:BTCUSDT');
  assert.equal(normalizeBinanceTradingViewSymbol('BINANCE:CETUSUSDT'), 'BINANCE:CETUSUSDT');
  assert.equal(normalizeBinanceTradingViewSymbol('ABEV'), null);

  const positions = [
    { symbol: 'BTC/USDT' },
    { symbol: 'BTC/USDT' },
    { symbol: 'CETUS/USDT' },
    { symbol: 'ABEV' },
  ];
  const plan = buildTradingViewOpenPositionSubscriptionPlan({
    positions,
    timeframes: ['60', '240', 'D'],
    baseUrl: 'http://127.0.0.1:8083',
    ttlMs: 900_000,
  });
  assert.equal(plan.status, 'tradingview_position_subscription_sync_ready');
  assert.deepEqual(plan.symbols, ['BINANCE:BTCUSDT', 'BINANCE:CETUSUSDT']);
  assert.equal(plan.subscriptions.length, 6);
  assert.equal(plan.subscriptions.every((row) => row.protected === true), true);
  assert.equal(plan.subscriptions.every((row) => row.url.includes('protected=true')), true);

  const dryRun = await runTradingViewOpenPositionSubscriptionSync({
    positions,
    apply: false,
    timeframes: ['60'],
  });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.plan.subscriptions.length, 2);

  const confirmRequired = await runTradingViewOpenPositionSubscriptionSync({
    positions,
    apply: true,
    confirm: 'wrong',
    timeframes: ['60'],
  });
  assert.equal(confirmRequired.ok, false);
  assert.equal(confirmRequired.status, 'tradingview_position_subscription_sync_confirm_required');

  const calls = [];
  const applied = await runTradingViewOpenPositionSubscriptionSync({
    positions,
    apply: true,
    confirm: 'luna-tradingview-position-subscription-sync',
    timeframes: ['60', 'D'],
    fetchImpl: async (url) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, key: 'mock', protected: String(url).includes('protected=true') }),
      };
    },
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.status, 'tradingview_position_subscription_sync_applied');
  assert.equal(calls.length, 4);
  assert.equal(calls.every((url) => url.includes('/subscribe?')), true);
  assert.equal(calls.every((url) => url.includes('protected=true')), true);
  assert.equal(applied.results.every((row) => row.serviceProtected === true), true);

  const legacyEcho = await runTradingViewOpenPositionSubscriptionSync({
    positions: [{ symbol: 'BTC/USDT' }],
    apply: true,
    confirm: 'luna-tradingview-position-subscription-sync',
    timeframes: ['60'],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, key: 'legacy' }),
    }),
  });
  assert.equal(legacyEcho.ok, true);
  assert.equal(legacyEcho.status, 'tradingview_position_subscription_sync_applied_with_warnings');
  assert.equal(legacyEcho.warnings.includes('tradingview_service_protected_echo_missing_until_reload'), true);

  return {
    ok: true,
    smoke: 'tradingview-open-position-subscription-sync',
    plannedSubscriptions: plan.subscriptions.length,
    appliedSubscriptions: applied.results.length,
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('tradingview-open-position-subscription-sync smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'tradingview-open-position-subscription-sync smoke failed:',
  });
}
