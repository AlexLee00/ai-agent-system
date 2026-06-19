#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  BASE_FUSION_WEIGHTS,
  BASE_SIGNAL_WEIGHTS,
  DEFAULT_WEIGHT_LEARNER_LOOKBACK_DAYS,
  runRegimeWeightLearner,
} from '../shared/regime-weight-learner.ts';
import { buildStrategyRoute } from '../shared/strategy-router.ts';

function tradeRow({
  regime = 'TRENDING_BULL',
  signalType = 'momentum',
  totalTrades = 5,
  winTrades = 4,
  grossProfit = 120,
  grossLoss = 30,
} = {}) {
  return {
    regime,
    signal_type: signalType,
    market: 'crypto',
    total_trades: totalTrades,
    win_trades: winTrades,
    avg_pnl: 1,
    avg_pnl_pct: 1,
    gross_profit: grossProfit,
    gross_loss: grossLoss,
  };
}

function previousBaseWeights() {
  return Object.keys(BASE_SIGNAL_WEIGHTS).map((regime) => ({
    regime,
    fusionWeights: BASE_FUSION_WEIGHTS[regime],
    signalWeights: BASE_SIGNAL_WEIGHTS[regime],
    totalTrades: 0,
    updatedAt: '2026-06-18T00:00:00.000Z',
  }));
}

async function routeFixture(env = {}, provider = async () => []) {
  return buildStrategyRoute({
    symbol: 'BTC/USDT',
    exchange: 'binance',
    analyses: [],
    marketRegime: { regime: 'bull' },
    env,
    learnedWeightsProvider: provider,
  });
}

