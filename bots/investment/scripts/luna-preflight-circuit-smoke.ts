#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runLunaMarketGate } from './runtime-luna-market-gate.ts';
import { LUNA_COMPONENT_REGISTRY_SEED, seedLunaComponentRegistry } from './luna-registry-seed.ts';
import {
  LUNA_ENTRY_PREFLIGHT_SCHEMA_SQL,
  evaluateEntryPreflight,
  insertEntryPreflightLogs,
} from '../shared/luna-entry-preflight-gate.ts';
import {
  LUNA_CIRCUIT_SCHEMA_SQL,
  evaluateLossCircuits,
  insertCircuitLocks,
} from '../shared/luna-loss-circuit.ts';
import {
  evaluateStrategyFamiliesForSymbol,
  dropIncompleteLastBar,
} from '../shared/luna-strategy-families.ts';

const ROLLBACK_SENTINEL = 'luna_preflight_circuit_smoke_rollback';

function dayIso(base: string, offset: number) {
  return new Date(Date.parse(base) + offset * 86_400_000).toISOString();
}

function bar(timestamp: string, close: number, extra: any = {}) {
  return {
    timestamp,
    open: extra.open ?? close - 0.3,
    high: extra.high ?? close + 0.5,
    low: extra.low ?? close - 0.5,
    close,
    volume: extra.volume ?? 100_000,
  };
}

function turtleBarsEnding(lastTs = '2026-06-11T00:00:00Z') {
  const count = 220;
  const baseMs = Date.parse(lastTs) - count * 86_400_000;
  const bars = Array.from({ length: count }, (_, idx) => {
    const close = 100 + idx * 0.08;
    return bar(new Date(baseMs + idx * 86_400_000).toISOString(), close);
  });
  const prevHigh = Math.max(...bars.slice(-20).map((item) => item.high));
  bars.push(bar(lastTs, prevHigh + 1.2, { high: prevHigh + 1.6 }));
  return bars;
}

function liquidBars(count = 25, turnover = 2_000_000) {
  return Array.from({ length: count }, (_, idx) => {
    const close = 100;
    const volume = turnover / close;
    return bar(dayIso('2026-05-01T00:00:00Z', idx), close, { volume });
  });
}

function entrySignal(overrides: any = {}) {
  return {
    id: overrides.id ?? 100,
    market: overrides.market || 'crypto',
    symbol: overrides.symbol || 'BTC/USDT',
    family: overrides.family || 'turtle_breakout',
    signalType: 'entry',
    candleTs: overrides.candleTs || '2026-06-10T00:00:00Z',
    price: overrides.price ?? 100,
    stop: overrides.stop ?? 90,
    target: overrides.target ?? 140,
    rr: overrides.rr ?? 4,
    regime: overrides.regime || {
      dominant: 'bull',
      probabilities: { bull: 0.7, bear: 0.1, sideways: 0.1, volatile: 0.1 },
    },
  };
}

function trade(overrides: any = {}) {
  const exitTime = overrides.exitTime || Date.parse('2026-06-11T10:00:00Z');
  return {
    id: overrides.id || `trade-${Math.random()}`,
    market: overrides.market || 'crypto',
    exchange: overrides.exchange || 'binance',
    symbol: overrides.symbol || 'BTC/USDT',
    direction: overrides.direction || 'long',
    exit_reason: overrides.exitReason || 'protective_order_reconciled:stop_loss',
    entry_price: overrides.entryPrice ?? 100,
    exit_price: overrides.exitPrice ?? 95,
    sl_price: overrides.stopPrice ?? 95,
    pnl_percent: overrides.pnlPercent ?? -5,
    pnl_amount: overrides.pnlAmount ?? -5,
    pnl_net: overrides.pnlNet ?? -5,
    exit_time: exitTime,
  };
}

