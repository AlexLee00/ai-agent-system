#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRiskApprovalModeAuditDecision } from './runtime-risk-approval-mode-audit.ts';

function riskApproval({ byMode = [], byPreviewStatus = {}, applied = 0, rejected = 0 } = {}) {
  return {
    summary: {
      application: {
        applied,
        rejected,
        byMode,
      },
      amount: {
        byPreviewStatus,
      },
    },
  };
}

function readiness({ mode = 'shadow', status = 'risk_approval_readiness_collect_samples', blockers = [] } = {}) {
  return {
    modeConfig: { mode },
    decision: {
      status,
      currentMode: mode,
      blockers,
    },
  };
}

function decide(input) {
  return buildRiskApprovalModeAuditDecision(input);
}

export function runRiskApprovalModeAuditSmoke() {
  const shadowDrift = decide({
    riskApproval: riskApproval({
      applied: 1,
      byMode: [{ mode: 'assist', total: 1, applied: 1, rejected: 0, amountDelta: -20 }],
    }),
    readiness: readiness({ mode: 'shadow' }),
  });
  assert.equal(shadowDrift.status, 'risk_approval_mode_audit_attention');
  assert.equal(shadowDrift.metrics.nonShadowApplications, 1);

  const blockedApplied = decide({
    riskApproval: riskApproval({
      applied: 1,
      byMode: [{ mode: 'enforce', total: 1, applied: 1, rejected: 0, amountDelta: -40 }],
    }),
    readiness: readiness({ mode: 'enforce', blockers: ['preview 표본 20건 미만'] }),
  });
  assert.equal(blockedApplied.status, 'risk_approval_mode_audit_attention');

  const modeWatch = decide({
    riskApproval: riskApproval(),
    readiness: readiness({ mode: 'assist', blockers: ['preview 표본 20건 미만'] }),
  });
  assert.equal(modeWatch.status, 'risk_approval_mode_audit_mode_watch');

  const sampling = decide({
    riskApproval: riskApproval(),
    readiness: readiness({ mode: 'assist', status: 'risk_approval_readiness_assist_observe' }),
  });
  assert.equal(sampling.status, 'risk_approval_mode_audit_sampling');

  const previewWatch = decide({
    riskApproval: riskApproval({ byPreviewStatus: { unavailable: 2 } }),
    readiness: readiness({ mode: 'shadow', status: 'risk_approval_readiness_collect_samples' }),
  });
  assert.equal(previewWatch.status, 'risk_approval_mode_audit_preview_watch');
  assert.equal(previewWatch.metrics.unavailablePreviewCount, 2);

  const ok = decide({
    riskApproval: riskApproval(),
    readiness: readiness({ mode: 'shadow' }),
  });
  assert.equal(ok.status, 'risk_approval_mode_audit_ok');

  return {
    ok: true,
    shadowDrift,
    blockedApplied,
    modeWatch,
    sampling,
    previewWatch,
  };
}

async function main() {
  const result = runRiskApprovalModeAuditSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('risk approval mode audit smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ risk approval mode audit smoke 실패:',
  });
}
