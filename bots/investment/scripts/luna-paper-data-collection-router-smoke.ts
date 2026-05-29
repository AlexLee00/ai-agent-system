#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { runLunaPaperDataCollectionRouter } from './runtime-luna-paper-data-collection-router.ts';

const dryRun = await runLunaPaperDataCollectionRouter({
  fixture: true,
  dryRun: true,
  apply: false,
  limit: 2,
  amountUsdt: 12,
  epsilon: 0,
}, {
  loadBiasReport: async () => ({
    diversityInputs: {
      preferredUnderSampledSymbols: ['ETH/USDT'],
      preferredRegimes: ['ranging'],
      preferredStrategies: ['mean_reversion'],
    },
  }),
  rng: () => 0.99,
});

assert.equal(dryRun.ok, true);
assert.equal(dryRun.dryRun, true);
assert.equal(dryRun.enabled, false);
assert.equal(dryRun.summary.liveMutation, false);
assert.equal(dryRun.summary.paperOnly, true);
assert.equal(dryRun.summary.executed, 0);
assert.equal(dryRun.plans.filter((plan) => plan.action === 'execute_paper').length, 2);
assert.equal(dryRun.plans[0].symbol, 'ETH/USDT');
assert.equal(dryRun.plans[0].signal.dataCollectionPaper, true);
assert.equal(dryRun.plans[0].signal.strategy_route.paperBypassesBacktestGate, true);
assert.equal(dryRun.plans[0].signal.strategy_route.paperSkipsCapitalGuard, true);

let executed = 0;
const applied = await runLunaPaperDataCollectionRouter({
  fixture: true,
  dryRun: false,
  apply: true,
  enabled: true,
  confirm: 'luna-paper-data-collection',
  limit: 1,
  amountUsdt: 12,
  epsilon: 1,
}, {
  loadBiasReport: async () => ({
    diversityInputs: {
      preferredUnderSampledSymbols: ['BTC/USDT'],
      preferredRegimes: ['trending_bull'],
      preferredStrategies: ['trend'],
    },
  }),
  rng: () => 0,
  executeSignal: async (signal) => {
    executed += 1;
    assert.equal(signal.dataCollectionPaper, true);
    assert.equal(signal.exchange, 'binance');
    return { executed: true, mode: 'paper', paperPositionId: 'TRD-SMOKE' };
  },
});

assert.equal(applied.enabled, true);
assert.equal(applied.dryRun, false);
assert.equal(applied.summary.executed, 1);
assert.equal(executed, 1);
assert.equal(applied.executions[0].mode, 'paper');

console.log(JSON.stringify({
  ok: true,
  dryRunExecutable: dryRun.summary.executable,
  appliedExecuted: applied.summary.executed,
  firstDryRunSymbol: dryRun.plans[0].symbol,
}, null, 2));
