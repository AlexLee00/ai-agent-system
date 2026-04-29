#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  applyRunnerPreflightChecks,
  isPolicyDeferredRunnerPreflight,
} from './runtime-position-execute-preflight-drill.ts';

const baseDrill = {
  ok: true,
  status: 'execute_preflight_drill_clear',
  blockers: [],
  warnings: [],
};

const policyDeferred = {
  runner: 'runtime:strategy-exit',
  exchange: 'binance',
  symbol: 'API3/USDT',
  tradeMode: 'normal',
  ok: false,
  code: 'strategy_exit_guard_blocked',
  lines: ['- strategy exit guard: 전략 최소 보유시간 2.0h 미만 (0.0h)'],
  candidate: {
    executionGuard: {
      allowed: false,
      level: 'guarded',
      reason: '전략 최소 보유시간 2.0h 미만 (0.0h)',
    },
  },
};

const hardBlocked = {
  runner: 'runtime:partial-adjust',
  exchange: 'binance',
  symbol: 'API3/USDT',
  tradeMode: 'normal',
  ok: false,
  code: 'partial_adjust_balance_locked_by_open_sell_orders',
  lines: ['- partial-adjust blocked by open sell orders'],
  candidate: {},
};

const noCandidate = {
  runner: 'runtime:partial-adjust',
  exchange: 'binance',
  symbol: 'MOVR/USDT',
  tradeMode: 'normal',
  ok: false,
  code: 'partial_adjust_candidate_not_found',
  lines: ['- partial-adjust candidate not found'],
  candidate: null,
};

const deferredResult = applyRunnerPreflightChecks(baseDrill, [policyDeferred]);
assert.equal(isPolicyDeferredRunnerPreflight(policyDeferred), true);
assert.equal(deferredResult.ok, true);
assert.equal(deferredResult.status, 'execute_preflight_drill_clear');
assert.deepEqual(deferredResult.blockers, []);
assert.deepEqual(deferredResult.warnings, [
  'runner_preflight_deferred:runtime:strategy-exit:binance:API3/USDT:strategy_exit_guard_blocked',
]);
assert.equal(deferredResult.policyDeferredRunnerPreflightChecks.length, 1);

const noCandidateResult = applyRunnerPreflightChecks(baseDrill, [noCandidate]);
assert.equal(isPolicyDeferredRunnerPreflight(noCandidate), true);
assert.equal(noCandidateResult.ok, true);
assert.deepEqual(noCandidateResult.blockers, []);
assert.deepEqual(noCandidateResult.warnings, [
  'runner_preflight_deferred:runtime:partial-adjust:binance:MOVR/USDT:partial_adjust_candidate_not_found',
]);

const hardResult = applyRunnerPreflightChecks(baseDrill, [policyDeferred, hardBlocked]);
assert.equal(hardResult.ok, false);
assert.equal(hardResult.status, 'execute_preflight_drill_blocked');
assert.deepEqual(hardResult.blockers, [
  'runner_preflight_blocked:runtime:partial-adjust:binance:API3/USDT:partial_adjust_balance_locked_by_open_sell_orders',
]);
assert.deepEqual(hardResult.warnings, [
  'runner_preflight_deferred:runtime:strategy-exit:binance:API3/USDT:strategy_exit_guard_blocked',
]);

console.log(JSON.stringify({ ok: true, status: 'policy_deferred_preflight_smoke_clear' }, null, 2));
