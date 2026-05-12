#!/usr/bin/env node

import assert from 'node:assert/strict';
import { buildLunaHybridFinalClosureReport, LUNA_PROTECTED_6 } from '../shared/luna-hybrid-final-closure.ts';
import { runLunaHybridFinalClosure } from './runtime-luna-hybrid-final-closure.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function readyPhase11() {
  return {
    ok: true,
    status: 'luna_hybrid_promotion_review_ready',
    liveMutation: false,
    protectedPidMutation: false,
    promotionReady: false,
    readyForMasterReview: true,
    masterApprovalRequired: true,
    gate: { status: 'luna_hybrid_promotion_gate_ready_for_master_review' },
  };
}

function readyBottleneck() {
  return {
    ok: true,
    status: 'luna_bottleneck_clear',
    hardBlockers: [],
    bottlenecks: [],
    warnings: [],
    evidence: {
      marketdata: { ok: true, status: 'marketdata_realtime_connectivity_ready', blockers: [] },
      finalGate: { ok: true, status: 'luna_live_fire_final_gate_clear', blockers: [] },
      postLive: { ok: true, status: 'post_live_fire_verified', blockers: [] },
    },
  };
}

export async function runLunaHybridFinalClosureSmoke() {
  const report = buildLunaHybridFinalClosureReport({
    phase11Report: readyPhase11(),
    bottleneckReport: readyBottleneck(),
    protectedPidStatus: { source: 'fixture', visibleLabels: LUNA_PROTECTED_6 },
  });
  assert.equal(report.ok, true, JSON.stringify(report.blockers, null, 2));
  assert.equal(report.shadowMode, true);
  assert.equal(report.finalClosureReady, true);
  assert.equal(report.masterApprovalRequired, true);
  assert.equal(report.promotionReady, false);
  assert.equal(report.liveMutation, false);
  assert.equal(report.protectedPidMutation, false);
  assert.equal(report.status, 'luna_hybrid_final_closure_ready_for_master_operational_review');
  assert.ok(report.runbook.finalClosureOnly);
  assert.equal(report.runbook.liveMutationAllowed, false);
  assert.equal(report.runbook.protectedPidMutationAllowed, false);
  assert.ok(report.runbook.prohibitedWithoutApproval.includes('live trade'));
  assert.ok(report.runbook.prohibitedWithoutApproval.includes('protected PID restart/kill/unload'));

  const guardedReentry = buildLunaHybridFinalClosureReport({
    phase11Report: readyPhase11(),
    bottleneckReport: {
      ...readyBottleneck(),
      status: 'luna_bottleneck_attention',
      bottlenecks: ['discovery:crypto:live_position_reentry_blocked_recent_buy_signal'],
    },
    protectedPidStatus: { source: 'fixture', visibleLabels: LUNA_PROTECTED_6 },
  });
  assert.equal(guardedReentry.ok, true);
  assert.equal(guardedReentry.finalClosureReady, true);
  assert.match(
    guardedReentry.checklist.find((item) => item.name === 'bottleneck_autonomy_clear')?.detail || '',
    /clear_with_nonblocking_guards/,
  );
  assert.deepEqual(guardedReentry.evidence.bottleneck.bottlenecks, []);
  assert.deepEqual(guardedReentry.evidence.bottleneck.nonBlockingBottlenecks, [
    'discovery:crypto:live_position_reentry_blocked_recent_buy_signal',
  ]);

  const blocked = buildLunaHybridFinalClosureReport({
    phase11Report: { ...readyPhase11(), readyForMasterReview: false },
    bottleneckReport: {
      ...readyBottleneck(),
      hardBlockers: ['operational:manual_reconcile_required'],
    },
    protectedPidStatus: { source: 'fixture', visibleLabels: LUNA_PROTECTED_6.slice(0, -1) },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.finalClosureReady, false);
  assert.ok(blocked.blockers.some((item) => item.name === 'bottleneck_autonomy_clear'));
  assert.ok(blocked.blockers.some((item) => item.name === 'protected_6_visible'));

  const noExec = await runLunaHybridFinalClosure({
    json: true,
    strict: true,
    noExec: true,
    noDb: true,
    hours: 168,
  }, {
    phase11Report: {
      ...readyPhase11(),
      readyForMasterReview: false,
      status: 'luna_hybrid_promotion_review_contract_only',
    },
  });
  assert.equal(noExec.ok, true);
  assert.equal(noExec.noExec, true);
  assert.equal(noExec.finalClosureReady, false);
  assert.equal(noExec.status, 'luna_hybrid_final_closure_contract_only');

  const applyBlocked = await runLunaHybridFinalClosure({ apply: true, json: true, noExec: true });
  assert.equal(applyBlocked.ok, false);
  assert.equal(applyBlocked.status, 'luna_hybrid_final_closure_apply_blocked');
  assert.equal(applyBlocked.liveMutation, false);
  assert.equal(applyBlocked.promotionReady, false);

  return {
    ok: true,
    smoke: 'luna-hybrid-final-closure-phase12',
    status: report.status,
    noExecStatus: noExec.status,
    finalClosureReady: report.finalClosureReady,
    promotionReady: report.promotionReady,
    masterApprovalRequired: report.masterApprovalRequired,
    liveMutation: report.liveMutation,
  };
}

async function main() {
  const result = await runLunaHybridFinalClosureSmoke();
  console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'luna hybrid final closure smoke failed:',
  });
}
