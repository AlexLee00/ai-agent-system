#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { evaluateEntryTriggers } from '../shared/entry-trigger-engine.ts';
import { runLunaMarketGate } from './runtime-luna-market-gate.ts';
import {
  assertEntryTriggerShadow,
  buildEntryTriggerShadowFlags,
  strategySignalToEntryCandidate,
  strategySignalsToEntryCandidates,
} from '../shared/brokers/strategy-to-entry-trigger-adapter.ts';

function entrySignal(family = 'turtle_breakout', extra: any = {}) {
  return {
    market: 'crypto',
    symbol: 'BTC/USDT',
    family,
    signalType: 'entry',
    candleTs: '2026-06-18T00:00:00Z',
    price: 65000,
    stop: 63500,
    target: 68000,
    rr: 2,
    reason: 'fixture_entry',
    matched: true,
    regime: { dominant: 'bull', market: 'crypto' },
    details: { atr: 750, previousHigh: 64800, regimeMatched: true },
    ...extra,
  };
}

async function main() {
  const turtle = strategySignalToEntryCandidate(entrySignal('turtle_breakout'));
  assert.equal(turtle.action, 'BUY');
  assert.equal(turtle.symbol, 'BTC/USDT');
  assert.equal(turtle.setup_type, 'strategy_family_breakout');
  assert.equal(turtle.triggerType, 'breakout_confirmation');
  assert.ok(turtle.confidence >= 0.48 && turtle.confidence <= 0.90);

  const testah = strategySignalToEntryCandidate(entrySignal('testah_pullback', {
    symbol: 'ETH/USDT',
    rr: 1.6,
    details: { maFast: 10, previousSwingHigh: 3000, regimeMatched: true },
  }));
  assert.equal(testah.action, 'BUY');
  assert.equal(testah.symbol, 'ETH/USDT');
  assert.equal(testah.setup_type, 'strategy_family_pullback');
  assert.equal(testah.triggerType, 'pullback_to_support');

  const filtered = strategySignalsToEntryCandidates([
    entrySignal('turtle_breakout'),
    { ...entrySignal('turtle_breakout'), signalType: 'exit' },
    { ...entrySignal('testah_pullback'), signalType: 'none' },
    { ...entrySignal('testah_pullback'), signalType: 'invalidate' },
    { ...entrySignal('testah_pullback'), symbol: '' },
  ]);
  assert.equal(filtered.length, 1);

  const flags = buildEntryTriggerShadowFlags({
    env: {
      LUNA_RUNTIME_ENV_SOURCE: 'process',
      LUNA_INTELLIGENT_DISCOVERY_MODE: 'autonomous_l5',
      LUNA_ENTRY_TRIGGER_ENGINE_ENABLED: 'true',
      LUNA_LIVE_FIRE_ENABLED: 'true',
      LUNA_ENTRY_TRIGGER_FIRE_IN_SHADOW: 'true',
    },
  });
  assert.equal(flags.liveFireEnabled, false);
  assert.equal(flags.shouldAllowLiveEntryFire(), false);
  assert.equal(flags.shouldEntryTriggerMutate(), false);
  assert.equal(assertEntryTriggerShadow(flags, { dryRun: true }), true);
  assert.equal(assertEntryTriggerShadow(flags, { dryRun: false, entryTriggerShadowPersistence: true }), true);

  const realDryRun = await evaluateEntryTriggers([turtle], {
    dryRun: true,
    env: { LUNA_FULL_DATA_LOOP_ENABLED: 'false' },
    flags,
    exchange: 'binance',
    market: 'crypto',
    regime: 'bull',
    queryFn: async () => [],
    openPositionSymbols: [],
  });
  assert.equal(realDryRun.stats.fired, 0);
  assert.equal(realDryRun.stats.allowLiveFire, false);
  assert.equal(realDryRun.stats.shouldMutate, false);

  let observedContext = null;
  const result = await runLunaMarketGate({
    dryRun: true,
    writeOutput: false,
    entryTriggerShadow: true,
    env: { LUNA_ENTRY_TRIGGER_SHADOW: 'true', LUNA_LIVE_FIRE_ENABLED: 'true' },
    strategySignals: [entrySignal('turtle_breakout'), entrySignal('testah_pullback', { symbol: 'ETH/USDT' })],
    preflightEvaluations: [],
    circuitLocks: [],
    gates: [{ market: 'crypto', score: 70, deployment: 'full' }],
    regimes: [{ market: 'crypto', dominant: 'bull', probabilities: { bull: 0.8 }, source: 'fixture' }],
    openPositionSymbols: [],
  }, {
    evaluateEntryTriggers: async (candidates, context) => {
      observedContext = context;
      assert.equal(context.dryRun, true);
      assert.equal(context.flags.liveFireEnabled, false);
      assert.equal(context.flags.shouldAllowLiveEntryFire(), false);
      return {
        decisions: candidates.map((candidate) => ({
          ...candidate,
          block_meta: { ...(candidate.block_meta || {}), entryTrigger: { state: 'ready', observedOnly: true } },
        })),
        stats: { enabled: true, armed: candidates.length, fired: 0, blocked: 0, observed: candidates.length, allowLiveFire: false, shouldMutate: false, mode: 'shadow' },
      };
    },
  });
  assert.equal(result.entryTriggerShadow.candidates, 2);
  assert.equal(result.entryTriggerShadow.armed, 2);
  assert.equal(result.entryTriggerShadow.fired, 0);
  assert.equal(result.entryTriggerShadow.allowLiveFire, false);
  assert.equal(result.entryTriggerShadow.shouldMutate, false);
  assert.equal(result.liveMutation, false);
  assert.equal(result.protectedPidMutation, false);
  assert.ok(result.summary.includes('entry-trigger shadow: candidates 2 · armed 2 · fired 0'));
  assert.equal(observedContext?.dryRun, true);

  let persistenceContext = null;
  const persistenceResult = await runLunaMarketGate({
    dryRun: false,
    writeHistory: false,
    writeOutput: false,
    entryTriggerShadow: true,
    env: { LUNA_ENTRY_TRIGGER_SHADOW: 'true', LUNA_LIVE_FIRE_ENABLED: 'true' },
    strategySignals: [entrySignal('turtle_breakout')],
    preflightEvaluations: [],
    circuitLocks: [],
    gates: [{ market: 'crypto', score: 70, deployment: 'full' }],
    regimes: [{ market: 'crypto', dominant: 'bull', probabilities: { bull: 0.8 }, source: 'fixture' }],
    openPositionSymbols: [],
  }, {
    evaluateEntryTriggers: async (candidates, context) => {
      persistenceContext = context;
      assert.equal(context.dryRun, false);
      assert.equal(context.entryTriggerShadowPersistence, true);
      assert.equal(context.flags.liveFireEnabled, false);
      assert.equal(context.flags.shouldAllowLiveEntryFire(), false);
      assert.equal(context.flags.shouldEntryTriggerMutate(), false);
      return {
        decisions: candidates,
        stats: { enabled: true, armed: candidates.length, fired: 0, blocked: 0, observed: candidates.length, allowLiveFire: false, shouldMutate: false, mode: 'shadow' },
      };
    },
  });
  assert.equal(persistenceResult.entryTriggerShadow.armed, 1);
  assert.equal(persistenceResult.entryTriggerShadow.fired, 0);
  assert.equal(persistenceResult.entryTriggerShadow.shouldMutate, false);
  assert.equal(persistenceContext?.entryTriggerShadowPersistence, true);

  const isolated = await runLunaMarketGate({
    dryRun: true,
    writeOutput: false,
    entryTriggerShadow: true,
    strategySignals: [entrySignal('turtle_breakout')],
    preflightEvaluations: [],
    circuitLocks: [],
    gates: [{ market: 'crypto', score: 70, deployment: 'full' }],
    regimes: [{ market: 'crypto', dominant: 'bull', probabilities: { bull: 0.8 }, source: 'fixture' }],
  }, {
    evaluateEntryTriggers: async () => {
      throw new Error('fixture_entry_trigger_down');
    },
  });
  assert.equal(isolated.entryTriggerShadowError, 'fixture_entry_trigger_down');
  assert.equal(isolated.gates.length, 1);
  assert.equal(isolated.entryTriggerShadow.fired, 0);

  return {
    ok: true,
    smoke: 'luna-et-a',
    adapter: { turtle: turtle.setup_type, testah: testah.setup_type },
    realDryRun: realDryRun.stats,
    shadow: result.entryTriggerShadow,
    persistence: persistenceResult.entryTriggerShadow,
    isolatedError: isolated.entryTriggerShadowError,
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: '❌ luna-et-a-smoke 실패:',
  });
}

export { main as runLunaEtASmoke };