async function main() {
  const defaultCalls = [];
  const defaultResult = await runRegimeWeightLearner({
    dryRun: true,
    env: {},
    fetchRegimeTradeStats: async (days) => {
      defaultCalls.push(days);
      return [];
    },
    getLatestRegimeWeights: async () => previousBaseWeights(),
    recentSnapshots: [],
  });
  assert.equal(defaultResult.days, DEFAULT_WEIGHT_LEARNER_LOOKBACK_DAYS);
  assert.equal(defaultCalls[0], 30);
  assert.deepEqual(defaultResult.fetchedWindows, [30, 60, 90, 180]);

  const envCalls = [];
  const envResult = await runRegimeWeightLearner({
    dryRun: true,
    env: { LUNA_WEIGHT_LEARNER_LOOKBACK_DAYS: '90' },
    fetchRegimeTradeStats: async (days) => {
      envCalls.push(days);
      return [tradeRow({ regime: 'TRENDING_BULL', totalTrades: 5, winTrades: 4 })];
    },
    getLatestRegimeWeights: async () => previousBaseWeights(),
    recentSnapshots: [],
  });
  assert.equal(envResult.days, 90);
  assert.equal(envCalls[0], 90);

  const adaptiveResult = await runRegimeWeightLearner({
    dryRun: true,
    env: {},
    fetchRegimeTradeStats: async (days) => {
      if (days < 90) return [tradeRow({ regime: 'TRENDING_BULL', totalTrades: 2, winTrades: 1 })];
      return [
        tradeRow({ regime: 'TRENDING_BULL', signalType: 'momentum', totalTrades: 5, winTrades: 5 }),
        tradeRow({ regime: 'RANGING', signalType: 'mean_reversion', totalTrades: 3, winTrades: 2 }),
      ];
    },
    getLatestRegimeWeights: async () => previousBaseWeights(),
    recentSnapshots: [],
  });
  assert.equal(adaptiveResult.windowSelection.TRENDING_BULL.days, 90);
  assert.equal(adaptiveResult.windowSelection.TRENDING_BULL.reason, 'adaptive_window_selected');
  assert.ok(adaptiveResult.diagnostics.some((row) => row.regime === 'TRENDING_BULL' && row.signalDelta > 0));

  const staleResult = await runRegimeWeightLearner({
    dryRun: true,
    env: { LUNA_WEIGHT_LEARNER_STALL_DAYS: '3' },
    fetchRegimeTradeStats: async () => [],
    getLatestRegimeWeights: async () => previousBaseWeights(),
    recentSnapshots: [
      { created_at: '2026-06-18T00:00:00.000Z' },
      { created_at: '2026-06-17T00:00:00.000Z' },
    ],
  });
  assert.equal(staleResult.stalled.currentRunStalled, true);
  assert.equal(staleResult.stalled.shouldAlert, true);
  assert.equal(staleResult.stalled.consecutiveStallDays, 3);
  assert.ok(staleResult.stalled.insufficientRegimes.includes('TRENDING_BULL'));

  const singleStallAfterHealthyResult = await runRegimeWeightLearner({
    dryRun: true,
    env: { LUNA_WEIGHT_LEARNER_STALL_DAYS: '3' },
    fetchRegimeTradeStats: async () => [],
    getLatestRegimeWeights: async () => previousBaseWeights(),
    recentSnapshots: [
      { regime: 'TRENDING_BULL', total_trades: 5, created_at: '2026-06-18T00:00:00.000Z' },
      { regime: 'TRENDING_BULL', total_trades: 5, created_at: '2026-06-17T00:00:00.000Z' },
    ],
  });
  assert.equal(singleStallAfterHealthyResult.stalled.currentRunStalled, true);
  assert.equal(singleStallAfterHealthyResult.stalled.shouldAlert, false);

  let providerCalled = false;
  const offRoute = await routeFixture({ LUNA_LEARNED_BIAS_MODE: 'off' }, async () => {
    providerCalled = true;
    throw new Error('provider_should_not_be_called_when_off');
  });
  assert.equal(providerCalled, false);
  assert.equal(Object.hasOwn(offRoute, 'learnedBias'), false);

  const learnedProvider = async () => [{
    regime: 'TRENDING_BULL',
    signalWeights: { momentum: 0.65, breakout: 0.20, mean_reversion: 0.05, defensive: 0.10 },
    totalTrades: 42,
    updatedAt: '2026-06-19T00:00:00.000Z',
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

  const activeRoute = await routeFixture({
    LUNA_LEARNED_BIAS_MODE: 'active',
    LUNA_LEARNED_BIAS_ALPHA: '1',
  }, learnedProvider);
  assert.equal(activeRoute.learnedBias.mode, 'active');
  assert.ok(Math.abs(activeRoute.learnedBias.applied.trend_following) <= 0.1);
  assert.ok(activeRoute.scores.trend_following > baseRoute.scores.trend_following);

  const failOpenRoute = await routeFixture({ LUNA_LEARNED_BIAS_MODE: 'active' }, async () => {
    throw new Error('fixture lookup down');
  });
  assert.deepEqual(failOpenRoute.scores, baseRoute.scores);
  assert.deepEqual(failOpenRoute.reasons, baseRoute.reasons);
  assert.equal(failOpenRoute.learnedBias.available, false);
  assert.match(failOpenRoute.learnedBias.reasonLine, /fail-open/);

  const result = {
    ok: true,
    smoke: 'luna-self-evolution-loop',
    scenarios: {
      defaultLookback30: true,
      envLookbackPriority: true,
      adaptiveWindow90: true,
      diagnosticsAndStall: true,
      stallAlertRequiresConsecutiveEvidence: true,
      learnedBiasOffNoDiff: true,
      learnedBiasShadowNoScoreMutation: true,
      learnedBiasShadowPreservesReasons: true,
      learnedBiasActiveClamped: true,
      learnedBiasFailOpen: true,
    },
  };
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna self-evolution loop smoke ok');
}

main().catch((error) => {
  console.error('❌ luna-self-evolution-loop-smoke 실패:', error);
  process.exitCode = 1;
});
