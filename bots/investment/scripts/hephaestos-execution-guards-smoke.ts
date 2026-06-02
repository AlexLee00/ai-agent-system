#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { ACTIONS } from '../shared/signal.ts';
import {
  buildGuardTelemetryMeta,
  runBuySafetyGuards,
} from '../team/hephaestos/execution-guards.ts';

process.env.LUNA_GUARD_EVENT_RECORDING_DISABLED = 'true';

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
      binanceTopVolumeUniverse: {
        source: 'smoke_binance_top30_universe',
        fetchedAt: new Date().toISOString(),
        limit: 30,
        symbols: ['ORCA/USDT', 'RLUSD/USDT'],
        ranks: { 'ORCA/USDT': 1, 'RLUSD/USDT': 2 },
      },
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

const tradeDataBlocked = createDeps({
  symbol: 'RLUSD/USDT',
  signal: {
    symbol: 'RLUSD/USDT',
    action: ACTIONS.BUY,
    exchange: 'binance',
    market: 'crypto',
  },
});
const tradeDataResult = await runBuySafetyGuards(tradeDataBlocked.input);
assert.equal(tradeDataResult.success, false);
assert.equal(tradeDataBlocked.captured[0].payload.code, 'trade_data_entry_guard_rejected');
assert.equal(tradeDataBlocked.captured[0].payload.meta.guardKind, 'trade_data_entry_guard');
assert.deepEqual(tradeDataBlocked.captured[0].payload.meta.tradeDataGuard.blockers, ['trade_data_weak_symbol']);

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

// [GUARD_NOTIFY_REOPEN] crypto defensive_rotation without evidence → notify 모드 통과 (reject 아님)
const defRotNotify = createDeps({
  symbol: 'ORCA/USDT',
  signal: {
    symbol: 'ORCA/USDT',
    action: ACTIONS.BUY,
    exchange: 'binance',
    market: 'crypto',
    strategy_family: 'defensive_rotation',
    externalEvidence: { evidenceCount: 0 },
    hasTechnicalPresignal: false,
  },
});
const defRotResult = await runBuySafetyGuards(defRotNotify.input);
// notify 모드: success:true + tradeDataGuardNotify 있어야 함 (success:false 아님)
assert.ok(defRotResult?.success !== false, 'defensive_rotation without evidence: notify 모드여야 함 (success !== false)');
assert.ok(defRotResult?.tradeDataGuardNotify != null, 'defensive_rotation notify: tradeDataGuardNotify 있어야 함');
assert.equal(defRotNotify.captured.length, 0, 'defensive_rotation notify: persistFailure 호출 없어야 함');

// [GUARD_NOTIFY_REOPEN] crypto trend_following without confirmation → notify 모드 통과
const trendFollowNotify = createDeps({
  symbol: 'ORCA/USDT',
  signal: {
    symbol: 'ORCA/USDT',
    action: ACTIONS.BUY,
    exchange: 'binance',
    market: 'crypto',
    strategy_family: 'trend_following',
    strategy_route: { selectedFamily: 'trend_following', familyPerformance: { selectedBias: 0.0 } },
    externalEvidence: { evidenceCount: 0 },
    hasTechnicalPresignal: false,
  },
});
const trendFollowResult = await runBuySafetyGuards(trendFollowNotify.input);
assert.ok(trendFollowResult?.success !== false, 'trend_following without confirmation: notify 모드여야 함 (success !== false)');
assert.ok(trendFollowResult?.tradeDataGuardNotify != null, 'trend_following notify: tradeDataGuardNotify 있어야 함');
assert.equal(trendFollowNotify.captured.length, 0, 'trend_following notify: persistFailure 호출 없어야 함');

// [GUARD_NOTIFY_REOPEN] stablecoin → hard_block 유지
const stablecoinBlocked = createDeps({
  symbol: 'USDC/USDT',
  signal: {
    symbol: 'USDC/USDT',
    action: ACTIONS.BUY,
    exchange: 'binance',
    market: 'crypto',
  },
  binanceTopVolumeUniverse: {
    source: 'smoke',
    fetchedAt: new Date().toISOString(),
    limit: 30,
    symbols: ['USDC/USDT'],
    ranks: { 'USDC/USDT': 1 },
  },
});
const stablecoinResult = await runBuySafetyGuards(stablecoinBlocked.input);
assert.equal(stablecoinResult?.success, false, 'stablecoin: hard_block이어야 함');
assert.equal(stablecoinBlocked.captured[0]?.payload?.code, 'trade_data_entry_guard_rejected', 'stablecoin: trade_data_entry_guard_rejected 코드여야 함');

const payload = {
  ok: true,
  smoke: 'hephaestos-execution-guards',
  circuit: circuit.captured[0],
  tradeDataBlocked: tradeDataBlocked.captured[0],
  maxPositions: maxPositions.captured[0],
  dailyLimit: dailyLimit.captured[0],
  defRotNotify: { result: defRotResult, captured: defRotNotify.captured.length },
  trendFollowNotify: { result: trendFollowResult, captured: trendFollowNotify.captured.length },
  stablecoinBlocked: stablecoinBlocked.captured[0],
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('hephaestos-execution-guards-smoke ok');
}
