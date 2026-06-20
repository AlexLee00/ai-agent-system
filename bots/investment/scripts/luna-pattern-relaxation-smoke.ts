#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runLunaMarketGate } from './runtime-luna-market-gate.ts';
import { LUNA_COMPONENT_REGISTRY_SEED, seedLunaComponentRegistry } from './luna-registry-seed.ts';
import {
  LUNA_STRATEGY_DEFAULTS,
  LUNA_STRATEGY_RELAXED_PARAMS,
  computeStrategyFamilySignals,
  evaluateTestahPullback,
  evaluateTurtleBreakout,
  isPatternRelaxationShadowEnabled,
  resolveStrategyFamilyRelaxedParams,
} from '../shared/luna-strategy-families.ts';

function bar(day: number, close: number, extra: any = {}) {
  return {
    timestamp: new Date(Date.parse('2026-01-01T00:00:00Z') + day * 86_400_000).toISOString(),
    open: extra.open ?? close - 0.5,
    high: extra.high ?? close + 1,
    low: extra.low ?? close - 1,
    close,
    volume: extra.volume ?? 1000 + day,
  };
}

function turtleRelaxationBars() {
  const bars = Array.from({ length: 119 }, (_, idx) => bar(idx, 100, { high: 101, low: 99 }));
  bars.push(bar(119, 130, { high: 131, low: 129 }));
  return bars;
}

function testahRelaxationBars() {
  const bars = Array.from({ length: 75 }, (_, idx) => bar(idx, 100 + idx * 0.55));
  bars[70] = bar(70, 138.5, { high: 180, low: 137.5 });
  bars.push(bar(75, 130, { high: 132, low: 128 }));
  for (let day = 76; day <= 80; day += 1) {
    bars.push(bar(day, 150, { high: 151, low: 149 }));
  }
  bars.push(bar(81, 151, { high: 152, low: 150 }));
  return bars;
}

function regime() {
  return {
    market: 'overseas',
    dominant: 'bull',
    probabilities: { bull: 0.7, bear: 0.1, sideways: 0.1, volatile: 0.1 },
    source: 'fixture',
    computedAt: '2026-06-19T00:00:00Z',
  };
}

async function computeWithBars(env: any, params = null) {
  return computeStrategyFamilySignals({
    universe: [
      { market: 'overseas', symbol: 'TURT', source: 'fixture' },
      { market: 'overseas', symbol: 'TEST', source: 'fixture' },
    ],
    env,
    now: '2026-12-31T00:00:00Z',
    params: params || {
      turtle: { ...LUNA_STRATEGY_DEFAULTS.turtle },
      testah: { ...LUNA_STRATEGY_DEFAULTS.testah },
      regimeMatch: { ...LUNA_STRATEGY_DEFAULTS.regimeMatch },
    },
    regime: regime(),
  }, {
    fetchPhaseABars: async ({ symbol }: any) => ({
      bars: symbol === 'TURT' ? turtleRelaxationBars() : testahRelaxationBars(),
      source: 'fixture_bars',
      error: null,
    }),
  });
}

