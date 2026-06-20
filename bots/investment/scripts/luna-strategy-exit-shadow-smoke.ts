#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as db from '../shared/db.ts';
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

const ROLLBACK_SENTINEL = 'luna_strategy_exit_shadow_smoke_rollback';
const INVESTMENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION_PATH = path.join(INVESTMENT_ROOT, 'migrations', '20260619000005_luna_strategy_exit_shadow.sql');
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

async function withRollback(work: any) {
  let output;
  try {
    await db.withTransaction(async (tx: any) => {
      await tx.run(fs.readFileSync(MIGRATION_PATH, 'utf8'));
      output = await work(tx);
      throw new Error(ROLLBACK_SENTINEL);
    });
  } catch (error) {
    if (error?.message !== ROLLBACK_SENTINEL) throw error;
    return output;
  }
  throw new Error('luna_strategy_exit_shadow_expected_rollback');
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

  const transactional = await withRollback(async (tx: any) => {
    const row = {
      ...comparisonRow,
      candleTs: '2099-06-19T00:00:00.000Z',
      currentReason: 'hold_bias_v1',
    };
    await upsertStrategyExitShadow(row, tx.run);
    await upsertStrategyExitShadow({ ...row, currentReason: 'hold_bias_v2' }, tx.run);
    const rows = await tx.query(
      `SELECT COUNT(*)::int AS count, MAX(current_reason) AS current_reason
         FROM luna_strategy_exit_shadow
        WHERE position_id = $1
          AND candle_ts = $2`,
      [row.positionId, row.candleTs],
    );
    assert.equal(Number(rows?.[0]?.count || 0), 1);
    assert.equal(rows?.[0]?.current_reason, 'hold_bias_v2');
    return { count: Number(rows?.[0]?.count || 0), currentReason: rows?.[0]?.current_reason };
  });
  assert.equal(transactional.count, 1);
  scenarios.push('upsert_idempotent_rollback');

  const seedDryRun = await seedLunaComponentRegistry({ dryRun: true });
  assert.equal(seedDryRun.components.includes('strategy-exit-shadow'), true);
  assert.equal(seedDryRun.components.includes('learned-regime-bias'), true);
  assert.equal(LUNA_COMPONENT_REGISTRY_SEED.some((row: any) => row.component === 'strategy-exit-shadow'), true);
  assert.equal(LUNA_COMPONENT_REGISTRY_SEED.length, 46);
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
