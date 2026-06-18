#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runLunaMarketGate } from './runtime-luna-market-gate.ts';
import { LUNA_COMPONENT_REGISTRY_SEED, seedLunaComponentRegistry } from './luna-registry-seed.ts';
import { computeRegimePolicy } from '../shared/regime-strategy-policy.ts';
import { resolveRegimeExpansionPolicy } from '../shared/regime-expansion-policy.ts';
import {
  LUNA_STRATEGY_FAMILY_EXPANDED_REGIMES,
  attachRegimeToSignal,
  evaluateStrategyFamiliesForSymbol,
  resolveStrategyFamilyExpandedRegimes,
} from '../shared/luna-strategy-families.ts';

function bar(day: number, close: number, extra: any = {}) {
  return {
    timestamp: new Date(Date.parse('2026-01-01T00:00:00Z') + day * 86_400_000).toISOString(),
    open: extra.open ?? close - 0.3,
    high: extra.high ?? close + 0.5,
    low: extra.low ?? close - 0.5,
    close,
    volume: extra.volume ?? 1000 + day,
  };
}

function testahEntryBars({ lowStop = 131, swingHigh = 170, entryClose = 146 } = {}) {
  const bars = Array.from({ length: 78 }, (_, idx) => bar(idx, 100 + idx * 0.45));
  bars.push(bar(78, 145, { high: swingHigh, low: 144 }));
  bars.push(bar(79, 138, { high: 139, low: 137 }));
  bars.push(bar(80, 136, { high: 137, low: 135 }));
  bars.push(bar(81, 132, { high: 133, low: lowStop }));
  bars.push(bar(82, entryClose, { high: entryClose + 1, low: entryClose - 1 }));
  return bars;
}

function regime(dominant: string) {
  return {
    market: 'overseas',
    dominant,
    probabilities: {
      bull: dominant === 'bull' ? 0.7 : 0.1,
      bear: dominant === 'bear' ? 0.7 : 0.1,
      sideways: dominant === 'sideways' ? 0.7 : 0.1,
      volatile: dominant === 'volatile' ? 0.7 : 0.1,
    },
    source: 'fixture',
    computedAt: '2026-06-19T00:00:00Z',
  };
}

function fixtureSignal(family = 'testah_pullback') {
  return {
    family,
    signalType: 'entry',
    candleTs: '2026-06-18T00:00:00.000Z',
    price: 100,
    stop: 90,
    target: 120,
    rr: 2,
    reason: 'fixture',
    ruleVersion: 'v1',
    details: { fixture: true },
  };
}

function runEightWayPolicySmoke() {
  const previous = process.env.LUNA_REGIME_8WAY_ENABLED;
  try {
    delete process.env.LUNA_REGIME_8WAY_ENABLED;
    const disabled = computeRegimePolicy({
      market: 'crypto',
      regime: 'high_volatility_bull',
      setupType: 'momentum_breakout',
    });
    assert.equal(disabled.regime, 'trending_bull');

    process.env.LUNA_REGIME_8WAY_ENABLED = 'true';
    const highBull = computeRegimePolicy({
      market: 'crypto',
      regime: 'high_volatility_bull',
      setupType: 'momentum_breakout',
    });
    const lowBull = computeRegimePolicy({
      market: 'crypto',
      regime: 'low_volatility_bull',
      setupType: 'momentum_breakout',
    });
    const expansion = resolveRegimeExpansionPolicy('high_volatility_bear', { enabled: true });

    assert.equal(highBull.regime, 'high_volatility_bull');
    assert.equal(lowBull.regime, 'low_volatility_bull');
    assert.ok(highBull.positionSizeMultiplier < lowBull.positionSizeMultiplier, 'high volatility should size smaller');
    assert.ok(highBull.monitorProfile.includes('high_vol'), 'high volatility profile marker');
    assert.ok(lowBull.monitorProfile.includes('low_vol'), 'low volatility profile marker');
    assert.equal(expansion.baseRegime, 'trending_bear');

    return {
      disabledEffectiveRegime: disabled.regime,
      highBullSize: highBull.positionSizeMultiplier,
      lowBullSize: lowBull.positionSizeMultiplier,
      expansionBase: expansion.baseRegime,
    };
  } finally {
    if (previous == null) delete process.env.LUNA_REGIME_8WAY_ENABLED;
    else process.env.LUNA_REGIME_8WAY_ENABLED = previous;
  }
}

