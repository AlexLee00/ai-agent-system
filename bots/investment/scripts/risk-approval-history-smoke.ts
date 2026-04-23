#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRuntimeRiskApprovalHistoryDelta } from './runtime-risk-approval-history.ts';
import { buildRuntimeRiskApprovalReadinessHistoryDelta } from './runtime-risk-approval-readiness-history.ts';
import { buildRuntimeRiskApprovalModeAuditHistoryDelta } from './runtime-risk-approval-mode-audit-history.ts';
import { buildRuntimeExecutionRiskGuardHistoryDelta } from './runtime-execution-risk-guard-history.ts';

export function runRiskApprovalHistorySmoke() {
  const preview = buildRuntimeRiskApprovalHistoryDelta({
    total: 12,
    previewRejects: 3,
    legacyApprovedPreviewRejected: 1,
    previewVsApprovedDelta: -50,
    approved: 1000,
    previewFinal: 950,
    applicationApplied: 2,
    applicationRejected: 1,
    applicationAmountDelta: -80,
  }, {
    total: 10,
    previewRejects: 1,
    legacyApprovedPreviewRejected: 0,
    previewVsApprovedDelta: -20,
    approved: 900,
    previewFinal: 880,
    applicationApplied: 1,
    applicationRejected: 0,
    applicationAmountDelta: -30,
  });
  assert.equal(preview.total, 2);
  assert.equal(preview.previewRejects, 2);
  assert.equal(preview.legacyApprovedPreviewRejected, 1);
  assert.equal(preview.previewVsApprovedDelta, -30);
  assert.equal(preview.applicationAmountDelta, -50);

  const readiness = buildRuntimeRiskApprovalReadinessHistoryDelta({
    blockerCount: 2,
    previewTotal: 30,
    previewRejects: 4,
    divergence: 1,
    executionStale: 1,
    executionBypass: 0,
    amountReductionCandidates: 5,
    assistApplied: 5,
    assistAmountDelta: -70,
    enforceRejected: 4,
    enforceAmountDelta: -70,
  }, {
    blockerCount: 1,
    previewTotal: 20,
    previewRejects: 2,
    divergence: 0,
    executionStale: 0,
    executionBypass: 1,
    amountReductionCandidates: 2,
    assistApplied: 2,
    assistAmountDelta: -20,
    enforceRejected: 2,
    enforceAmountDelta: -20,
  });
  assert.equal(readiness.blockerCount, 1);
  assert.equal(readiness.previewTotal, 10);
  assert.equal(readiness.executionBypass, -1);
  assert.equal(readiness.assistAmountDelta, -50);

  const modeAudit = buildRuntimeRiskApprovalModeAuditHistoryDelta({
    blockerCount: 1,
    applied: 3,
    rejected: 1,
    nonShadowApplications: 4,
    unavailablePreviewCount: 2,
  }, {
    blockerCount: 2,
    applied: 1,
    rejected: 1,
    nonShadowApplications: 2,
    unavailablePreviewCount: 0,
  });
  assert.equal(modeAudit.blockerCount, -1);
  assert.equal(modeAudit.applied, 2);
  assert.equal(modeAudit.nonShadowApplications, 2);
  assert.equal(modeAudit.unavailablePreviewCount, 2);

  const executionGuard = buildRuntimeExecutionRiskGuardHistoryDelta({
    total: 5,
    staleCount: 2,
    bypassCount: 1,
  }, {
    total: 2,
    staleCount: 1,
    bypassCount: 3,
  });
  assert.equal(executionGuard.total, 3);
  assert.equal(executionGuard.staleCount, 1);
  assert.equal(executionGuard.bypassCount, -2);

  const firstSnapshot = buildRuntimeRiskApprovalHistoryDelta({ total: 10 }, null);
  assert.equal(firstSnapshot.total, 0);

  return {
    ok: true,
    preview,
    readiness,
    modeAudit,
    executionGuard,
  };
}

async function main() {
  const result = runRiskApprovalHistorySmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('risk approval history smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ risk approval history smoke 실패:',
  });
}
