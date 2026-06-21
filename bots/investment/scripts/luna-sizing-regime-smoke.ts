#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { calculatePositionSize } from '../shared/capital-manager.ts';
import { getLunaDelegatedAuthorityPolicy } from '../shared/luna-delegated-authority.ts';
import { getRegimeMultiplier } from '../shared/regime-multiplier.ts';

function sizingDeps(overrides = {}) {
  return {
    getCapitalConfig: () => ({
      risk_per_trade: 0.02,
      max_position_pct: 1.0,
      reserve_ratio: 0.0,
      ...overrides.policy,
    }),
    getAvailableBalance: async () => overrides.balance ?? 9000,
    getTotalCapital: async () => overrides.totalCapital ?? 10000,
    getDynamicMinOrderAmount: async () => overrides.minOrder ?? 1,
    fetchFearGreedIndex: async () => overrides.fearGreedIndex ?? 50,
    getCurrentRegime: async () => overrides.currentRegime ?? 'ranging',
  };
}

function assertClose(actual, expected, epsilon = 1e-9, message = 'values should be close') {
  assert.ok(Math.abs(Number(actual) - Number(expected)) <= epsilon, `${message}: ${actual} !== ${expected}`);
}

export async function runLunaSizingRegimeSmoke() {
  const invalidOverrideEnv = {
    LUNA_REGIME_LIMIT_MULT_LOW_VOLATILITY_BULL: 'invalid',
    LUNA_REGIME_LIMIT_MULT_RANGING: 'invalid',
    LUNA_REGIME_LIMIT_MULT_TRENDING_BEAR: 'invalid',
    LUNA_REGIME_LIMIT_MULT_HIGH_VOLATILITY_BEAR: 'invalid',
  };
  assert.equal(getRegimeMultiplier('low_volatility_bull', invalidOverrideEnv), 1.3);
  assert.equal(getRegimeMultiplier('ranging', invalidOverrideEnv), 0.8);
  assert.equal(getRegimeMultiplier('trending_bear', invalidOverrideEnv), 0.5);
  assert.equal(getRegimeMultiplier('high_volatility_bear', invalidOverrideEnv), 0.4);
  assert.equal(getRegimeMultiplier(null), 0.8);
  assert.equal(getRegimeMultiplier('unknown_xyz'), 0.8);
  assert.equal(getRegimeMultiplier('ranging', { LUNA_REGIME_LIMIT_MULT_RANGING: '0.5' }), 0.5);
  assert.equal(getRegimeMultiplier('ranging', { LUNA_REGIME_LIMIT_MULT_RANGING: 'abc' }), 0.8);

  const lowVolBull = await calculatePositionSize(
    'BTC/USDT',
    100,
    50,
    'binance',
    'low_volatility_bull',
    sizingDeps(),
  );
  const highVolBear = await calculatePositionSize(
    'BTC/USDT',
    100,
    50,
    'binance',
    'high_volatility_bear',
    sizingDeps(),
  );
  assert.equal(lowVolBull.skip, false);
  assert.equal(highVolBear.skip, false);
  assert.equal(lowVolBull.regimeMultiplier, 1.3);
  assert.equal(highVolBear.regimeMultiplier, 0.4);
  assertClose(lowVolBull.size / highVolBear.size, 3.25, 1e-9, 'low_volatility_bull/high_volatility_bear size ratio');

  const autoRegime = await calculatePositionSize(
    'BTC/USDT',
    100,
    50,
    'binance',
    null,
    sizingDeps({ currentRegime: 'trending_bear' }),
  );
  assert.equal(autoRegime.skip, false);
  assert.equal(autoRegime.regime, 'trending_bear');
  assert.equal(autoRegime.regimeMultiplier, 0.5);

  const delegatedPolicy = getLunaDelegatedAuthorityPolicy({
    LUNA_DELEGATED_AUTHORITY_ENABLED: 'true',
    LUNA_DELEGATED_TRADE_RATIO: '0.05',
    LUNA_DELEGATED_DAILY_RATIO: '0.20',
    LUNA_DELEGATED_TRADE_RATIO_HARD_CAP: '0.10',
    LUNA_DELEGATED_DAILY_RATIO_HARD_CAP: '0.40',
    LUNA_REGIME_LIMIT_MULT_TRENDING_BEAR: 'invalid',
  }, {
    availableBalance: 1000,
    regime: 'trending_bear',
    exchange: 'binance',
    minOrderAmount: 11,
  });
  assert.equal(delegatedPolicy.regimeMultiplier, 0.5);
  assert.equal(delegatedPolicy.maxTradeUsdt, 25);
  assert.equal(delegatedPolicy.maxDailyUsdt, 100);

  return {
    ok: true,
    smoke: 'luna-sizing-regime',
    scenarios: {
      defaultMultipliers: true,
      fallbackMultipliers: true,
      envOverride: true,
      calculatePositionSizeRatio: true,
      calculatePositionSizeAutoRegime: true,
      delegatedAuthorityPolicy: true,
    },
  };
}

async function main() {
  const result = await runLunaSizingRegimeSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna sizing regime smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna sizing regime smoke 실패:',
  });
}