async function withRollback(work: any) {
  let output;
  try {
    await db.withTransaction(async (tx: any) => {
      for (const statement of LUNA_ENTRY_PREFLIGHT_SCHEMA_SQL) await tx.run(statement);
      for (const statement of LUNA_CIRCUIT_SCHEMA_SQL) await tx.run(statement);
      output = await work(tx);
      throw new Error(ROLLBACK_SENTINEL);
    });
  } catch (error) {
    if (error?.message !== ROLLBACK_SENTINEL) throw error;
    return output;
  }
  throw new Error('luna_preflight_circuit_smoke_expected_rollback');
}

function gateByName(result: any, name: string) {
  return result.gates.find((item: any) => item.name === name);
}

async function strategyIncompleteBarScenarios() {
  const bars = turtleBarsEnding('2026-06-11T00:00:00Z');
  const params = {
    turtle: { entryLookback: 20, exitLookback: 10, atrPeriod: 20, atrMult: 2, maFilter: 200 },
    testah: { maFast: 5, maMid: 25, maSlow: 75, pullbackWindow: 5 },
    regimeMatch: { turtle: ['bull', 'volatile'], testah: ['bull'] },
  };
  const regime = { market: 'crypto', dominant: 'bull', probabilities: { bull: 0.7, bear: 0.1, sideways: 0.1, volatile: 0.1 }, source: 'fixture' };
  const incomplete = await evaluateStrategyFamiliesForSymbol({
    market: 'crypto',
    symbol: 'BTC/USDT',
    bars,
    params,
    regime,
    now: '2026-06-11T12:00:00Z',
  });
  const completed = await evaluateStrategyFamiliesForSymbol({
    market: 'crypto',
    symbol: 'BTC/USDT',
    bars,
    params,
    regime,
    now: '2026-06-12T01:00:00Z',
  });
  const completedAgain = await evaluateStrategyFamiliesForSymbol({
    market: 'crypto',
    symbol: 'BTC/USDT',
    bars,
    params,
    regime,
    now: '2026-06-12T01:00:00Z',
  });
  const incompleteTurtle = incomplete.find((item) => item.family === 'turtle_breakout');
  const completedTurtle = completed.find((item) => item.family === 'turtle_breakout');
  const completedAgainTurtle = completedAgain.find((item) => item.family === 'turtle_breakout');
  assert.equal(incompleteTurtle.signalType, 'none');
  assert.equal(completedTurtle.signalType, 'entry');
  assert.deepEqual(completedTurtle, completedAgainTurtle);
  assert.equal(dropIncompleteLastBar(bars, 'crypto', '2026-06-11T12:00:00Z').length, bars.length - 1);
  return { incomplete: incompleteTurtle.reason, completed: completedTurtle.signalType, stable: true };
}

