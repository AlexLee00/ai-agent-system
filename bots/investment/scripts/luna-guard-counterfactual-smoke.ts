#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  computeTripleBarrierOutcome,
  runGuardCounterfactual,
} from './runtime-luna-guard-counterfactual.ts';

const base = Date.parse('2026-06-01T00:00:00.000Z');

function candles(closes = []) {
  return closes.map((close, index) => {
    const ts = base + index * 3_600_000;
    return [ts, close, close + 1, close - 1, close, 1000 + index];
  });
}

const tpFirst = computeTripleBarrierOutcome({
  candles: [
    [base, 100, 101, 99, 100, 1],
    [base + 3_600_000, 100, 104, 99, 103, 1],
  ],
  blockedAt: new Date(base),
  entryPrice: 100,
  takeProfit: 103,
  stopLoss: 98,
  timeBarrierBars: 3,
  timeframe: '1h',
});
assert.equal(tpFirst.virtualLabel, 1);
assert.equal(tpFirst.exitReason, 'take_profit');

const slPriority = computeTripleBarrierOutcome({
  candles: [
    [base, 100, 101, 99, 100, 1],
    [base + 3_600_000, 100, 104, 97, 100, 1],
  ],
  blockedAt: new Date(base),
  entryPrice: 100,
  takeProfit: 103,
  stopLoss: 98,
  timeBarrierBars: 3,
  timeframe: '1h',
});
assert.equal(slPriority.virtualLabel, -1);
assert.equal(slPriority.exitReason, 'stop_loss');

const timeBarrier = computeTripleBarrierOutcome({
  candles: candles([100, 100.5, 100.2]),
  blockedAt: new Date(base),
  entryPrice: 100,
  takeProfit: 110,
  stopLoss: 90,
  timeBarrierBars: 3,
  timeframe: '1h',
});
assert.equal(timeBarrier.virtualLabel, 0);
assert.equal(timeBarrier.exitReason, 'time_barrier');

const disabled = await runGuardCounterfactual({ enabled: false, dryRun: true });
assert.equal(disabled.skipped, true);
assert.equal(disabled.reason, 'LUNA_GUARD_COUNTERFACTUAL_ENABLED=false');

const dry = await runGuardCounterfactual({
  enabled: true,
  dryRun: true,
  triggers: [{
    id: 'smoke-trigger-1',
    symbol: 'SMOKE/USDT',
    exchange: 'binance',
    reason: 'active_entry_trigger_quality_terminal_blocked',
    blocked_at: new Date(base).toISOString(),
    created_at: new Date(base).toISOString(),
    target_price: 100,
    take_profit: 103,
    stop_loss: 98,
  }],
  candles: [
    [base, 100, 101, 99, 100, 1],
    [base + 3_600_000, 100, 104, 99, 103, 1],
  ],
  timeBarrierBars: 3,
  timeframe: '1h',
  enteredComparison: { total: 1, wins: 1, posRate: 1, basis: 'smoke' },
  allTradeComparison: { total: 1, wins: 1, posRate: 1, basis: 'smoke' },
});
assert.equal(dry.ok, true);
assert.equal(dry.dryRun, true);
assert.equal(dry.processed, 1);
assert.equal(dry.computed, 1);
assert.equal(dry.summary.pos, 1);
assert.equal(dry.enteredComparison.basis, 'smoke');

console.log('luna-guard-counterfactual-smoke ok');
