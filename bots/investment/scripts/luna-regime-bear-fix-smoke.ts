#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { BASE_SIGNAL_WEIGHTS } from '../shared/regime-weight-learner.ts';
import { buildStrategyRoute, _testOnly as strategyRouterTestOnly } from '../shared/strategy-router.ts';

async function routeFixture(env = {}, learnedWeightsProvider = async () => []) {
  return buildStrategyRoute({
    symbol: 'BTC/USDT',
    exchange: 'binance',
    analyses: [],
    marketRegime: { regime: 'trending_bear' },
    env,
    learnedWeightsProvider,
  });
}

async function main() {
  assert.deepEqual(
    BASE_SIGNAL_WEIGHTS.TRENDING_BULL,
    { momentum: 0.35, breakout: 0.30, mean_reversion: 0.15, defensive: 0.20 },
    'non-bear base weights must stay unchanged',
  );
  assert.deepEqual(
    BASE_SIGNAL_WEIGHTS.TRENDING_BEAR,
    { momentum: 0.15, breakout: 0.15, mean_reversion: 0.40, defensive: 0.30 },
    'bear base weights should prefer mean reversion over defensive',
  );
  assert.deepEqual(
    BASE_SIGNAL_WEIGHTS.RANGING,
    { momentum: 0.15, breakout: 0.15, mean_reversion: 0.50, defensive: 0.20 },
    'ranging base weights must stay unchanged',
  );
  assert.deepEqual(
    BASE_SIGNAL_WEIGHTS.VOLATILE,
    { momentum: 0.15, breakout: 0.20, mean_reversion: 0.20, defensive: 0.45 },
    'volatile base weights must stay unchanged',
  );

  const familyBias = strategyRouterTestOnly.signalWeightsToFamilyBias(
    BASE_SIGNAL_WEIGHTS.TRENDING_BEAR,
    ['trend_following', 'momentum_rotation', 'breakout', 'mean_reversion', 'defensive_rotation'],
  );
  assert.ok(
    familyBias.mean_reversion > familyBias.defensive_rotation,
    `expected bear mean_reversion bias > defensive_rotation, got ${JSON.stringify(familyBias)}`,
  );

  let offProviderCalled = false;
  const offRoute = await routeFixture({ LUNA_LEARNED_BIAS_MODE: 'off' }, async () => {
    offProviderCalled = true;
    throw new Error('provider_should_not_be_called_when_off');
  });
  assert.equal(offProviderCalled, false);
  assert.equal(Object.hasOwn(offRoute, 'learnedBias'), false);

  const learnedProvider = async () => [{
    regime: 'TRENDING_BEAR',
    signalWeights: { momentum: 0.15, breakout: 0.15, mean_reversion: 0.10, defensive: 0.60 },
    totalTrades: 38,
    updatedAt: '2026-06-20T00:00:00.000Z',
  }];
  const baseRoute = await routeFixture({ LUNA_LEARNED_BIAS_MODE: 'off' }, learnedProvider);
  const shadowRoute = await routeFixture({ LUNA_LEARNED_BIAS_MODE: 'shadow' }, learnedProvider);
  assert.deepEqual(shadowRoute.scores, baseRoute.scores);
  assert.deepEqual(shadowRoute.ranking, baseRoute.ranking);
  assert.deepEqual(shadowRoute.reasons, baseRoute.reasons);
  assert.equal(shadowRoute.selectedFamily, baseRoute.selectedFamily);
  assert.equal(shadowRoute.learnedBias.mode, 'shadow');
  assert.equal(shadowRoute.learnedBias.available, true);
  assert.match(shadowRoute.learnedBias.reasonLine, /learned regime bias shadow diff/);

  const result = {
    ok: true,
    smoke: 'luna-regime-bear-fix',
    scenarios: {
      bearMeanReversionBasePreferred: true,
      otherRegimeWeightsUnchanged: true,
      learnedBiasOffNoProvider: true,
      learnedBiasShadowNoRouteMutation: true,
    },
  };
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna regime bear fix smoke ok');
}

main().catch((error) => {
  console.error('❌ luna-regime-bear-fix-smoke 실패:', error);
  process.exitCode = 1;
});
