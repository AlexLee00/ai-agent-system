#!/usr/bin/env node
// @ts-nocheck
// Canonical smoke: operations DB contact is forbidden; persistence uses an in-memory sink.

import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  LUNA_STRATEGY_EXIT_SHADOW_CONFIRM,
  buildStrategyExitShadowRow,
  evaluateStrategyExitShadow,
  mapSetupTypeToStrategyExitFamily,
  runStrategyExitShadowSidecar,
  upsertStrategyExitShadow,
} from '../shared/luna-strategy-exit-shadow.ts';
import { runStrategyExitShadowForReevaluation } from '../shared/position-reevaluator.ts';
import { LUNA_COMPONENT_REGISTRY_SEED, seedLunaComponentRegistry } from './luna-registry-seed.ts';

const INVESTMENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_EVALUATOR_PATH = path.join(INVESTMENT_ROOT, 'scripts', 'runtime-luna-registry-evaluator.ts');

function bar(day: number, close: number, extra: any = {}) {
  return {
    timestamp: new Date(Date.parse('2026-01-01T00:00:00Z') + day * 86_400_000).toISOString(),
    open: extra.open ?? close - 0.4,
    high: extra.high ?? close + 0.6,
    low: extra.low ?? close - 0.6,
    close,
    volume: extra.volume ?? 1000 + day,
  };
}

function turtleExitBars() {
  return [110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 109]
    .map((close, idx) => bar(idx, close));
}

function turtleHoldBars() {
  return [110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120]
    .map((close, idx) => bar(idx, close));
}

function testahExitBars() {
  const bars = Array.from({ length: 80 }, (_, idx) => bar(idx, 100 + idx));
  bars.push(bar(80, 120, { high: 122, low: 118 }));
  return bars;
}

function params() {
  return {
    turtle: { entryLookback: 20, exitLookback: 10, atrPeriod: 20, atrMult: 2, maFilter: 200 },
    testah: { maFast: 5, maMid: 25, maSlow: 75, pullbackWindow: 5 },
    regimeMatch: { turtle: ['bull', 'volatile'], testah: ['bull'] },
  };
}