async function preflightScenarios() {
  const baseOptions = {
    parameters: {
      'c4.min_rr': 2,
      'c4.e_min_samples': 30,
      'c4.sideways_block_threshold': 0.5,
      'c4.min_liquidity': { crypto: 1_000_000, domestic: 1_000_000_000, overseas: 5_000_000 },
    },
    bars: liquidBars(25, 2_000_000),
    historicalSignals: [],
    now: '2026-06-12T00:00:00Z',
  };
  const rrPass = await evaluateEntryPreflight(entrySignal({ rr: 4 }), baseOptions, {
    fetchPhaseABars: async () => ({ bars: baseOptions.bars }),
  });
  assert.equal(gateByName(rrPass, 'G-rr').status, 'pass');
  assert.equal(gateByName(rrPass, 'G-E').reason, 'skip_insufficient_sample');
  assert.equal(rrPass.decision, 'pass_with_skips');

  const rrBlock = await evaluateEntryPreflight(entrySignal({ rr: 1.5 }), baseOptions, {
    fetchPhaseABars: async () => ({ bars: baseOptions.bars }),
  });
  assert.equal(gateByName(rrBlock, 'G-rr').status, 'block');
  assert.equal(rrBlock.decision, 'block');

  const sidewaysBlock = await evaluateEntryPreflight(entrySignal({
    regime: { dominant: 'sideways', probabilities: { bull: 0.1, bear: 0.1, sideways: 0.6, volatile: 0.2 } },
  }), baseOptions, {
    fetchPhaseABars: async () => ({ bars: baseOptions.bars }),
  });
  assert.equal(gateByName(sidewaysBlock, 'G-sideways').status, 'block');

  const missingLiquidity = await evaluateEntryPreflight(entrySignal(), { ...baseOptions, bars: null }, {
    fetchPhaseABars: async () => ({ bars: [] }),
  });
  assert.equal(gateByName(missingLiquidity, 'G-liquidity').status, 'skip');

  const requestedKeys = [];
  await evaluateEntryPreflight(entrySignal(), {
    historicalSignals: [],
    bars: liquidBars(25, 2_000_000),
    now: '2026-06-12T00:00:00Z',
  }, {
    getParameter: async (key, scope) => {
      requestedKeys.push(`${scope}:${key}`);
      if (key === 'c4.min_liquidity') return { value: { crypto: 1_000_000 }, scope };
      if (key === 'c4.min_rr') return { value: 2, scope };
      if (key === 'c4.e_min_samples') return { value: 30, scope };
      if (key === 'c4.sideways_block_threshold') return { value: 0.5, scope };
      return null;
    },
    fetchPhaseABars: async () => ({ bars: liquidBars(25, 2_000_000) }),
  });
  assert.ok(requestedKeys.includes('global:c4.min_rr'));
  assert.ok(requestedKeys.includes('market:c4.min_liquidity'));

  return {
    rrPass: gateByName(rrPass, 'G-rr').status,
    rrBlock: rrBlock.decision,
    eSkip: gateByName(rrPass, 'G-E').reason,
    sidewaysBlock: gateByName(sidewaysBlock, 'G-sideways').reason,
    liquiditySkip: gateByName(missingLiquidity, 'G-liquidity').reason,
    c17Keys: requestedKeys.length,
  };
}