async function main() {
  const eightWayPolicy = runEightWayPolicySmoke();
  const sidewaysRegime = regime('sideways');
  const offAttached = attachRegimeToSignal(fixtureSignal(), 'overseas', sidewaysRegime, ['bull']);
  assert.equal(offAttached.matched, false);
  assert.equal(offAttached.details.regimeMatched, false);
  assert.deepEqual(offAttached.details.allowedRegimes, ['bull']);
  assert.equal(Object.prototype.hasOwnProperty.call(offAttached.details, 'regimeWouldMatchExpanded'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(offAttached.details, 'expandedRegimes'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(offAttached.details, 'regimeExpansionGain'), false);

  const onAttached = attachRegimeToSignal(fixtureSignal(), 'overseas', sidewaysRegime, ['bull'], ['bull', 'sideways']);
  assert.equal(onAttached.matched, false);
  assert.equal(onAttached.details.regimeMatched, false);
  assert.equal(onAttached.details.regimeWouldMatchExpanded, true);
  assert.equal(onAttached.details.regimeExpansionGain, true);
  assert.deepEqual(onAttached.details.expandedRegimes, ['bull', 'sideways']);

  const bullAttached = attachRegimeToSignal(fixtureSignal(), 'overseas', regime('bull'), ['bull'], ['bull', 'sideways']);
  assert.equal(bullAttached.matched, true);
  assert.equal(bullAttached.details.regimeMatched, true);
  assert.equal(bullAttached.details.regimeWouldMatchExpanded, true);
  assert.equal(bullAttached.details.regimeExpansionGain, false);

  const bearOverride = resolveStrategyFamilyExpandedRegimes({
    env: {
      LUNA_STRATEGY_FAMILY_EXPANDED_REGIMES: JSON.stringify({
        turtle: ['bull', 'bear', 'volatile', 'sideways'],
        testah: ['bear', 'sideways'],
      }),
    },
  });
  assert.equal(bearOverride.turtle.includes('bear'), false);
  assert.equal(bearOverride.testah.includes('bear'), false);

  const bearAttached = attachRegimeToSignal(fixtureSignal(), 'overseas', regime('bear'), ['bull'], bearOverride.testah);
  assert.equal(bearAttached.matched, false);
  assert.equal(bearAttached.details.regimeWouldMatchExpanded, false);
  assert.equal(bearAttached.details.regimeExpansionGain, false);

  const offFamilyResults = await evaluateStrategyFamiliesForSymbol({
    market: 'overseas',
    symbol: 'AAPL',
    bars: testahEntryBars(),
    regime: sidewaysRegime,
    now: '2026-12-31T00:00:00Z',
    env: { LUNA_REGIME_EXPANSION_SHADOW: 'false' },
    params: {
      turtle: { entryLookback: 20, exitLookback: 10, atrPeriod: 20, atrMult: 2, maFilter: 200 },
      testah: { maFast: 5, maMid: 25, maSlow: 75, pullbackWindow: 5 },
      regimeMatch: { turtle: ['bull', 'volatile'], testah: ['bull'] },
    },
  });
  const offTestah = offFamilyResults.find((item) => item.family === 'testah_pullback');
  assert.equal(offTestah?.signalType, 'entry');
  assert.equal(offTestah?.matched, false);
  assert.equal(Object.prototype.hasOwnProperty.call(offTestah.details, 'regimeExpansionGain'), false);

  const onFamilyResults = await evaluateStrategyFamiliesForSymbol({
    market: 'overseas',
    symbol: 'AAPL',
    bars: testahEntryBars(),
    regime: sidewaysRegime,
    now: '2026-12-31T00:00:00Z',
    env: { LUNA_REGIME_EXPANSION_SHADOW: 'true' },
    params: {
      turtle: { entryLookback: 20, exitLookback: 10, atrPeriod: 20, atrMult: 2, maFilter: 200 },
      testah: { maFast: 5, maMid: 25, maSlow: 75, pullbackWindow: 5 },
      regimeMatch: { turtle: ['bull', 'volatile'], testah: ['bull'] },
    },
  });
  const onTestah = onFamilyResults.find((item) => item.family === 'testah_pullback');
  assert.equal(onTestah?.signalType, 'entry');
  assert.equal(onTestah?.matched, false);
  assert.equal(onTestah?.details.regimeMatched, false);
  assert.equal(onTestah?.details.regimeWouldMatchExpanded, true);
  assert.equal(onTestah?.details.regimeExpansionGain, true);

  const runnerResult = await runLunaMarketGate({
    dryRun: true,
    writeOutput: false,
    env: { LUNA_REGIME_EXPANSION_SHADOW: 'true' },
    gates: [],
    regimes: [],
    strategySignals: [
      { ...fixtureSignal('testah_pullback'), details: { regimeExpansionGain: true } },
      { ...fixtureSignal('turtle_breakout'), details: { regimeExpansionGain: false } },
    ],
    preflightEvaluations: [],
    circuitLocks: [],
  });
  assert.equal(runnerResult.regimeExpansion.enabled, true);
  assert.equal(runnerResult.regimeExpansion.gainCount, 1);
  assert.equal(runnerResult.regimeExpansion.byFamily.testah_pullback, 1);
  assert.equal(runnerResult.summary.includes('레짐 확대 shadow: +1건 매칭 가능'), true);

  const runnerOff = await runLunaMarketGate({
    dryRun: true,
    writeOutput: false,
    env: { LUNA_REGIME_EXPANSION_SHADOW: 'false' },
    gates: [],
    regimes: [],
    strategySignals: [{ ...fixtureSignal('testah_pullback'), details: { regimeExpansionGain: true } }],
    preflightEvaluations: [],
    circuitLocks: [],
  });
  assert.equal(Object.prototype.hasOwnProperty.call(runnerOff, 'regimeExpansion'), false);
  assert.equal(runnerOff.summary.includes('레짐 확대 shadow'), false);

  const seedDryRun = await seedLunaComponentRegistry({ dryRun: true });
  assert.equal(seedDryRun.components.includes('regime-expansion-shadow-sim'), true);
  assert.equal(LUNA_COMPONENT_REGISTRY_SEED.some((row) => row.component === 'regime-expansion-shadow-sim'), true);

  return {
    ok: true,
    smoke: 'luna-regime-expansion',
    scenarios: {
      offDiffZeroKeys: true,
      onSidewaysGain: onTestah.details.regimeExpansionGain,
      matchedUnchanged: onTestah.matched === false && onTestah.details.regimeMatched === false,
      bearExcluded: true,
      bullAlreadyMatchedGain: bullAttached.details.regimeExpansionGain,
      runnerGainCount: runnerResult.regimeExpansion.gainCount,
      registrySeedCount: seedDryRun.seeded,
      defaultExpandedRegimes: LUNA_STRATEGY_FAMILY_EXPANDED_REGIMES,
      eightWayPolicy,
    },
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: '❌ luna-regime-expansion-smoke 실패:',
  });
}

export { main as runLunaRegimeExpansionSmoke };
