#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import * as db from '../shared/db.ts';
import { ACTIONS } from '../shared/signal.ts';
import {
  buildRiskApprovalRationalePayload,
  executeApprovedDecision,
  persistRiskApprovalRationale,
} from '../shared/pipeline-approved-decision.ts';
import l30SignalSave from '../nodes/l30-signal-save.ts';
import { buildHephaestosExecutionContext } from '../team/hephaestos/execution-context.ts';
import {
  buildRiskApprovalRationalePayload as runnerPayloadBuilder,
} from '../shared/pipeline-decision-runner.ts';

function uniqueSymbol(prefix) {
  return `${prefix}${Date.now().toString(36).toUpperCase()}/USDT`;
}

const payload = buildRiskApprovalRationalePayload({
  signalId: 'sig-approved-1',
  signal: {
    action: ACTIONS.BUY,
    amountUsdt: 150,
    confidence: 0.73,
    reasoning: 'approved decision module smoke',
  },
  riskResult: {
    adjustedAmount: 125,
    nemesis_verdict: 'modified',
    risk_approval_preview: {
      decision: 'ADJUST',
      application: { reason: 'module smoke adjustment' },
    },
  },
});

const runnerPayload = runnerPayloadBuilder({
  signalId: 'sig-approved-1',
  signal: {
    action: ACTIONS.BUY,
    amountUsdt: 150,
    confidence: 0.73,
    reasoning: 'approved decision module smoke',
  },
  riskResult: {
    adjustedAmount: 125,
    nemesis_verdict: 'modified',
    risk_approval_preview: {
      decision: 'ADJUST',
      application: { reason: 'module smoke adjustment' },
    },
  },
});

assert.deepEqual(runnerPayload, payload);
assert.equal(payload.position_size_original, 150);
assert.equal(payload.position_size_approved, 125);
assert.equal(typeof executeApprovedDecision, 'function');
assert.equal(typeof persistRiskApprovalRationale, 'function');
assert.equal(buildRiskApprovalRationalePayload({
  signalId: 'sig-sell-1',
  signal: { action: ACTIONS.SELL },
  riskResult: { risk_approval_preview: { decision: 'PASS' } },
}), null);
assert.equal(buildHephaestosExecutionContext({
  symbol: 'EXIT/USDT',
  action: ACTIONS.SELL,
  amount_usdt: 0,
}).amountUsdt, 0);
assert.equal(buildHephaestosExecutionContext({
  symbol: 'EXIT/USDT',
  action: ACTIONS.SELL,
  amountUsdt: 0,
}).amountUsdt, 0);

await db.initSchema();
const fullExitSymbol = uniqueSymbol('PIPEEXIT');
try {
  const fullExitResult = await executeApprovedDecision({
    decision: {
      symbol: fullExitSymbol,
      action: ACTIONS.SELL,
      amount_usdt: 0,
      confidence: 0.91,
      reasoning: 'full exit smoke',
      trade_mode: 'normal',
    },
    sessionId: `pipe-exit-smoke-${Date.now()}`,
    exchange: 'binance',
    currentPortfolio: { totalAsset: 1000, positionCount: 1, usdtFree: 100 },
    symbolAnalysesMap: new Map(),
    l21Node: { id: 'L21', type: 'risk', run: async () => ({ ok: true }) },
    l30Node: l30SignalSave,
    l31Node: { id: 'L31', type: 'execute', run: async () => ({ skipped: true, reason: 'smoke' }) },
    l32Node: { id: 'L32', type: 'notify', run: async () => ({ ok: true }) },
    l33Node: { id: 'L33', type: 'rag', run: async () => ({ ok: true }) },
    l34Node: { id: 'L34', type: 'journal', run: async () => ({ ok: true }) },
    riskRejectReasons: {},
    buildDecisionBridgeMeta: async () => ({}),
    stage: 'exit',
    analystSignalsOverride: 'EXIT_PHASE',
    plannerCompact: null,
  });

  assert.ok(fullExitResult.signalId);
  assert.equal(fullExitResult.adjustedAmount, 0);
  const savedSignal = await db.getSignalById(fullExitResult.signalId);
  assert.equal(savedSignal.status, 'approved');
  assert.equal(Number(savedSignal.amount_usdt), 0);
  assert.equal(savedSignal.analyst_signals, 'EXIT_PHASE');
} finally {
  await db.run(`DELETE FROM signals WHERE symbol = $1`, [fullExitSymbol]).catch(() => {});
}

const result = {
  ok: true,
  smoke: 'pipeline-approved-decision',
  checked: ['payload_builder', 'runner_reexport', 'function_exports', 'full_exit_sell_zero', 'exit_phase_analyst_marker'],
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('✅ pipeline approved decision smoke passed');
}
