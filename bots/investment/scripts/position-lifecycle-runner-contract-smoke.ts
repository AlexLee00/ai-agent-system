#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildCandidates,
  buildExecutionInvocation,
  classifyChildExecutionOutput,
} from './runtime-position-runtime-dispatch.ts';
import { buildRunnerContractSummary } from '../shared/luna-l5-operational-gate.ts';

function rowFor(runner, action = 'ADJUST') {
  return {
    exchange: 'binance',
    symbol: runner === 'runtime:strategy-exit' ? 'ETH/USDT' : 'BTC/USDT',
    tradeMode: 'normal',
    runtimeState: {
      executionIntent: {
        action,
        runner,
        executionAllowed: true,
        runnerArgs: {
          symbol: runner === 'runtime:strategy-exit' ? 'ETH/USDT' : 'BTC/USDT',
          exchange: 'binance',
          'trade-mode': 'normal',
          execute: true,
          confirm: 'position-runtime-autopilot',
          json: true,
        },
      },
    },
  };
}

const candidates = buildCandidates([
  rowFor('runtime:partial-adjust'),
  rowFor('runtime:pyramid-adjust'),
  rowFor('runtime:strategy-exit', 'EXIT'),
]);
assert.equal(candidates.length, 3);

const contract = buildRunnerContractSummary({ candidates });
assert.equal(contract.ok, true);

for (const candidate of candidates) {
  const invocation = buildExecutionInvocation(candidate, { phase6: true });
  assert.equal(invocation.kind, 'runner');
  assert.equal(invocation.executable, 'npm');
  assert.ok(invocation.args.includes(candidate.runner));
}

const classification = classifyChildExecutionOutput(JSON.stringify({
  ok: true,
  mode: 'execute',
  status: 'executed',
  result: { id: 'smoke' },
}), { phase6: true });
assert.equal(classification.ok, true);

console.log(JSON.stringify({ ok: true, runners: contract.byRunner }, null, 2));
