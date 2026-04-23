#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import {
  applyRiskApprovalChainMode,
  normalizeRiskApprovalChainModeConfig,
} from '../shared/risk-approval-mode.ts';

const baseAdaptive = {
  llm: {
    decision: 'APPROVE',
    reasoning: 'base approval',
  },
};
const rules = { MIN_ORDER_USDT: 10 };

function apply(overrides = {}) {
  return applyRiskApprovalChainMode({
    amountUsdt: 100,
    adaptiveResult: baseAdaptive,
    riskApprovalPreview: { approved: true, decision: 'ADJUST', finalAmount: 40 },
    rules,
    ...overrides,
  });
}

const invalid = normalizeRiskApprovalChainModeConfig({ mode: 'oops', assist: { maxReductionPct: NaN } });
assert.equal(invalid.mode, 'shadow');
assert.equal(invalid.assist.maxReductionPct, 0.35);

const shadow = apply({ modeConfig: { mode: 'shadow' } });
assert.equal(shadow.approved, true);
assert.equal(shadow.applied, false);
assert.equal(shadow.amountUsdt, 100);
assert.equal(shadow.previewStatus, 'adjust');

const assistBounded = apply({
  modeConfig: {
    mode: 'assist',
    assist: { applyAmountReduction: true, maxReductionPct: 0.35 },
  },
});
assert.equal(assistBounded.approved, true);
assert.equal(assistBounded.applied, true);
assert.equal(assistBounded.amountUsdt, 65);
assert.equal(assistBounded.adaptiveResult.llm.decision, 'ADJUST');
assert.equal(assistBounded.modeConfig.assist.maxReductionPct, 0.35);

const assistDisabled = apply({
  modeConfig: {
    mode: 'assist',
    assist: { applyAmountReduction: false, maxReductionPct: 0.35 },
  },
});
assert.equal(assistDisabled.approved, true);
assert.equal(assistDisabled.applied, false);
assert.equal(assistDisabled.amountUsdt, 100);

const enforceReject = apply({
  modeConfig: {
    mode: 'enforce',
    enforce: { rejectOnPreviewReject: true, applyAmountReduction: true },
  },
  riskApprovalPreview: {
    approved: false,
    decision: 'REJECT',
    finalAmount: 0,
    rejectReason: 'test reject',
  },
});
assert.equal(enforceReject.approved, false);
assert.equal(enforceReject.applied, true);
assert.equal(enforceReject.reason, 'test reject');

const enforceReduce = apply({
  modeConfig: {
    mode: 'enforce',
    enforce: { rejectOnPreviewReject: false, applyAmountReduction: true },
  },
  riskApprovalPreview: {
    approved: false,
    decision: 'REJECT',
    finalAmount: 40,
  },
});
assert.equal(enforceReduce.approved, true);
assert.equal(enforceReduce.applied, true);
assert.equal(enforceReduce.amountUsdt, 40);

const minOrder = apply({
  modeConfig: {
    mode: 'enforce',
    enforce: { rejectOnPreviewReject: false, applyAmountReduction: true },
  },
  riskApprovalPreview: {
    approved: true,
    decision: 'ADJUST',
    finalAmount: 3,
  },
});
assert.equal(minOrder.approved, true);
assert.equal(minOrder.applied, true);
assert.equal(minOrder.amountUsdt, 10);

const previewFailed = apply({
  modeConfig: {
    mode: 'enforce',
    enforce: { rejectOnPreviewReject: true, applyAmountReduction: true },
  },
  riskApprovalPreview: {
    approved: null,
    decision: 'preview_failed',
    error: 'boom',
  },
});
assert.equal(previewFailed.approved, true);
assert.equal(previewFailed.applied, false);
assert.equal(previewFailed.previewStatus, 'unavailable');
assert.match(previewFailed.reason, /preview is unavailable/);

const invalidAmount = apply({
  amountUsdt: 0,
  modeConfig: {
    mode: 'assist',
    assist: { applyAmountReduction: true, maxReductionPct: 0.35 },
  },
});
assert.equal(invalidAmount.approved, false);
assert.equal(invalidAmount.applied, true);
assert.equal(invalidAmount.amountUsdt, 0);
assert.equal(invalidAmount.reason, 'risk approval chain invalid amount');

console.log('risk approval mode smoke ok');