async function circuitScenarios() {
  const now = Date.parse('2026-06-11T12:00:00Z');
  const params = {
    'c4.circuit_lookback_min': 1440,
    'c4.circuit_trade_limit': 4,
    'c4.circuit_stop_duration_min': 1440,
    'c4.symbol_cooldown_candles': 2,
    'c4.low_profit_lookback_days': 14,
  };
  const fourStops = await evaluateLossCircuits({
    now,
    parameters: params,
    trades: Array.from({ length: 4 }, (_, idx) => trade({ id: `stop-${idx}`, exitTime: now - idx * 60_000 })),
  });
  assert.ok(fourStops.locks.some((item) => item.circuit === 'stoploss_guard' && item.level === 'market'));
  assert.ok(fourStops.locks.some((item) => item.circuit === 'stoploss_guard' && item.level === 'symbol'));
  assert.ok(fourStops.locks.some((item) => item.circuit === 'stoploss_guard' && item.level === 'side' && item.side === 'long'));

  const threeStops = await evaluateLossCircuits({
    now,
    parameters: params,
    trades: Array.from({ length: 3 }, (_, idx) => trade({ id: `stop3-${idx}`, symbol: 'ETH/USDT', exitTime: now - idx * 60_000 })),
  });
  assert.equal(threeStops.locks.some((item) => item.circuit === 'stoploss_guard'), false);

  const cooldown = await evaluateLossCircuits({
    now,
    parameters: params,
    trades: [trade({ symbol: 'SOL/USDT', exitReason: 'normal_exit', exitTime: now - 24 * 60 * 60 * 1000, pnlAmount: 10, pnlNet: 10, pnlPercent: 1 })],
  });
  assert.ok(cooldown.locks.some((item) => item.circuit === 'symbol_cooldown' && item.symbol === 'SOL/USDT'));

  const lowProfit = await evaluateLossCircuits({
    now,
    parameters: params,
    trades: [
      trade({ symbol: 'XRP/USDT', exitReason: 'normal_exit', entryPrice: 100, exitPrice: 97, stopPrice: 95, pnlPercent: -3, exitTime: now - 3 * 24 * 60 * 60 * 1000 }),
    ],
  });
  assert.ok(lowProfit.locks.some((item) => item.circuit === 'low_profit_symbol' && item.symbol === 'XRP/USDT'));

  const sideSplit = await evaluateLossCircuits({
    now,
    parameters: params,
    trades: [
      ...Array.from({ length: 4 }, (_, idx) => trade({ id: `long-${idx}`, symbol: 'ADA/USDT', direction: 'long', exitTime: now - idx * 60_000 })),
      ...Array.from({ length: 3 }, (_, idx) => trade({ id: `short-${idx}`, symbol: 'ADA/USDT', direction: 'short', exitTime: now - (idx + 10) * 60_000 })),
    ],
  });
  assert.ok(sideSplit.locks.some((item) => item.circuit === 'stoploss_guard' && item.level === 'side' && item.side === 'long'));
  assert.equal(sideSplit.locks.some((item) => item.circuit === 'stoploss_guard' && item.level === 'side' && item.side === 'short'), false);

  const requestedKeys = [];
  await evaluateLossCircuits({
    now,
    trades: [],
  }, {
    getParameter: async (key, scope) => {
      requestedKeys.push(`${scope}:${key}`);
      return { value: params[key] ?? 1, scope };
    },
  });
  assert.ok(requestedKeys.includes('global:c4.circuit_trade_limit'));

  let capturedSql = '';
  await evaluateLossCircuits({
    now,
    parameters: params,
  }, {
    queryFn: async (sql) => {
      capturedSql = String(sql);
      return [];
    },
  });
  assert.match(capturedSql, /exclude_from_learning/);
  assert.match(capturedSql, /quality_flag/);

  return {
    stoplossGuardLocks: fourStops.locks.filter((item) => item.circuit === 'stoploss_guard').length,
    threeStopsLocked: threeStops.locks.some((item) => item.circuit === 'stoploss_guard'),
    cooldown: cooldown.locks.some((item) => item.circuit === 'symbol_cooldown'),
    lowProfit: lowProfit.locks.some((item) => item.circuit === 'low_profit_symbol'),
    sideLongOnly: true,
    c17Keys: requestedKeys.length,
    excludedRowsFiltered: true,
  };
}

async function dbRollbackScenario(preflightResult: any, lock: any) {
  const stamp = new Date(Date.now() + 240_000).toISOString();
  const txResult = await withRollback(async (tx: any) => {
    const preflightRows = await insertEntryPreflightLogs([{ ...preflightResult, evaluatedAt: stamp }], tx.run);
    const lockRows = await insertCircuitLocks([{ ...lock, evaluatedAt: stamp }], tx.run);
    const duplicateRows = await insertCircuitLocks([{ ...lock, evaluatedAt: stamp }], tx.run, {
      skipActiveDuplicates: true,
      queryFn: tx.query,
      now: stamp,
    });
    const newSymbolRows = await insertCircuitLocks([{
      ...lock,
      symbol: `${lock.symbol || 'BTC/USDT'}-SMOKE`,
      evaluatedAt: stamp,
    }], tx.run, {
      skipActiveDuplicates: true,
      queryFn: tx.query,
      now: stamp,
    });
    const preflightCount = await tx.query(
      `SELECT COUNT(*)::int AS count FROM luna_entry_preflight_log WHERE evaluated_at = $1`,
      [stamp],
    );
    const circuitCount = await tx.query(
      `SELECT COUNT(*)::int AS count FROM luna_circuit_locks WHERE evaluated_at = $1`,
      [stamp],
    );
    assert.equal(Number(preflightCount?.[0]?.count || 0), 1);
    assert.equal(Number(circuitCount?.[0]?.count || 0), 2);
    assert.equal(lockRows.filter(Boolean).length, 1);
    assert.equal(duplicateRows.filter(Boolean).length, 0);
    assert.equal(duplicateRows.skippedDuplicates, 1);
    assert.equal(newSymbolRows.filter(Boolean).length, 1);
    return { preflightRows, lockRows, duplicateRows, newSymbolRows };
  });
  assert.equal(txResult.preflightRows.length, 1);
  assert.equal(txResult.lockRows.length, 1);
  assert.equal(txResult.duplicateRows.skippedDuplicates, 1);
  assert.equal(txResult.newSymbolRows.filter(Boolean).length, 1);
  const afterPreflight = await db.query(
    `SELECT COUNT(*)::int AS count FROM luna_entry_preflight_log WHERE evaluated_at = $1`,
    [stamp],
  ).catch(() => [{ count: 0 }]);
  const afterCircuit = await db.query(
    `SELECT COUNT(*)::int AS count FROM luna_circuit_locks WHERE evaluated_at = $1`,
    [stamp],
  ).catch(() => [{ count: 0 }]);
  assert.equal(Number(afterPreflight?.[0]?.count || 0), 0);
  assert.equal(Number(afterCircuit?.[0]?.count || 0), 0);
  return true;
}

