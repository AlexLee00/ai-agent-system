#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRiskApprovalModeAuditDecision } from './runtime-risk-approval-mode-audit.ts';

function riskApproval({
  byMode = [],
  byPreviewStatus = {},
  applied = 0,
  rejected = 0,
  outcomeClosed = 0,
  outcomePnlNet = 0,
  outcomeAvgPnlPercent = null,
} = {}) {
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
      outcome: {
        total: {
          closed: outcomeClosed,
          pnlNet: outcomePnlNet,
          avgPnlPercent: outcomeAvgPnlPercent,
        },
        byMode: outcomeClosed > 0 ? [{
          mode: 'assist',
          closed: outcomeClosed,
          pnlNet: outcomePnlNet,
          avgPnlPercent: outcomeAvgPnlPercent,
        }] : [],
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

  const outcomeAttention = decide({
    riskApproval: riskApproval({
      outcomeClosed: 3,
      outcomePnlNet: -5,
      outcomeAvgPnlPercent: -0.3,
    }),
    readiness: readiness({
      mode: 'assist',
      status: 'risk_approval_readiness_blocked',
      blockers: ['리스크 승인 사후 성과 음수'],
    }),
  });
  assert.equal(outcomeAttention.status, 'risk_approval_mode_audit_attention');
  assert.match(outcomeAttention.headline, /사후 성과/);
  assert.equal(outcomeAttention.metrics.outcomeClosed, 3);

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

  const telemetryGap = decide({
    riskApproval: riskApproval(),
    readiness: readiness({
      mode: 'shadow',
      status: 'risk_approval_readiness_telemetry_gap',
      blockers: ['risk approval preview telemetry gap'],
    }),
  });
  assert.equal(telemetryGap.status, 'risk_approval_mode_audit_telemetry_gap');
  assert.match(telemetryGap.headline, /텔레메트리/);

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
    outcomeAttention,
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