async function main() {
  assert.equal(isPatternRelaxationShadowEnabled({ env: { LUNA_PATTERN_RELAXATION_SHADOW: 'false' } }), false);
  assert.equal(isPatternRelaxationShadowEnabled({ env: { LUNA_PATTERN_RELAXATION_SHADOW: 'true' } }), true);

  const turtleBase = evaluateTurtleBreakout(turtleRelaxationBars(), LUNA_STRATEGY_DEFAULTS.turtle);
  const turtleRelaxed = evaluateTurtleBreakout(turtleRelaxationBars(), {
    ...LUNA_STRATEGY_DEFAULTS.turtle,
    ...LUNA_STRATEGY_RELAXED_PARAMS.turtle,
  });
  assert.notEqual(turtleBase.signalType, 'entry');
  assert.equal(turtleRelaxed.signalType, 'entry');

  const testahBase = evaluateTestahPullback(testahRelaxationBars(), LUNA_STRATEGY_DEFAULTS.testah);
  const testahRelaxed = evaluateTestahPullback(testahRelaxationBars(), {
    ...LUNA_STRATEGY_DEFAULTS.testah,
    ...LUNA_STRATEGY_RELAXED_PARAMS.testah,
  });
  assert.notEqual(testahBase.signalType, 'entry');
  assert.equal(testahRelaxed.signalType, 'entry');

  const merged = resolveStrategyFamilyRelaxedParams({
    turtle: { ...LUNA_STRATEGY_DEFAULTS.turtle, atrMult: 3 },
    testah: { ...LUNA_STRATEGY_DEFAULTS.testah, maFast: 6 },
    regimeMatch: { turtle: ['bull'], testah: ['bull'] },
  }, {
    env: {
      LUNA_STRATEGY_RELAXED_PARAMS_JSON: JSON.stringify({
        turtle: { maFilter: 90 },
        testah: { pullbackWindow: 12 },
      }),
    },
  });
  assert.equal(merged.turtle.maFilter, 90);
  assert.equal(merged.turtle.entryLookback, LUNA_STRATEGY_DEFAULTS.turtle.entryLookback);
  assert.equal(merged.turtle.atrMult, 3);
  assert.equal(merged.testah.pullbackWindow, 12);
  assert.equal(merged.testah.maFast, 6);
  assert.equal(merged.testah.maSlow, LUNA_STRATEGY_DEFAULTS.testah.maSlow);

  const off = await computeWithBars({ LUNA_PATTERN_RELAXATION_SHADOW: 'false' });
  assert.equal(off.signals.length, 0);
  assert.equal(off.patternRelaxation.enabled, false);
  assert.equal(off.patternRelaxation.gainCount, 0);
  assert.equal(off.summary.includes('패턴 완화 shadow'), false);

  const on = await computeWithBars({ LUNA_PATTERN_RELAXATION_SHADOW: 'true' });
  assert.equal(on.signals.length, 0);
  assert.equal(on.patternRelaxation.enabled, true);
  assert.equal(on.patternRelaxation.gainCount, 2);
  assert.equal(on.patternRelaxation.byFamily.turtle, 1);
  assert.equal(on.patternRelaxation.byFamily.testah, 1);

  const alreadyEntry = await computeWithBars({ LUNA_PATTERN_RELAXATION_SHADOW: 'true' }, {
    turtle: { ...LUNA_STRATEGY_DEFAULTS.turtle, ...LUNA_STRATEGY_RELAXED_PARAMS.turtle },
    testah: { ...LUNA_STRATEGY_DEFAULTS.testah, ...LUNA_STRATEGY_RELAXED_PARAMS.testah },
    regimeMatch: { ...LUNA_STRATEGY_DEFAULTS.regimeMatch },
  });
  assert.equal(alreadyEntry.signals.filter((item: any) => item.signalType === 'entry').length, 2);
  assert.equal(alreadyEntry.patternRelaxation.gainCount, 0);

  const runnerOn = await runLunaMarketGate({
    dryRun: true,
    writeOutput: false,
    env: { LUNA_PATTERN_RELAXATION_SHADOW: 'true' },
    gates: [],
    regimes: [],
    preflightEvaluations: [],
    circuitLocks: [],
  }, {
    computeStrategyFamilySignals: async () => ({
      ok: true,
      signals: [],
      errors: [],
      summary: '전략군: 신호 0건(터틀 0·테스타 0)',
      patternRelaxation: on.patternRelaxation,
    }),
  });
  assert.equal(runnerOn.strategySignals.length, 0);
  assert.equal(runnerOn.strategyInserted.length, 0);
  assert.equal(runnerOn.patternRelaxation.gainCount, 2);
  assert.equal(runnerOn.summary.includes('패턴 완화 shadow: +2 entry 가능(터틀 1·테스타 1)'), true);

  const runnerOff = await runLunaMarketGate({
    dryRun: true,
    writeOutput: false,
    env: { LUNA_PATTERN_RELAXATION_SHADOW: 'false' },
    gates: [],
    regimes: [],
    strategySignals: [],
    preflightEvaluations: [],
    circuitLocks: [],
    patternRelaxation: on.patternRelaxation,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(runnerOff, 'patternRelaxation'), false);
  assert.equal(runnerOff.summary.includes('패턴 완화 shadow'), false);

  const seedDryRun = await seedLunaComponentRegistry({ dryRun: true });
  assert.equal(seedDryRun.components.includes('pattern-relaxation-shadow-sim'), true);
  assert.equal(seedDryRun.components.includes('learned-regime-bias'), true);
  assert.equal(LUNA_COMPONENT_REGISTRY_SEED.some((row: any) => row.component === 'pattern-relaxation-shadow-sim'), true);
  assert.equal(LUNA_COMPONENT_REGISTRY_SEED.length, 46);

  return {
    ok: true,
    smoke: 'luna-pattern-relaxation',
    scenarios: {
      turtleGain: turtleRelaxed.signalType,
      testahGain: testahRelaxed.signalType,
      offSignalsUnchanged: off.signals.length === 0,
      onSignalsUnchanged: on.signals.length === 0,
      gainCount: on.patternRelaxation.gainCount,
      alreadyEntryGain: alreadyEntry.patternRelaxation.gainCount,
      runnerLine: runnerOn.summary.includes('패턴 완화 shadow'),
      registrySeedCount: LUNA_COMPONENT_REGISTRY_SEED.length,
    },
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: '❌ luna-pattern-relaxation-smoke 실패:',
  });
}

export { main as runLunaPatternRelaxationSmoke };
