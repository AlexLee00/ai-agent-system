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
  hardExit: hardPreflight.code,
}, null, 2));
