#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildRuntimeRiskApprovalDecision,
  summarizeRuntimeRiskApprovalRows,
} from './runtime-risk-approval-report.ts';
import { buildRiskApprovalSuggestions } from './runtime-config-suggestions.ts';

function row({
  symbol = 'TEST/USDT',
  exchange = 'binance',
  nemesisVerdict = 'approved',
  previewApproved = true,
  previewDecision = 'PASS',
  finalAmount = 100,
  approvedAmount = 100,
  application = {},
  steps = [],
  closed = false,
  pnlNet = null,
  pnlPercent = null,
} = {}) {
  return {
    symbol,
    exchange,
    nemesisVerdict,
    positionSizeApproved: approvedAmount,
    closed,
    pnlNet,
    pnlPercent,
    preview: {
      approved: previewApproved,
      decision: previewDecision,
      finalAmount,
      steps,
    },
    application,
  };
}

function decide(rows) {
  const summary = summarizeRuntimeRiskApprovalRows(rows);
  return {
    summary,
    decision: buildRuntimeRiskApprovalDecision(summary),
  };
}

export function runRiskApprovalReportSmoke() {
  const empty = decide([]);
  assert.equal(empty.decision.status, 'risk_approval_preview_empty');
  assert.equal(empty.summary.total, 0);

  const ok = decide([
    row({
      application: { mode: 'shadow', previewStatus: 'pass', amountBefore: 100, amountAfter: 100 },
      steps: [{ model: 'hard_rule', decision: 'PASS', amountBefore: 100, amountAfter: 100, reason: 'ok' }],
    }),
  ]);
  assert.equal(ok.decision.status, 'risk_approval_preview_ok');
  assert.equal(ok.summary.modelRows[0].model, 'hard_rule');
  assert.equal(ok.summary.amount.byPreviewStatus.pass, 1);

  const watch = decide([
    row({
      previewApproved: false,
      previewDecision: 'REJECT',
      nemesisVerdict: 'rejected',
      finalAmount: 0,
      approvedAmount: 0,
      application: { mode: 'enforce', applied: true, amountBefore: 100, amountAfter: 0, previewStatus: 'rejected' },
    }),
  ]);
  assert.equal(watch.decision.status, 'risk_approval_preview_watch');
  assert.equal(watch.summary.previewRejects, 1);
  assert.equal(watch.summary.application.rejected, 1);

  const divergence = decide([
    row({
      previewApproved: false,
      previewDecision: 'REJECT',
      nemesisVerdict: 'approved',
      finalAmount: 0,
      approvedAmount: 100,
      application: { mode: 'shadow', amountBefore: 100, amountAfter: 100, previewStatus: 'rejected' },
    }),
  ]);
  assert.equal(divergence.decision.status, 'risk_approval_preview_divergence');
  assert.equal(divergence.summary.legacyApprovedPreviewRejected, 1);
  assert.equal(divergence.summary.divergences.length, 1);

  const reduction = decide([
    row({
      finalAmount: 70,
      approvedAmount: 100,
      application: { mode: 'assist', applied: true, amountBefore: 100, amountAfter: 70, previewStatus: 'adjust' },
      steps: [{ model: 'feedback_risk', decision: 'ADJUST', amountBefore: 100, amountAfter: 70, reason: 'weak feedback' }],
    }),
  ]);
  assert.equal(reduction.summary.amount.previewAmountReductions, 1);
  assert.equal(reduction.summary.application.applied, 1);
  assert.equal(reduction.summary.application.amountDelta, -30);
  assert.equal(reduction.summary.modelRows[0].adjust, 1);

  const unavailable = decide([
    row({
      previewDecision: 'preview_failed',
      application: { mode: 'shadow', previewStatus: 'unavailable', amountBefore: 100, amountAfter: 100 },
    }),
  ]);
  assert.equal(unavailable.summary.amount.byPreviewStatus.unavailable, 1);

  const outcome = decide([
    row({
      application: { mode: 'assist', applied: true, amountBefore: 100, amountAfter: 80, previewStatus: 'adjust' },
      steps: [{ model: 'regime_risk', decision: 'ADJUST', amountBefore: 100, amountAfter: 80, reason: 'bear risk' }],
      closed: true,
      pnlNet: 12.34,
      pnlPercent: 1.23,
    }),
    row({
      application: { mode: 'assist', applied: true, amountBefore: 100, amountAfter: 90, previewStatus: 'adjust' },
      steps: [{ model: 'regime_risk', decision: 'ADJUST', amountBefore: 100, amountAfter: 90, reason: 'bear risk' }],
      closed: true,
      pnlNet: -2,
      pnlPercent: -0.2,
    }),
  ]);
  assert.equal(outcome.summary.outcome.total.closed, 2);
  assert.equal(outcome.summary.outcome.total.wins, 1);
  assert.equal(outcome.summary.outcome.total.pnlNet, 10.34);
  assert.equal(outcome.summary.outcome.byMode[0].mode, 'assist');
  assert.equal(outcome.summary.outcome.byModel[0].model, 'regime_risk');
  assert.equal(outcome.summary.outcome.samples.worst[0].pnlNet, -2);
  assert.equal(outcome.summary.outcome.samples.best[0].pnlNet, 12.34);

  const outcomeSuggestions = buildRiskApprovalSuggestions({
    decision: { status: 'risk_approval_preview_ok' },
    summary: outcome.summary,
  }, {
    delta: { legacyApprovedPreviewRejected: 0 },
  }, {
    nemesis: { riskApprovalChain: { assist: { maxReductionPct: 0.35 } } },
  });
  assert.equal(
    outcomeSuggestions.some((item) => item.key === 'runtime_config.nemesis.riskApprovalChain.outcomeMonitor'),
    true,
  );

  const weakOutcome = decide([
    row({
      application: { mode: 'assist', applied: true, amountBefore: 100, amountAfter: 85, previewStatus: 'adjust' },
      steps: [{ model: 'feedback_risk', decision: 'ADJUST', amountBefore: 100, amountAfter: 85, reason: 'weak feedback' }],
      closed: true,
      pnlNet: -1,
      pnlPercent: -0.1,
    }),
    row({
      application: { mode: 'assist', applied: true, amountBefore: 100, amountAfter: 85, previewStatus: 'adjust' },
      steps: [{ model: 'feedback_risk', decision: 'ADJUST', amountBefore: 100, amountAfter: 85, reason: 'weak feedback' }],
      closed: true,
      pnlNet: -2,
      pnlPercent: -0.2,
    }),
    row({
      application: { mode: 'assist', applied: true, amountBefore: 100, amountAfter: 85, previewStatus: 'adjust' },
      steps: [{ model: 'feedback_risk', decision: 'ADJUST', amountBefore: 100, amountAfter: 85, reason: 'weak feedback' }],
      closed: true,
      pnlNet: -3,
      pnlPercent: -0.3,
    }),
  ]);
  const weakSuggestions = buildRiskApprovalSuggestions({
    decision: { status: 'risk_approval_preview_ok' },
    summary: weakOutcome.summary,
  }, null, {
    nemesis: { riskApprovalChain: { assist: { maxReductionPct: 0.35 } } },
  });
  const assistTighten = weakSuggestions.find((item) => item.key === 'runtime_config.nemesis.riskApprovalChain.assist.maxReductionPct');
  assert.equal(assistTighten?.suggested, 0.4);
  assert.equal(weakOutcome.summary.outcome.samples.worst[0].pnlNet, -3);
  assert.equal(
    weakSuggestions.some((item) => item.key === 'runtime_config.nemesis.riskApprovalChain.model.feedback_risk.outcomeReview'),
    true,
  );

  return {
    ok: true,
    empty,
    okDecision: ok.decision,
    watch: watch.decision,
    divergence: divergence.decision,
    reduction: reduction.summary.application,
    unavailable: unavailable.summary.amount.byPreviewStatus,
    outcome: outcome.summary.outcome.total,
    outcomeSuggestions: outcomeSuggestions.map((item) => item.key),
    weakOutcomeSuggestions: weakSuggestions.map((item) => item.key),
  };
}

async function main() {
  const result = runRiskApprovalReportSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('risk approval report smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ risk approval report smoke 실패:',
  });
}
