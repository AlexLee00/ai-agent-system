#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaL5ReadinessReport } from './luna-l5-readiness-report.ts';
import { buildLunaMapekCanaryObservation } from './luna-mapek-canary-observer.ts';
import { buildLunaValidationCanaryPreflight } from './luna-validation-canary-preflight.ts';
import { buildLunaPredictionCanaryPreflight } from './luna-prediction-canary-preflight.ts';
import { buildLunaEntryTriggerWorkerReadiness } from './luna-entry-trigger-worker-readiness.ts';
import { evaluateLunaLiveFireReadinessGate } from './luna-live-fire-readiness-core.ts';
import { buildLunaTradeReconciliationGate } from './luna-trade-reconciliation-gate.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import { buildLunaL5FinalGateReport } from './luna-l5-final-gate.ts';
import { buildLunaL5PhaseActivationPlan } from './luna-l5-phase-activation-operator.ts';
import { buildPosttradeFeedbackOperatingReport } from './runtime-posttrade-feedback-operating-report.ts';

function nextAction({ validation, prediction, entryTrigger, tradeReconciliation, finalGate, phaseActivation, posttradeFeedback } = {}) {
  if (finalGate?.ok === false && (finalGate.blockers || []).includes('supervised_cutover_requires_at_least_one_lifecycle_phase')) {
    const nextPhase = phaseActivation?.steps?.[0]?.phase || 'phaseD';
    return `activate_lifecycle_${nextPhase}`;
  }
  if (posttradeFeedback?.ok === false) return posttradeFeedback.nextAction || 'repair_posttrade_feedback_loop';
  if (entryTrigger?.warnings?.length) return 'repair_entry_trigger_worker_runtime';
  if (tradeReconciliation?.ok === false) return 'resolve_trade_reconciliation_blockers';
  if (finalGate?.ok === false) return 'resolve_luna_l5_final_gate_blockers';
  if (validation?.ok && validation?.alreadyEnabled !== true) return 'enable_validation_canary';
  if (prediction?.ok && prediction?.alreadyEnabled !== true) return 'enable_prediction_canary';
  return 'continue_observation';
}

