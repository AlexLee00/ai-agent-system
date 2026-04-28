#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runLunaCanaryOperatorSmoke } from './luna-canary-operator.ts';
import { runLunaPredictionCanaryPreflightSmoke } from './luna-prediction-canary-preflight.ts';
import { runLunaEntryTriggerActiveWorkerSmoke } from './luna-entry-trigger-active-worker-smoke.ts';
import { runLunaEntryTriggerDuplicateCooldownSmoke } from './luna-entry-trigger-duplicate-cooldown-smoke.ts';
import { runLunaEntryTriggerRiskGateSmoke } from './luna-entry-trigger-risk-gate-smoke.ts';
import { runLunaEntryTriggerOperatingReportSmoke } from './luna-entry-trigger-operating-report.ts';
import { runLunaEntryTriggerWorkerServiceSmoke } from './luna-entry-trigger-worker-service.ts';
import { runLunaEntryTriggerWorkerReadinessSmoke } from './luna-entry-trigger-worker-readiness.ts';
import { runLunaL5OperatingReportSmoke } from './luna-l5-operating-report.ts';
import { runLunaLiveFireCutoverSmoke } from './luna-live-fire-cutover.ts';
import { runLunaLiveFireCutoverPreflightSmoke } from './luna-live-fire-cutover-preflight.ts';
import { runLunaLiveFireOperatorSmoke } from './luna-live-fire-operator.ts';
import { runLunaLiveFireReadinessGateSmoke } from './luna-live-fire-readiness-gate.ts';
import { runLunaLiveFireWatchdogSmoke } from './luna-live-fire-watchdog.ts';
import { runLunaPostLiveFireVerificationSmoke } from './luna-post-live-fire-verify.ts';
import { runLunaReconcileAckSmoke } from './luna-reconcile-ack.ts';
import { runLunaReconcileAckPreflightSmoke } from './luna-reconcile-ack-preflight.ts';
import { runLunaReconcileAckBatchSmoke } from './luna-reconcile-ack-batch.ts';
import { runLunaReflectionConfigPatchSmoke } from './luna-reflection-config-patch.ts';
import { runLunaReconcileBlockerReportSmoke } from './luna-reconcile-blocker-report.ts';
import { runLunaReconcileResolutionPlanSmoke } from './luna-reconcile-resolution-plan.ts';
import { runLunaTradeReconciliationGateSmoke } from './luna-trade-reconciliation-gate.ts';
import { runLunaManualReconcilePlaybookSmoke } from './luna-manual-reconcile-playbook.ts';
import { runLunaManualReconcileAssistantSmoke } from './luna-manual-reconcile-assistant.ts';
import { runLunaKillSwitchConsistencySmoke } from './luna-kill-switch-consistency.ts';
import { runLunaLiveFireFinalGateSmoke } from './luna-live-fire-final-gate.ts';

