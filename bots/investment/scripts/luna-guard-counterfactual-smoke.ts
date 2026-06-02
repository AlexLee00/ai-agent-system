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
  guardEvents: [],
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

// signals 소스 경로: trade_data guard 차단 신호 dry-run
const signalDry = await runGuardCounterfactual({
  enabled: true,
  dryRun: true,
  source: 'trade_data',
  triggers: [{
    id: 'signal:smoke-signal-1:crypto_defensive_rotation_without_live_evidence',
    source_id: 'smoke-signal-1',
    symbol: 'SMOKE/USDT',
    exchange: 'binance',
    reason: 'crypto_defensive_rotation_without_live_evidence',
    blocked_at: new Date(base).toISOString(),
    created_at: new Date(base).toISOString(),
    target_price: null,
    take_profit: null,
    stop_loss: null,
    strategy_family: 'defensive_rotation',
    block_code: 'trade_data_entry_guard_rejected',
    block_reason: 'trade-data entry guard blocked: crypto_defensive_rotation_without_live_evidence',
    trade_data_guard: {
      blockers: ['crypto_defensive_rotation_without_live_evidence'],
      meta: { strategyFamily: 'defensive_rotation' },
    },
    _source: 'signals',
  }],
  guardEvents: [],
  candles: [
    [base, 100, 101, 99, 100, 1],
    [base + 3_600_000, 100, 97.5, 97, 97.5, 1],
  ],
  timeBarrierBars: 3,
  timeframe: '1h',
  enteredComparison: { total: 1, wins: 0, posRate: 0, basis: 'smoke' },
  allTradeComparison: { total: 1, wins: 0, posRate: 0, basis: 'smoke' },
});
assert.equal(signalDry.ok, true);
assert.equal(signalDry.dryRun, true);
assert.equal(signalDry.processed, 1);
assert.equal(signalDry.computed, 1);
assert.equal(signalDry.summary.neg, 1, 'signals: SL 도달 → neg');
assert.equal(signalDry.summary.byStrategyFamily.defensive_rotation?.total, 1, 'signals: family별 집계');
assert.equal(signalDry.summary.bySource.signals?.total, 1, 'signals: source별 집계');
assert.equal(signalDry.samples[0].source, 'signals', 'signals: sample source');

// guard_events 소스 경로: trade_data guard 차단 신호 dry-run
const guardEventDry = await runGuardCounterfactual({
  enabled: true,
  dryRun: true,
  triggers: [],
  guardEvents: [{
    id: 'guard_event:999',
    symbol: 'SMOKE/USDT',
    exchange: 'binance',
    reason: 'crypto_defensive_rotation_without_live_evidence',
    blocked_at: new Date(base).toISOString(),
    created_at: new Date(base).toISOString(),
    target_price: null,
    take_profit: null,
    stop_loss: null,
    _source: 'guard_events',
  }],
  candles: [
    [base, 100, 101, 99, 100, 1],
    [base + 3_600_000, 100, 97.5, 97, 97.5, 1],
  ],
  timeBarrierBars: 3,
  timeframe: '1h',
  enteredComparison: { total: 1, wins: 0, posRate: 0, basis: 'smoke' },
  allTradeComparison: { total: 1, wins: 0, posRate: 0, basis: 'smoke' },
});
assert.equal(guardEventDry.ok, true);
assert.equal(guardEventDry.dryRun, true);
assert.equal(guardEventDry.processed, 1);
assert.equal(guardEventDry.computed, 1);
assert.equal(guardEventDry.summary.neg, 1, 'guard_event: SL 도달 → neg');
assert.equal(
  guardEventDry.summary.byReason['crypto_defensive_rotation_without_live_evidence']?.total,
  1,
  'guard_event: reason별 집계',
);
assert.ok(
  Array.isArray(guardEventDry.tradeDataReasons) && guardEventDry.tradeDataReasons.length > 0,
  'tradeDataReasons 필드 존재',
);

console.log('luna-guard-counterfactual-smoke ok');
