#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { ACTIONS } from '../shared/signal.ts';
import {
  buildGuardTelemetryMeta,
  runBuySafetyGuards,
} from '../team/hephaestos/execution-guards.ts';

function createDeps(overrides = {}) {
  const captured = [];
  return {
    captured,
    input: {
      persistFailure: async (reason, payload) => {
        captured.push({ reason, payload });
      },
      symbol: 'ORCA/USDT',
      action: ACTIONS.BUY,
      signalTradeMode: 'validation',
      capitalPolicy: {
        max_concurrent_positions: 2,
        max_daily_trades: 3,
      },
      signalConfidence: 0.91,
      checkCircuitBreaker: async () => ({ triggered: false }),
      getOpenPositions: async () => [],
      getMaxPositionsOverflowPolicy: () => ({ enabled: false }),
      getDailyTradeCount: async () => 0,
      formatDailyTradeLimitReason: (current, limit) => `daily ${current}/${limit}`,
      notifyEnabled: false,
      ...overrides,
    },
  };
}

const telemetry = buildGuardTelemetryMeta('ORCA/USDT', ACTIONS.BUY, 'validation', {
  openPositions: 3,
}, {
  guardKind: 'max_positions',
  pressureSource: 'capital_policy',
});
assert.equal(telemetry.symbol, 'ORCA/USDT');
assert.equal(telemetry.side, 'buy');
assert.equal(telemetry.guardKind, 'max_positions');
assert.equal(telemetry.pressureSource, 'capital_policy');

const circuit = createDeps({
  checkCircuitBreaker: async () => ({ triggered: true, reason: 'loss limit', type: 'daily_loss' }),
});
const circuitResult = await runBuySafetyGuards(circuit.input);
assert.equal(circuitResult.success, false);
assert.equal(circuit.captured[0].payload.code, 'capital_circuit_breaker');
assert.equal(circuit.captured[0].payload.meta.circuitType, 'daily_loss');

const maxPositions = createDeps({
  getOpenPositions: async () => [{}, {}],
});
const maxResult = await runBuySafetyGuards(maxPositions.input);
assert.equal(maxResult.success, false);
assert.equal(maxPositions.captured[0].payload.code, 'capital_guard_rejected');
assert.equal(maxPositions.captured[0].payload.meta.guardKind, 'max_positions');

const overflowAllowed = createDeps({
  getOpenPositions: async () => [{}, {}],
  getMaxPositionsOverflowPolicy: () => ({ enabled: true, allowOverflowSlots: 1, minConfidence: 0.9 }),
});
assert.equal(await runBuySafetyGuards(overflowAllowed.input), null);

const dailyLimit = createDeps({
  getDailyTradeCount: async () => 3,
});
const dailyResult = await runBuySafetyGuards(dailyLimit.input);
assert.equal(dailyResult.success, false);
assert.equal(dailyLimit.captured[0].payload.meta.guardKind, 'daily_trade_limit');

const payload = {
  ok: true,
  smoke: 'hephaestos-execution-guards',
  circuit: circuit.captured[0],
  maxPositions: maxPositions.captured[0],
  dailyLimit: dailyLimit.captured[0],
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('hephaestos-execution-guards-smoke ok');
}