async function runnerIndependenceScenario() {
  const result = await runLunaMarketGate({ dryRun: true, writeOutput: false }, {
    computeAllMarketDeploymentGates: async () => [{ market: 'crypto', score: 70, deployment: 'reduced' }],
    computeAllRegimeStates: async () => [],
    computeStrategyFamilySignals: async () => ({ signals: [entrySignal()], errors: [] }),
    evaluateEntryPreflightsForSignals: async () => {
      throw new Error('fixture_preflight_down');
    },
    evaluateLossCircuits: async () => ({ locks: [] }),
  });
  assert.equal(result.preflightError, 'fixture_preflight_down');
  assert.equal(result.gates.length, 1);
  assert.equal(result.strategySignals.length, 1);
  return result.preflightError;
}

async function main() {
  const strategy = await strategyIncompleteBarScenarios();
  const preflight = await preflightScenarios();
  const circuit = await circuitScenarios();
  const preflightForDb = await evaluateEntryPreflight(entrySignal(), {
    parameters: {
      'c4.min_rr': 2,
      'c4.e_min_samples': 30,
      'c4.sideways_block_threshold': 0.5,
      'c4.min_liquidity': { crypto: 1_000_000 },
    },
    bars: liquidBars(25, 2_000_000),
    historicalSignals: [],
  });
  const circuitForDb = (await evaluateLossCircuits({
    now: Date.parse('2026-06-11T12:00:00Z'),
    parameters: {
      'c4.circuit_lookback_min': 1440,
      'c4.circuit_trade_limit': 4,
      'c4.circuit_stop_duration_min': 1440,
      'c4.symbol_cooldown_candles': 2,
      'c4.low_profit_lookback_days': 14,
    },
    trades: Array.from({ length: 4 }, (_, idx) => trade({ id: `db-${idx}`, exitTime: Date.parse('2026-06-11T12:00:00Z') - idx * 60_000 })),
  })).locks[0];
  const dbRollback = await dbRollbackScenario(preflightForDb, circuitForDb);
  const runnerIndependentFailure = await runnerIndependenceScenario();
  const seedDryRun = await seedLunaComponentRegistry({ dryRun: true });
  assert.equal(LUNA_COMPONENT_REGISTRY_SEED.length, 31);
  assert.equal(seedDryRun.seeded, 31);
  assert.equal(seedDryRun.components.includes('entry-preflight-gate'), true);
  assert.equal(seedDryRun.components.includes('loss-circuit'), true);

  return {
    ok: true,
    smoke: 'luna-preflight-circuit',
    scenarios: {
      strategy,
      preflight,
      circuit,
      dbRollback,
      runnerIndependentFailure,
      registrySeedCount: seedDryRun.seeded,
      circuitDuplicateSuppression: true,
      weakSignalGateLocation: 'bots/investment/team/luna.ts: binance 0.22/0.03, non-binance 0.32/0.08',
      tradeHistorySource: 'investment.trade_journal',
    },
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: '❌ luna-preflight-circuit-smoke 실패:',
  });
}

export { main as runLunaPreflightCircuitSmoke };
