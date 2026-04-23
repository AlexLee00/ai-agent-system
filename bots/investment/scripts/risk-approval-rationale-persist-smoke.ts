#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { ACTIONS } from '../shared/signal.ts';
import { buildRiskApprovalRationalePayload } from '../shared/pipeline-decision-runner.ts';

const payload = buildRiskApprovalRationalePayload({
  signalId: 'sig-1',
  signal: {
    action: ACTIONS.BUY,
    amount_usdt: 120,
    confidence: 0.72,
    reasoning: 'test buy',
  },
  riskResult: {
    adjustedAmount: 100,
    nemesis_verdict: 'modified',
    risk_approval_preview: {
      decision: 'ADJUST',
      application: { reason: 'assist reduction' },
    },
  },
});

assert.equal(payload.signal_id, 'sig-1');
assert.equal(payload.position_size_original, 120);
assert.equal(payload.position_size_approved, 100);
assert.equal(payload.nemesis_verdict, 'modified');
assert.equal(payload.strategy_config.risk_approval_preview.decision, 'ADJUST');
assert.equal(payload.strategy_config.risk_approval_application.reason, 'assist reduction');

const sellPayload = buildRiskApprovalRationalePayload({
  signalId: 'sig-2',
  signal: { action: ACTIONS.SELL },
  riskResult: { risk_approval_preview: { decision: 'PASS' } },
});
assert.equal(sellPayload, null);

const missingPreview = buildRiskApprovalRationalePayload({
  signalId: 'sig-3',
  signal: { action: ACTIONS.BUY },
  riskResult: {},
});
assert.equal(missingPreview, null);

console.log('risk approval rationale persist smoke ok');
