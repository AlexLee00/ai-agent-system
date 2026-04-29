#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { ACTIONS } from '../shared/signal.ts';
import {
  buildRiskApprovalRationalePayload,
  executeApprovedDecision,
  persistRiskApprovalRationale,
} from '../shared/pipeline-approved-decision.ts';
import {
  buildRiskApprovalRationalePayload as runnerPayloadBuilder,
} from '../shared/pipeline-decision-runner.ts';

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

const result = {
  ok: true,
  smoke: 'pipeline-approved-decision',
  checked: ['payload_builder', 'runner_reexport', 'function_exports'],
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('✅ pipeline approved decision smoke passed');
}

