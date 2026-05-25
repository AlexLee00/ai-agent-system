#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { applyExitPlanGuard, getExecutionPreflight } from './strategy-exit-runner.ts';

const guardedCandidate = {
  exchange: 'binance',
  symbol: 'API3/USDT',
  tradeMode: 'normal',
  heldHours: 0,
  pnlPct: -1.2,
  reasonCode: 'dynamic_trail_stop_breached',
  strategyProfile: {
    exitPlan: {
      minHoldHours: 2,
    },
  },
};

const guarded = applyExitPlanGuard(guardedCandidate);
assert.equal(guarded.allowed, false);
assert.match(guarded.reason, /최소 보유시간/);

const guardedPreflight = await getExecutionPreflight({
  ...guardedCandidate,
  executionGuard: guarded,
});
assert.equal(guardedPreflight.ok, false);
assert.equal(guardedPreflight.code, 'strategy_exit_guard_blocked');

const hardExit = applyExitPlanGuard({
  ...guardedCandidate,
  reasonCode: 'stop_loss_threshold',
});
assert.equal(hardExit.allowed, true);

const earlyLossExit = applyExitPlanGuard({
  ...guardedCandidate,
  heldHours: 0.5,
  pnlPct: -0.9,
  reasonCode: 'dynamic_trail_stop_breached',
  strategyProfile: {
    exitPlan: {
      minHoldHours: 0,
      mildLossGracePct: -0.5,
    },
  },
});
assert.equal(earlyLossExit.allowed, false);
assert.match(earlyLossExit.reason, /조기 손실 종료 재확인/);

const recoveryRuntimeState = {
  marketState: {
    liveIndicator: {
      compositeSignal: 'BUY',
      weightedBias: 0.22,
      timeframes: [
        { interval: '1h', signal: 'BUY', rsi: 54, macdHist: 0.03 },
        { interval: '4h', signal: 'HOLD', rsi: 51, macdHist: 0.01 },
      ],
    },
    analysisCounts: {
      buy: 2,
      hold: 1,
      sell: 0,
      avgConfidence: 0.62,
    },
  },
};

const recoveryGuardedExit = applyExitPlanGuard({
  ...guardedCandidate,
  heldHours: 2.2,
  pnlPct: -0.7,
  reasonCode: 'bearish_loss_consensus',
  executionIntent: {
    weightedBias: 0.22,
  },
  strategyProfile: {
    exitPlan: {
      minHoldHours: 0,
      mildLossGracePct: -0.5,
    },
    positionRuntimeState: recoveryRuntimeState,
  },
});
assert.equal(recoveryGuardedExit.allowed, false);
assert.match(recoveryGuardedExit.reason, /회복 신호 재확인/);
assert.equal(recoveryGuardedExit.recoveryState.active, true);

const hardStopWithRecovery = applyExitPlanGuard({
  ...guardedCandidate,
  heldHours: 2.2,
  pnlPct: -5.2,
  reasonCode: 'stop_loss_threshold',
  executionIntent: {
    weightedBias: 0.22,
  },
  strategyProfile: {
    exitPlan: {
      minHoldHours: 0,
    },
    positionRuntimeState: recoveryRuntimeState,
  },
});
assert.equal(hardStopWithRecovery.allowed, true);

const hardPreflight = await getExecutionPreflight({
  ...guardedCandidate,
  reasonCode: 'stop_loss_threshold',
  executionGuard: hardExit,
});
assert.equal(hardPreflight.ok, true);
assert.equal(hardPreflight.code, 'strategy_exit_runner_preflight_clear');

console.log(JSON.stringify({
  ok: true,
  smoke: 'strategy-exit-preflight-guard',
  guarded: guardedPreflight.code,
  earlyLossExit: earlyLossExit.level,
  recoveryGuardedExit: recoveryGuardedExit.level,
  hardExit: hardPreflight.code,
}, null, 2));