export async function buildLunaL5OperatingReport({ hours = 24 } = {}) {
  const [readiness, mapek, validation, prediction, entryTrigger, tradeReconciliation, finalGate, posttradeFeedback] = await Promise.all([
    buildLunaL5ReadinessReport(),
    buildLunaMapekCanaryObservation({ hours }),
    buildLunaValidationCanaryPreflight({ hours }),
    buildLunaPredictionCanaryPreflight({ hours }),
    buildLunaEntryTriggerWorkerReadiness({ hours }),
    buildLunaTradeReconciliationGate({ hours: Math.min(6, Number(hours || 24)) || 6 }),
    buildLunaL5FinalGateReport({ targetMode: 'supervised_l4', limit: 3, warmupHours: hours }).catch((error) => ({
      ok: false,
      status: 'luna_l5_final_gate_failed',
      blockers: [`final_gate_failed:${error?.message || String(error)}`],
      warnings: [],
    })),
    buildPosttradeFeedbackOperatingReport({ days: Math.max(1, Math.ceil(Number(hours || 24) / 24) * 7), market: 'all' }).catch((error) => ({
      ok: false,
      status: 'posttrade_feedback_report_failed',
      blockers: [`posttrade_feedback_report_failed:${error?.message || String(error)}`],
      nextAction: 'repair_posttrade_feedback_report',
    })),
  ]);
  const phaseActivation = buildLunaL5PhaseActivationPlan({ requestedPhase: 'next' });
  const phaseActivationComplete = (phaseActivation.blockers || []).length === 1
    && (phaseActivation.blockers || [])[0] === 'no_phase_to_enable';
  const phaseActivationStatus = phaseActivationComplete
    ? 'luna_l5_phase_activation_complete'
    : phaseActivation.status;
  const blockers = [
    ...(mapek.ok ? [] : ['mapek_not_clean']),
    ...(tradeReconciliation.ok ? [] : ['trade_reconciliation_attention']),
    ...(finalGate.ok ? [] : ['luna_l5_final_gate_attention']),
    ...(posttradeFeedback.ok ? [] : ['posttrade_feedback_attention']),
    ...(validation.ok || prediction.ok ? [] : []),
  ];
  const baseReport = {
    ok: blockers.length === 0,
    checkedAt: new Date().toISOString(),
    status: blockers.length === 0 ? 'luna_l5_operating' : 'luna_l5_attention',
    nextAction: nextAction({ validation, prediction, entryTrigger, tradeReconciliation, finalGate, phaseActivation, posttradeFeedback }),
    blockers,
    killSwitches: Object.fromEntries(Object.entries(readiness.G1_killSwitches || {}).map(([key, value]) => [key, value?.effectiveHint ?? null])),
    mapek: {
      ok: mapek.ok,
      warnings: mapek.warnings || [],
      observations: mapek.observations || [],
      latestStatus: mapek.readiness?.latestAutopilotStatus || null,
      latestAt: mapek.readiness?.latestAutopilotAt || null,
      hardFailureCount: mapek.bottleneck?.dispatch?.hardFailureCount ?? null,
      historicalHardFailureCount: mapek.bottleneck?.dispatch?.historicalHardFailureCount ?? null,
      cleanStreakSamples: mapek.bottleneck?.dispatch?.cleanStreakSamples ?? null,
      staleCandidateCount: mapek.bottleneck?.dispatch?.staleCandidateCount ?? null,
    },
    validation: {
      ok: validation.ok,
      status: validation.status,
      blockers: validation.blockers || [],
      commands: validation.commands || [],
    },
    prediction: {
      ok: prediction.ok,
      status: prediction.status,
      blockers: prediction.blockers || [],
      commands: prediction.commands || [],
      predictiveSmoke: prediction.predictiveSmoke || null,
    },
    entryTrigger: {
      ok: entryTrigger.ok,
      status: entryTrigger.status,
      warnings: entryTrigger.warnings || [],
      activeCount: entryTrigger.stats?.activeCount ?? null,
      duplicateFiredScopeCount: entryTrigger.stats?.duplicateFiredScopeCount ?? null,
      heartbeatAgeMinutes: entryTrigger.heartbeat?.ageMinutes ?? null,
    },
    tradeReconciliation: {
      ok: tradeReconciliation.ok,
      status: tradeReconciliation.status,
      blockers: tradeReconciliation.blockers || [],
      summary: tradeReconciliation.summary || {},
      topRows: tradeReconciliation.topRows || [],
    },
    finalGate: {
      ok: finalGate.ok,
      status: finalGate.status,
      blockers: finalGate.blockers || [],
      warnings: finalGate.warnings || [],
      nextAction: finalGate.nextAction || null,
    },
    phaseActivation: {
      ok: phaseActivation.ok || phaseActivationComplete,
      status: phaseActivationStatus,
      nextPhase: phaseActivation.steps?.[0]?.phase || null,
      nextSmokeCommands: phaseActivation.nextSmokeCommands || [],
      blockers: phaseActivationComplete ? [] : (phaseActivation.blockers || []),
    },
    posttradeFeedback: {
      ok: posttradeFeedback.ok === true,
      status: posttradeFeedback.status || 'unknown',
      nextAction: posttradeFeedback.nextAction || null,
      blockers: posttradeFeedback.blockers || [],
      config: posttradeFeedback.config || {},
      launchd: posttradeFeedback.launchd || null,
      actionStaging: posttradeFeedback.actionStaging || null,
    },
    readinessWarnings: readiness.warnings || [],
  };
  const liveFireGate = evaluateLunaLiveFireReadinessGate({ operating: baseReport, worker: entryTrigger });
  return {
    ...baseReport,
    liveFireGate,
  };
}