async function main() {
  const scenarios = [];

  const turtleExit = evaluateStrategyExitShadow({
    profile: { setup_type: 'breakout' },
    bars: turtleExitBars(),
    params: params(),
  });
  assert.equal(turtleExit.family, 'turtle_breakout');
  assert.equal(turtleExit.c3Decision, 'exit');
  assert.equal(turtleExit.c3Reason, 'exit_lookback_close_breakdown');
  scenarios.push('turtle_exit_breakdown');

  const testahExit = evaluateStrategyExitShadow({
    profile: { setup_type: 'micro_swing' },
    bars: testahExitBars(),
    params: params(),
  });
  assert.equal(testahExit.family, 'testah_pullback');
  assert.equal(testahExit.c3Decision, 'exit');
  assert.equal(testahExit.c3Reason, 'close_below_ma_mid');
  scenarios.push('testah_exit_below_ma_mid');

  const turtleHold = evaluateStrategyExitShadow({
    profile: { setup_type: 'trend_following' },
    bars: turtleHoldBars(),
    params: params(),
  });
  assert.equal(turtleHold.c3Decision, 'hold');
  assert.equal(turtleHold.c3Reason, 'no_exit_breakdown');
  scenarios.push('turtle_hold');

  for (const setupType of ['defensive_rotation', 'momentum_rotation', 'promotion_ready_shadow']) {
    const skipped = evaluateStrategyExitShadow({
      profile: { setup_type: setupType },
      bars: turtleExitBars(),
      params: params(),
    });
    assert.equal(skipped.skipped, true);
    assert.equal(mapSetupTypeToStrategyExitFamily({ setup_type: setupType }).skipped, true);
  }
  scenarios.push('unmapped_setups_skipped');

  const comparisonRow = buildStrategyExitShadowRow({
    position: { symbol: 'BTC/USDT', exchange: 'binance', paper: false, trade_mode: 'normal' },
    strategyProfile: { id: 'profile-smoke', setup_type: 'breakout' },
    tradeMode: 'normal',
    currentDecision: { recommendation: 'HOLD', reasonCode: 'hold_bias' },
    evaluation: turtleExit,
    bars: turtleExitBars(),
  });
  assert.equal(comparisonRow.positionId, 'profile-smoke');
  assert.equal(comparisonRow.currentDecision, 'HOLD');
  assert.equal(comparisonRow.c3Decision, 'exit');
  assert.equal(comparisonRow.agreement, false);
  scenarios.push('agreement_false');

  let fetchCalls = 0;
  let writeCalls = 0;
  const disabled = await runStrategyExitShadowSidecar({
    position: { symbol: 'BTC/USDT', exchange: 'binance', paper: false },
    strategyProfile: { id: 'profile-disabled', setup_type: 'breakout' },
    currentDecision: { recommendation: 'HOLD' },
    env: { LUNA_STRATEGY_EXIT_SHADOW: 'false' },
    params: params(),
  }, {
    fetchPhaseABars: async () => {
      fetchCalls += 1;
      return { bars: turtleExitBars(), source: 'fixture', error: null };
    },
    upsertStrategyExitShadow: async () => {
      writeCalls += 1;
      return { rowCount: 1, rows: [{ id: 1 }] };
    },
  });
  assert.equal(disabled.enabled, false);
  assert.equal(fetchCalls, 0);
  assert.equal(writeCalls, 0);
  scenarios.push('env_off_noop');

  const originalDecision = { recommendation: 'HOLD', reasonCode: 'hold_bias' };
  const failOpen = await runStrategyExitShadowForReevaluation({
    position: { symbol: 'BTC/USDT', exchange: 'binance', paper: false },
    strategyProfile: { id: 'profile-fail-open', setup_type: 'breakout' },
    currentDecision: originalDecision,
    tradeMode: 'normal',
    persist: true,
    env: {
      LUNA_STRATEGY_EXIT_SHADOW: 'true',
      LUNA_STRATEGY_EXIT_SHADOW_CONFIRM: LUNA_STRATEGY_EXIT_SHADOW_CONFIRM,
    },
    params: params(),
    now: '2026-12-31T00:00:00Z',
  }, {
    fetchPhaseABars: async () => ({ bars: turtleExitBars(), source: 'fixture', error: null }),
    upsertStrategyExitShadow: async () => {
      throw new Error('fixture_write_down');
    },
  });
  assert.deepEqual(originalDecision, { recommendation: 'HOLD', reasonCode: 'hold_bias' });
  assert.equal(failOpen.ok, false);
  assert.equal(failOpen.error, 'fixture_write_down');
  scenarios.push('reevaluator_sidecar_fail_open');

  const shadowRows = new Map();
  const runFn = async (sql: string, params: any[] = []) => {
    assert.match(sql, /INSERT INTO luna_strategy_exit_shadow/i);
    const key = `${params[0]}\u0001${String(params[9])}`;
    const existing = shadowRows.get(key);
    const stored = { id: existing?.id || shadowRows.size + 1, currentReason: params[7], params };
    shadowRows.set(key, stored);
    return { rowCount: 1, rows: [{ id: stored.id }] };
  };
  const row = {
    ...comparisonRow,
    candleTs: '2099-06-19T00:00:00.000Z',
    currentReason: 'hold_bias_v1',
  };
  await upsertStrategyExitShadow(row, runFn);
  await upsertStrategyExitShadow({ ...row, currentReason: 'hold_bias_v2' }, runFn);
  const storedRow = shadowRows.values().next().value;
  const transactional = { count: shadowRows.size, currentReason: storedRow.currentReason };
  assert.equal(transactional.count, 1);
  assert.equal(transactional.currentReason, 'hold_bias_v2');
  scenarios.push('upsert_idempotent_in_memory');

  const seedDryRun = await seedLunaComponentRegistry({ dryRun: true });
  assert.equal(seedDryRun.components.includes('strategy-exit-shadow'), true);
  assert.equal(seedDryRun.components.includes('learned-regime-bias'), true);
  assert.equal(LUNA_COMPONENT_REGISTRY_SEED.some((row: any) => row.component === 'strategy-exit-shadow'), true);
  assert.equal(LUNA_COMPONENT_REGISTRY_SEED.length, 45);
  const evaluatorSource = fs.readFileSync(REGISTRY_EVALUATOR_PATH, 'utf8');
  assert.match(evaluatorSource, /strategy-exit-shadow/);
  assert.match(evaluatorSource, /luna_strategy_exit_shadow/);
  scenarios.push('registry_seed_and_sample_count');

  return {
    ok: true,
    smoke: 'luna-strategy-exit-shadow',
    scenarios,
    transactional,
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    onSuccess: async (result) => {
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log('luna-strategy-exit-shadow smoke ok');
    },
    errorPrefix: '❌ luna-strategy-exit-shadow-smoke 실패:',
  });
}

export default {
  main,
};
