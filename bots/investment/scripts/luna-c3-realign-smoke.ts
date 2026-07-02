#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildStrategyRoute } from '../shared/strategy-router.ts';
import {
  buildC3RealignShadowSignal,
  C3_REGIME_STRATEGY_MAP_V2,
  normalizeC3Regime,
} from '../shared/luna-c3-realign.ts';
import { runLunaC3RealignParameterRuntime } from './runtime-luna-c3-realign-parameter.ts';
import { buildC3RealignReport, runLunaC3RealignReport } from './runtime-luna-c3-realign-report.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function fixtureDecision() {
  return { action: 'BUY', confidence: 0.72, reasoning: 'momentum breakout after strong bull regime' };
}

export async function runLunaC3RealignSmoke() {
  assert.equal(normalizeC3Regime('high_volatility_bull'), 'trending_bull');
  assert.equal(normalizeC3Regime('low_volatility_bear'), 'trending_bear');
  assert.equal(C3_REGIME_STRATEGY_MAP_V2.trending_bear.some((entry) => entry.family === 'defensive_rotation'), false);

  const base = await buildStrategyRoute({
    symbol: 'BTC/USDT',
    exchange: 'binance',
    marketRegime: { regime: 'trending_bear' },
    decision: fixtureDecision(),
    env: { LUNA_C3_REALIGN_MODE: 'off', LUNA_LEARNED_BIAS_MODE: 'off' },
    learnedWeightsProvider: async () => {
      throw new Error('learned weights should not run in off mode');
    },
  });
  const offAgain = await buildStrategyRoute({
    symbol: 'BTC/USDT',
    exchange: 'binance',
    marketRegime: { regime: 'trending_bear' },
    decision: fixtureDecision(),
    env: { LUNA_C3_REALIGN_MODE: 'off', LUNA_LEARNED_BIAS_MODE: 'off' },
  });
  assert.deepEqual(offAgain.scores, base.scores, 'off mode must preserve route scores');
  assert.equal(Object.hasOwn(offAgain, 'c3Realign'), false, 'off mode must not annotate route');

  const c3ShadowWrites = [];
  const shadow = await buildStrategyRoute({
    symbol: 'BTC/USDT',
    exchange: 'binance',
    marketRegime: { regime: 'trending_bear' },
    decision: fixtureDecision(),
    env: { LUNA_C3_REALIGN_MODE: 'shadow', LUNA_LEARNED_BIAS_MODE: 'off' },
    c3RealignShadowRunFn: async (sql, params) => {
      c3ShadowWrites.push({ sql, params });
      return { rows: [{ id: 777 }] };
    },
  });
  assert.equal(shadow.selectedFamily, base.selectedFamily, 'shadow must not replace selected family');
  assert.equal(shadow.c3Realign.targetFamily, 'mean_reversion');
  assert.equal(shadow.c3Realign.bearDefensiveExcluded, true);
  assert.equal(shadow.c3Realign.liveMutation, false);
  assert.equal(c3ShadowWrites.length, 1, 'shadow mode must persist a c3_realign_shadow sample');
  assert.match(String(c3ShadowWrites[0].sql), /INSERT INTO luna_strategy_signals/);
  assert.equal(c3ShadowWrites[0].params?.[3], 'c3_realign_shadow');

  const enforceBlocked = await buildStrategyRoute({
    symbol: 'BTC/USDT',
    exchange: 'binance',
    marketRegime: { regime: 'trending_bear' },
    decision: fixtureDecision(),
    env: { LUNA_C3_REALIGN_MODE: 'enforce', LUNA_LEARNED_BIAS_MODE: 'off' },
  });
  assert.equal(enforceBlocked.selectedFamily, base.selectedFamily);
  assert.equal(enforceBlocked.c3Realign.enforceBlocked, true);
  assert.equal(enforceBlocked.c3Realign.liveMutation, false);

  const enforced = await buildStrategyRoute({
    symbol: 'BTC/USDT',
    exchange: 'binance',
    marketRegime: { regime: 'trending_bear' },
    decision: fixtureDecision(),
    env: {
      LUNA_C3_REALIGN_MODE: 'enforce',
      LUNA_C3_REALIGN_PROMOTION_READY: 'true',
      LUNA_LEARNED_BIAS_MODE: 'off',
    },
  });
  assert.equal(enforced.selectedFamily, 'mean_reversion');
  assert.equal(enforced.c3Realign.enforced, true);

  const shadowSignal = buildC3RealignShadowSignal(shadow, {
    symbol: 'BTC/USDT',
    exchange: 'binance',
    marketRegime: { regime: 'trending_bear' },
    now: '2026-07-02T12:34:56.000Z',
  });
  assert.equal(shadowSignal.signalType, 'c3_realign_shadow');
  assert.equal(shadowSignal.ruleVersion, 'c3_regime_strategy_map_v2');
  assert.equal(shadowSignal.details.c3Realign.remapped, true);
  assert.equal(shadowSignal.details.excludeFromOrderPath, true);
  assert.equal(shadowSignal.family, 'mean_reversion');

  let writeCalled = false;
  const dryRunPlan = await runLunaC3RealignParameterRuntime({
    apply: false,
    queryFn: async () => [],
    runFn: async () => {
      writeCalled = true;
    },
  });
  assert.equal(dryRunPlan.dryRun, true);
  assert.equal(writeCalled, false, 'parameter dry-run must not write');

  const readyReport = buildC3RealignReport([
    { family: 'momentum_rotation', matched: true, regime: { regime: 'trending_bull' }, details: { c3Realign: { remapped: true } } },
    { family: 'mean_reversion', matched: true, regime: { regime: 'trending_bear' }, details: { c3Realign: { remapped: true } } },
    { family: 'mean_reversion', matched: true, regime: { regime: 'ranging' }, details: { c3Realign: { remapped: false } } },
  ], { c7Passed: true });
  assert.equal(readyReport.promotionReady, true);

  const blockedReport = buildC3RealignReport([
    { family: 'defensive_rotation', matched: true, regime: { regime: 'trending_bear' }, details: { c3Realign: { remapped: false } } },
  ], { c7Passed: true });
  assert.equal(blockedReport.promotionReady, false);
  assert.ok(blockedReport.blockers.includes('bear_defensive_rotation_present'));

  const noDbReport = await runLunaC3RealignReport({ noDb: true, c7Passed: false });
  assert.equal(noDbReport.liveMutation, false);

  return {
    ok: true,
    baseFamily: base.selectedFamily,
    shadowTargetFamily: shadow.c3Realign.targetFamily,
    shadowWrites: c3ShadowWrites.length,
    enforceBlocked: enforceBlocked.c3Realign.blocker,
    enforcedFamily: enforced.selectedFamily,
    dryRunNeedsApply: dryRunPlan.needsApply,
    blockedReportBlockers: blockedReport.blockers,
  };
}

async function main() {
  const result = await runLunaC3RealignSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna-c3-realign-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'luna-c3-realign-smoke failed:' });
}
