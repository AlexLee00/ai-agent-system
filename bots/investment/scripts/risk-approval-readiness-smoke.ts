#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildRiskApprovalModeDryRun,
  buildRiskApprovalReadinessDecision,
} from './runtime-risk-approval-readiness.ts';

function riskApproval({
  total = 20,
  previewRejects = 0,
  divergence = 0,
  reductions = 0,
  previewDelta = 0,
  outcomeClosed = 0,
  outcomePnlNet = 0,
  outcomeAvgPnlPercent = null,
  outcomeModeAvgPnlPercent = null,
} = {}) {
  return {
    summary: {
      total,
      previewRejects,
      legacyApprovedPreviewRejected: divergence,
      amount: {
        previewAmountReductions: reductions,
        previewVsApprovedDelta: previewDelta,
        approved: 1000,
        previewFinal: 1000 + previewDelta,
      },
      outcome: {
        total: {
          total,
          closed: outcomeClosed,
          pnlNet: outcomePnlNet,
          avgPnlPercent: outcomeAvgPnlPercent,
        },
        byMode: outcomeClosed > 0 ? [{
          mode: 'assist',
          total,
          closed: outcomeClosed,
          pnlNet: outcomePnlNet,
          avgPnlPercent: outcomeModeAvgPnlPercent ?? outcomeAvgPnlPercent,
        }] : [],
      },
    },
  };
}

function executionGuard({ stale = 0, bypass = 0 } = {}) {
  return {
    summary: {
      staleCount: stale,
      bypassCount: bypass,
    },
  };
}

function modeConfig(mode = 'shadow') {
  return {
    mode,
    assist: { applyAmountReduction: true, maxReductionPct: 0.35 },
    enforce: { rejectOnPreviewReject: true, applyAmountReduction: true },
  };
}

function decide({ approval = riskApproval(), guard = executionGuard(), mode = 'shadow', sampleContext = null } = {}) {
  return buildRiskApprovalReadinessDecision({
    riskApproval: approval,
    executionGuard: guard,
    modeConfig: modeConfig(mode),
    sampleContext,
  });
}

export function runRiskApprovalReadinessSmoke() {
  const collectSamples = decide({ approval: riskApproval({ total: 0 }) });
  assert.equal(collectSamples.status, 'risk_approval_readiness_collect_samples');
  assert.equal(collectSamples.blockers[0], 'preview 표본 20건 미만');

  const telemetryGap = decide({
    approval: riskApproval({ total: 0 }),
    sampleContext: {
      rationaleTotal: 0,
      rationaleWithPreview: 0,
      executedBuySignals: 3,
    },
  });
  assert.equal(telemetryGap.status, 'risk_approval_readiness_telemetry_gap');
  assert.match(telemetryGap.headline, /텔레메트리/);
  assert.equal(telemetryGap.metrics.sampleContext.executedBuySignals, 3);

  const divergenceBlocked = decide({ approval: riskApproval({ total: 25, divergence: 1 }) });
  assert.equal(divergenceBlocked.status, 'risk_approval_readiness_blocked');
  assert.match(divergenceBlocked.headline, /divergence/);

  const staleBlocked = decide({ approval: riskApproval({ total: 25 }), guard: executionGuard({ stale: 1 }) });
  assert.equal(staleBlocked.status, 'risk_approval_readiness_blocked');

  const rejectRateBlocked = decide({ approval: riskApproval({ total: 25, previewRejects: 10 }) });
  assert.equal(rejectRateBlocked.status, 'risk_approval_readiness_collect_samples');
  assert.match(rejectRateBlocked.headline, /preview reject/);

  const outcomeBlocked = decide({
    approval: riskApproval({
      total: 25,
      outcomeClosed: 3,
      outcomePnlNet: -4,
      outcomeAvgPnlPercent: -0.2,
    }),
  });
  assert.equal(outcomeBlocked.status, 'risk_approval_readiness_blocked');
  assert.match(outcomeBlocked.headline, /사후 성과/);
  assert.equal(outcomeBlocked.metrics.outcomeClosed, 3);

  const assistReady = decide({ approval: riskApproval({ total: 25 }), mode: 'shadow' });
  assert.equal(assistReady.status, 'risk_approval_readiness_assist_ready');
  assert.equal(assistReady.targetMode, 'assist');

  const assistObserve = decide({ approval: riskApproval({ total: 30 }), mode: 'assist' });
  assert.equal(assistObserve.status, 'risk_approval_readiness_assist_observe');
  assert.equal(assistObserve.targetMode, 'assist');

  const enforceCandidate = decide({ approval: riskApproval({ total: 50 }), mode: 'assist' });
  assert.equal(enforceCandidate.status, 'risk_approval_readiness_enforce_candidate');
  assert.equal(enforceCandidate.targetMode, 'enforce');

  const enforced = decide({ approval: riskApproval({ total: 60 }), mode: 'enforce' });
  assert.equal(enforced.status, 'risk_approval_readiness_enforced');

  const dryRun = buildRiskApprovalModeDryRun(
    riskApproval({ total: 50, previewRejects: 3, reductions: 7, previewDelta: -120 }),
    modeConfig('assist'),
  );
  assert.equal(dryRun.assist.applied, 7);
  assert.equal(dryRun.assist.amountDelta, -120);
  assert.equal(dryRun.enforce.rejected, 3);

  return {
    ok: true,
    collectSamples,
    divergenceBlocked,
    staleBlocked,
    rejectRateBlocked,
    outcomeBlocked,
    assistReady,
    enforceCandidate,
    enforced,
    dryRun,
  };
}

async function main() {
  const result = runRiskApprovalReadinessSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('risk approval readiness smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ risk approval readiness smoke 실패:',
  });
}
