#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runLunaMarketGate } from './runtime-luna-market-gate.ts';
import { LUNA_COMPONENT_REGISTRY_SEED, seedLunaComponentRegistry } from './luna-registry-seed.ts';
import {
  attachRegimeToSignal,
  ensureStrategySignalsSchema,
  evaluateStrategyFamiliesForSymbol,
  evaluateTestahPullback,
  evaluateTurtleBreakout,
  insertStrategyFamilySignals,
  summarizeStrategyFamilySignals,
} from '../shared/luna-strategy-families.ts';

const ROLLBACK_SENTINEL = 'luna_strategy_families_smoke_rollback';

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

function turtleEntryBars() {
  const bars = Array.from({ length: 220 }, (_, idx) => bar(idx, 100 + idx * 0.08));
  const prevHigh = Math.max(...bars.slice(-20).map((item) => item.high));
  bars.push(bar(220, prevHigh + 1.2, { high: prevHigh + 1.6 }));
  return bars;
}

function turtleCompactBars(closes: number[], highs: number[] = []) {
  return closes.map((close, idx) => bar(idx, close, { high: highs[idx] ?? close + 0.2, low: close - 0.5 }));
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

function testahTrendBars(count = 82) {
  return Array.from({ length: count }, (_, idx) => bar(idx, 100 + idx * 0.45));
}

async function withRollback(work: any) {
  let output;
  try {
    await db.withTransaction(async (tx: any) => {
      await ensureStrategySignalsSchema(tx.run);
      output = await work(tx);
      throw new Error(ROLLBACK_SENTINEL);
    });
  } catch (error) {
    if (error?.message !== ROLLBACK_SENTINEL) throw error;
    return output;
  }
  throw new Error('luna_strategy_families_smoke_expected_rollback');
}

async function main() {
  const turtleEntry = evaluateTurtleBreakout(turtleEntryBars());
  assert.equal(turtleEntry.signalType, 'entry');
  assert.equal(turtleEntry.reason, 'close_breaks_prior_high_with_ma_filter');
  assert.equal(
    turtleEntry.stop,
    Number((turtleEntry.price - 2 * turtleEntry.details.atr).toFixed(6)),
  );

  const touchOnly = evaluateTurtleBreakout(turtleCompactBars(
    [100, 101, 102, 103, 103.1],
    [100.2, 101.2, 102.2, 104.5, 105],
  ), { entryLookback: 3, maFilter: 3, atrPeriod: 3 });
  assert.equal(touchOnly.signalType, 'none');
  assert.equal(touchOnly.reason, 'close_not_breakout');

  const belowMa = evaluateTurtleBreakout(turtleCompactBars(
    [200, 200, 90, 101],
    [100, 100, 100, 101.2],
  ), { entryLookback: 2, maFilter: 3, atrPeriod: 2 });
  assert.equal(belowMa.signalType, 'none');
  assert.equal(belowMa.reason, 'ma_filter_not_met');

  const turtleExit = evaluateTurtleBreakout(turtleCompactBars(
    [110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 109],
  ), { positionOpen: true, exitLookback: 10 });
  assert.equal(turtleExit.signalType, 'exit');

  const repeatedBars = [...turtleEntryBars(), bar(221, 122.5, { high: 123 })];
  const repeated = evaluateTurtleBreakout(repeatedBars);
  assert.equal(repeated.signalType, 'none');
  assert.equal(repeated.reason, 'not_new_breakout');

  const testahEntry = evaluateTestahPullback(testahEntryBars());
  assert.equal(testahEntry.signalType, 'entry');
  assert.equal(testahEntry.reason, 'fast_ma_reclaim_after_pullback_in_aligned_trend');

  const testahOpenNoExit = evaluateTestahPullback(testahEntryBars(), { positionOpen: true });
  assert.equal(testahOpenNoExit.signalType, 'none');
  assert.equal(testahOpenNoExit.reason, 'no_exit_below_ma_mid');

  const notAligned = evaluateTestahPullback(Array.from({ length: 82 }, (_, idx) => bar(idx, 150 - idx * 0.4)));
  assert.equal(notAligned.signalType, 'none');
  assert.equal(notAligned.reason, 'ma_alignment_not_met');

  const invalidate = evaluateTestahPullback([
    ...testahTrendBars(80),
    bar(80, 80, { high: 81, low: 79 }),
  ], { pendingSetup: true });
  assert.equal(invalidate.signalType, 'invalidate');

  const noPullback = evaluateTestahPullback(testahTrendBars(84));
  assert.equal(noPullback.signalType, 'none');
  assert.equal(noPullback.reason, 'no_recent_pullback_below_fast_ma');

  const badRr = evaluateTestahPullback(testahEntryBars({ lowStop: 129, swingHigh: 170, entryClose: 150 }));
  assert.equal(badRr.signalType, 'none');
  assert.equal(badRr.reason, 'invalid_rr_below_1');

  const bearRegime = { market: 'overseas', dominant: 'bear', probabilities: { bull: 0.1, bear: 0.7, sideways: 0.1, volatile: 0.1 }, source: 'fixture', computedAt: '2026-06-11T00:00:00Z' };
  const regimeAttached = attachRegimeToSignal(turtleEntry, 'overseas', bearRegime, ['bull', 'volatile']);
  assert.equal(regimeAttached.matched, false);
  assert.equal(regimeAttached.regime.dominant, 'bear');

  const familyResults = await evaluateStrategyFamiliesForSymbol({
    market: 'overseas',
    symbol: 'AAPL',
    bars: turtleEntryBars(),
    regime: bearRegime,
    now: '2026-12-31T00:00:00Z',
    params: {
      turtle: { entryLookback: 20, exitLookback: 10, atrPeriod: 20, atrMult: 2, maFilter: 200 },
      testah: { maFast: 5, maMid: 25, maSlow: 75, pullbackWindow: 5 },
      regimeMatch: { turtle: ['bull', 'volatile'], testah: ['bull'] },
    },
  });
  assert.equal(familyResults.some((item) => item.signalType === 'entry' && item.family === 'turtle_breakout'), true);

  const dbStamp = new Date(Date.now() + 180_000).toISOString();
  const dbResult = await withRollback(async (tx: any) => {
    const duplicateSignal = {
      ...regimeAttached,
      market: 'overseas',
      symbol: 'AAPL',
      candleTs: dbStamp,
      signalType: 'entry',
    };
    await insertStrategyFamilySignals([duplicateSignal, duplicateSignal], tx.run);
    const rows = await tx.query(
      `SELECT COUNT(*)::int AS count
         FROM luna_strategy_signals
        WHERE symbol = 'AAPL'
          AND candle_ts = $1`,
      [dbStamp],
    );
    assert.equal(Number(rows?.[0]?.count || 0), 1);
    return { count: Number(rows?.[0]?.count || 0) };
  });
  assert.equal(dbResult.count, 1);

  const gateFailure = await runLunaMarketGate({ dryRun: true, writeOutput: false }, {
    computeAllMarketDeploymentGates: async () => [{ market: 'crypto', score: 70, deployment: 'full' }],
    computeAllRegimeStates: async () => [bearRegime],
    computeStrategyFamilySignals: async () => {
      throw new Error('fixture_strategy_down');
    },
    evaluateEntryPreflightsForSignals: async () => [],
    evaluateLossCircuits: async () => ({ locks: [] }),
  });
  assert.equal(gateFailure.strategyError, 'fixture_strategy_down');
  assert.equal(gateFailure.gates.length, 1);
  assert.equal(gateFailure.regimes.length, 1);

  const line = summarizeStrategyFamilySignals([regimeAttached, { ...regimeAttached, family: 'testah_pullback' }]);
  assert.equal(line, '전략군: 신호 2건(터틀 1·테스타 1)');

  const seedDryRun = await seedLunaComponentRegistry({ dryRun: true });
  assert.ok(LUNA_COMPONENT_REGISTRY_SEED.length >= 32);
  assert.equal(seedDryRun.seeded, LUNA_COMPONENT_REGISTRY_SEED.length);
  assert.equal(seedDryRun.components.includes('strategy-family-turtle'), true);
  assert.equal(seedDryRun.components.includes('strategy-family-testah'), true);
  assert.equal(seedDryRun.components.includes('entry-trigger-shadow-link'), true);

  return {
    ok: true,
    smoke: 'luna-strategy-families',
    scenarios: {
      turtleEntry: turtleEntry.signalType,
      turtleTouchOnly: touchOnly.reason,
      turtleMaFilter: belowMa.reason,
      turtleExit: turtleExit.signalType,
      turtleRepeated: repeated.reason,
      testahEntry: testahEntry.signalType,
      testahOpenNoExit: testahOpenNoExit.reason,
      testahNotAligned: notAligned.reason,
      testahInvalidate: invalidate.signalType,
      testahNoPullback: noPullback.reason,
      badRr: badRr.reason,
      regimeMatched: regimeAttached.matched,
      dbRollback: true,
      runnerIndependentFailure: gateFailure.strategyError,
      registrySeedCount: seedDryRun.seeded,
    },
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: '❌ luna-strategy-families-smoke 실패:',
  });
}

export { main as runLunaStrategyFamiliesSmoke };