export function renderLunaL5OperatingReport(report = {}) {
  return [
    '🌙 Luna L5 operating report',
    `status: ${report.status || 'unknown'} / next=${report.nextAction || 'unknown'}`,
    `kill-switch: V2=${report.killSwitches?.LUNA_V2_ENABLED || 'unset'} / MAPEK=${report.killSwitches?.LUNA_MAPEK_ENABLED || 'unset'} / validation=${report.killSwitches?.LUNA_VALIDATION_ENABLED || 'unset'} / prediction=${report.killSwitches?.LUNA_PREDICTION_ENABLED || 'unset'}`,
    `MAPE-K: ok=${report.mapek?.ok === true} / clean=${report.mapek?.cleanStreakSamples ?? 'n/a'} / hard=${report.mapek?.hardFailureCount ?? 'n/a'} / stale=${report.mapek?.staleCandidateCount ?? 'n/a'}`,
    `validation: ${report.validation?.status || 'unknown'} / blockers=${(report.validation?.blockers || []).length}`,
    `prediction: ${report.prediction?.status || 'unknown'} / blockers=${(report.prediction?.blockers || []).length}`,
    `entry-trigger: ${report.entryTrigger?.status || 'unknown'} / active=${report.entryTrigger?.activeCount ?? 'n/a'} / dup-fired=${report.entryTrigger?.duplicateFiredScopeCount ?? 'n/a'} / heartbeat=${report.entryTrigger?.heartbeatAgeMinutes ?? 'n/a'}m`,
    `trade-reconcile: ${report.tradeReconciliation?.status || 'unknown'} / blockers=${(report.tradeReconciliation?.blockers || []).length} / pending=${report.tradeReconciliation?.summary?.pendingReconcile ?? 'n/a'} / hard=${report.tradeReconciliation?.summary?.hardReconcile ?? 'n/a'}`,
    `final-gate: ${report.finalGate?.status || 'unknown'} / blockers=${(report.finalGate?.blockers || []).length}`,
    `next-phase: ${report.phaseActivation?.nextPhase || 'none'}`,
    `posttrade: ${report.posttradeFeedback?.status || 'unknown'} / worker=${report.posttradeFeedback?.config?.workerEnabled === true} / blockers=${(report.posttradeFeedback?.blockers || []).length} / actionPatches=${report.posttradeFeedback?.actionStaging?.patchCount ?? 'n/a'}`,
    `live-fire gate: ${report.liveFireGate?.status || 'unknown'} / blockers=${(report.liveFireGate?.blockers || []).length}`,
  ].join('\n');
}

export async function publishLunaL5OperatingReport(report = {}) {
  return publishAlert({
    from_bot: 'luna',
    event_type: 'report',
    alert_level: report.ok ? 1 : 2,
    message: renderLunaL5OperatingReport(report),
    payload: {
      checkedAt: report.checkedAt,
      status: report.status,
      nextAction: report.nextAction,
      killSwitches: report.killSwitches,
      mapek: report.mapek,
      validation: report.validation,
      prediction: report.prediction,
      entryTrigger: report.entryTrigger,
      tradeReconciliation: report.tradeReconciliation,
      finalGate: report.finalGate,
      phaseActivation: report.phaseActivation,
      posttradeFeedback: report.posttradeFeedback,
      liveFireGate: report.liveFireGate,
    },
  });
}

export async function runLunaL5OperatingReportSmoke() {
  const report = await buildLunaL5OperatingReport({ hours: 24 });
  assert.ok(report.checkedAt);
  assert.ok(report.mapek);
  assert.ok(report.validation);
  assert.ok(report.prediction);
  assert.ok(report.entryTrigger);
  assert.ok(report.tradeReconciliation);
  assert.ok(report.finalGate);
  assert.ok(report.phaseActivation);
  assert.ok(report.posttradeFeedback);
  assert.ok(report.liveFireGate);
  assert.ok(renderLunaL5OperatingReport(report).includes('Luna L5 operating report'));
  return report;
}

async function main() {
  const json = process.argv.includes('--json');
  const telegram = process.argv.includes('--telegram');
  const report = await buildLunaL5OperatingReport();
  if (telegram) await publishLunaL5OperatingReport(report);
  if (json) console.log(JSON.stringify(report, null, 2));
  else if (!telegram) console.log(renderLunaL5OperatingReport(report));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna L5 operating report 실패:',
  });
}