export async function runLunaIntelligentOpsSuite() {
  // These smokes patch process.env, so keep them sequential to avoid cross-test mode bleed.
  const canaryOperator = await runLunaCanaryOperatorSmoke();
  const predictionPreflight = await runLunaPredictionCanaryPreflightSmoke();
  const riskGate = await runLunaEntryTriggerRiskGateSmoke();
  const activeWorker = await runLunaEntryTriggerActiveWorkerSmoke();
  const duplicateCooldown = await runLunaEntryTriggerDuplicateCooldownSmoke();
  const workerService = await runLunaEntryTriggerWorkerServiceSmoke();
  const workerReadiness = await runLunaEntryTriggerWorkerReadinessSmoke();
  const entryTriggerReport = await runLunaEntryTriggerOperatingReportSmoke();
  const reconcileBlockerReport = await runLunaReconcileBlockerReportSmoke();
  const reconcileResolutionPlan = await runLunaReconcileResolutionPlanSmoke();
  const reconcileAck = await runLunaReconcileAckSmoke();
  const reconcileAckPreflight = await runLunaReconcileAckPreflightSmoke();
  const reconcileAckBatch = runLunaReconcileAckBatchSmoke();
  const manualReconcilePlaybook = await runLunaManualReconcilePlaybookSmoke();
  const manualReconcileAssistant = await runLunaManualReconcileAssistantSmoke();
  const tradeReconciliation = await runLunaTradeReconciliationGateSmoke();
  const killSwitchConsistency = await runLunaKillSwitchConsistencySmoke();
  const operatingReport = await runLunaL5OperatingReportSmoke();
  const postLiveFireVerify = await runLunaPostLiveFireVerificationSmoke();
  const liveFireReadiness = await runLunaLiveFireReadinessGateSmoke();
  const liveFireOperator = await runLunaLiveFireOperatorSmoke();
  const liveFireCutoverPreflight = await runLunaLiveFireCutoverPreflightSmoke();
  const liveFireCutover = await runLunaLiveFireCutoverSmoke();
  const liveFireWatchdog = await runLunaLiveFireWatchdogSmoke();
  const liveFireFinalGate = await runLunaLiveFireFinalGateSmoke();
  const reflectionPatch = runLunaReflectionConfigPatchSmoke();
  assert.equal(canaryOperator.ok, true);
  assert.ok(predictionPreflight.status);
  assert.equal(riskGate.ok, true);
  assert.equal(activeWorker.ok, true);
  assert.equal(duplicateCooldown.ok, true);
  assert.equal(workerService.ok, true);
  assert.ok(workerReadiness.status);
  assert.ok(entryTriggerReport.status);
  assert.equal(reconcileBlockerReport.ok, true);
  assert.equal(reconcileResolutionPlan.ok, true);
  assert.equal(reconcileAck.ok, true);
  assert.equal(reconcileAckPreflight.ok, true);
  assert.equal(reconcileAckBatch.ok, true);
  assert.equal(manualReconcilePlaybook.ok, true);
  assert.equal(manualReconcileAssistant.ok, true);
  assert.equal(tradeReconciliation.ok, true);
  assert.equal(killSwitchConsistency.ok, true);
  assert.ok(operatingReport.status);
  assert.equal(postLiveFireVerify.ok, true);
  assert.equal(liveFireReadiness.ok, true);
  assert.equal(liveFireOperator.ok, true);
  assert.equal(liveFireCutoverPreflight.ok, true);
  assert.equal(liveFireCutover.ok, true);
  assert.equal(liveFireWatchdog.ok, true);
  assert.equal(liveFireFinalGate.ok, true);
  assert.equal(reflectionPatch.ok, true);
  return {
    ok: true,
    canaryOperator: { validation: canaryOperator.validation?.status, prediction: canaryOperator.prediction?.status },
    predictionPreflight: { status: predictionPreflight.status, blockers: predictionPreflight.blockers || [] },
    riskGate: { blocked: riskGate.blocked?.riskGateReason, allowed: riskGate.allowed?.state },
    activeWorker: activeWorker.result,
    duplicateCooldown: duplicateCooldown.second,
    workerService: { install: workerService.install?.action, unload: workerService.unload?.action },
    workerReadiness: { status: workerReadiness.status, warnings: workerReadiness.warnings || [] },
    entryTriggerReport: { status: entryTriggerReport.status, warnings: entryTriggerReport.warnings || [] },
    reconcileBlockerReport: { manualClass: reconcileBlockerReport.blocker?.resolutionClass },
    reconcileResolutionPlan: { blocking: reconcileResolutionPlan.plan?.summary?.liveFireBlocking },
    reconcileAck: { eligible: reconcileAck.eligible?.status, blocked: reconcileAck.blocked?.status },
    reconcileAckPreflight: {
      absent: reconcileAckPreflight.absent?.status,
      found: reconcileAckPreflight.found?.status,
    },
    reconcileAckBatch: {
      unsafe: reconcileAckBatch.summary?.unsafe,
    },
    manualReconcilePlaybook: {
      blockedTasks: manualReconcilePlaybook.blocked?.summary?.tasks,
    },
    manualReconcileAssistant: {
      blockedStatus: manualReconcileAssistant.blocked?.status,
    },
    tradeReconciliation: {
      syntheticHard: tradeReconciliation.syntheticBlocked?.hardReconcile,
      syntheticPending: tradeReconciliation.syntheticBlocked?.pendingReconcile,
    },
    killSwitchConsistency: {
      conflictStatus: killSwitchConsistency.conflict?.status,
    },
    operatingReport: { status: operatingReport.status, nextAction: operatingReport.nextAction },
    postLiveFireVerify: { blockedCount: postLiveFireVerify.blocked?.length || 0 },
    liveFireReadiness: { status: liveFireReadiness.ready?.status, blockers: liveFireReadiness.ready?.blockers || [] },
    liveFireOperator: { confirmRequired: liveFireOperator.confirmRequired },
    liveFireCutoverPreflight: { ok: liveFireCutoverPreflight.ok },
    liveFireCutover: { confirmRequired: liveFireCutover.confirmRequired },
    liveFireWatchdog: { rollbackStatus: liveFireWatchdog.rollback?.status },
    liveFireFinalGate: { blockers: liveFireFinalGate.blockers || [] },
    reflectionPatch: { status: reflectionPatch.status, operationCount: reflectionPatch.operationCount },
  };
}

async function main() {
  const result = await runLunaIntelligentOpsSuite();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna intelligent ops suite ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna intelligent ops suite 실패:',
  });
}
