#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildCandidates,
  buildExecutionInvocation,
  classifyChildExecutionOutput,
} from './runtime-position-runtime-dispatch.ts';
import { buildPyramidSafetyReport } from './pyramid-adjust-runner.ts';

const runtimeRows = [
  {
    exchange: 'binance',
    symbol: 'TRAIL/USDT',
    tradeMode: 'normal',
    runtimeState: {
      reasonCode: 'dynamic_trail_stop_breached',
      executionIntent: {
        action: 'EXIT',
        runner: 'runtime:strategy-exit',
        urgency: 'high',
        executionAllowed: true,
        runnerArgs: {
          symbol: 'TRAIL/USDT',
          exchange: 'binance',
          'trade-mode': 'normal',
          execute: true,
          confirm: 'position-runtime-autopilot',
          'run-context': 'position-runtime-autopilot',
          json: true,
        },
      },
    },
  },
  {
    exchange: 'binance',
    symbol: 'PYRAMID/USDT',
    tradeMode: 'normal',
    runtimeState: {
      reasonCode: 'pyramid_continuation',
      policyMatrix: {
        positionSizing: {
          enabled: true,
          mode: 'pyramid',
          adjustmentRatio: 0.12,
          reasonCode: 'pyramid_continuation',
        },
      },
      executionIntent: {
        action: 'ADJUST',
        runner: 'runtime:pyramid-adjust',
        urgency: 'normal',
        executionAllowed: true,
        runnerArgs: {
          symbol: 'PYRAMID/USDT',
          exchange: 'binance',
          'trade-mode': 'normal',
          execute: true,
          confirm: 'position-runtime-autopilot',
          'run-context': 'position-runtime-autopilot',
          json: true,
        },
      },
    },
  },
];

const candidates = buildCandidates(runtimeRows);
assert.equal(candidates.length, 2);

const trail = candidates.find((item) => item.symbol === 'TRAIL/USDT');
const trailInvocation = buildExecutionInvocation(trail, { phase6: true });
assert.equal(trail.runner, 'runtime:strategy-exit');
assert.equal(trailInvocation.kind, 'runner');
assert.match(trailInvocation.command, /position-runtime-autopilot/);
assert.match(trailInvocation.command, /runtime:strategy-exit/);

const pyramid = candidates.find((item) => item.symbol === 'PYRAMID/USDT');
const pyramidInvocation = buildExecutionInvocation(pyramid, { phase6: true });
assert.equal(pyramid.runner, 'runtime:pyramid-adjust');
assert.match(pyramidInvocation.command, /runtime:pyramid-adjust/);
assert.match(pyramidInvocation.command, /position-runtime-autopilot/);

const safety = buildPyramidSafetyReport({
  candidate: {
    symbol: 'PYRAMID/USDT',
    exchange: 'binance',
    tradeMode: 'normal',
    adjustmentRatio: 0.12,
    amountUsdt: 25,
    executionIntent: { executionAllowed: true },
  },
  flags: { phaseE: { enabled: true, maxPyramidRatio: 0.25 } },
  priorPyramidCount: 2,
  maxPyramidCount: 3,
});
assert.equal(safety.ok, true);

const capped = buildPyramidSafetyReport({
  candidate: {
    symbol: 'PYRAMID/USDT',
    exchange: 'binance',
    tradeMode: 'normal',
    adjustmentRatio: 0.4,
    amountUsdt: 25,
    executionIntent: { executionAllowed: true },
  },
  flags: { phaseE: { enabled: true, maxPyramidRatio: 0.25 } },
  priorPyramidCount: 3,
  maxPyramidCount: 3,
});
assert.equal(capped.ok, false);
assert.equal(capped.blockers.includes('pyramid_adjustment_ratio_above_cap'), true);
assert.equal(capped.blockers.includes('max_pyramid_count_reached'), true);

const child = classifyChildExecutionOutput(JSON.stringify({
  mode: 'execute',
  ok: true,
  signalId: 'sig-hard-drill',
  result: { success: true },
}), { phase6: true });
assert.equal(child.ok, true);

console.log(JSON.stringify({ ok: true, candidates: candidates.map((item) => item.runner) }, null, 2));
