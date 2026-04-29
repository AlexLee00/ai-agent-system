#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import { resolvePositionLifecycleFlags } from '../shared/position-lifecycle-flags.ts';
import {
  buildAutonomousOperationalGate,
  buildLifecycleCutoverGate,
  buildLunaL5AlarmPayload,
  buildLunaL5FinalGate,
  buildPositionSyncFinalGate,
  buildSupervisedWarmupGate,
  normalizeLifecycleMode,
  normalizeMarketList,
} from '../shared/luna-l5-operational-gate.ts';
import { appendLunaL5TransitionHistory } from '../shared/luna-l5-transition-history.ts';
import { runPositionLifecycleOperationalReadiness } from './runtime-position-lifecycle-operational-readiness.ts';
import { runPositionExecutePreflightDrill } from './runtime-position-execute-preflight-drill.ts';
import { runPositionSyncFinalGate } from './runtime-position-sync-final-gate.ts';
import { buildLunaL5ConfigDoctor } from './luna-l5-config-doctor.ts';
import { buildHephaestosRefactorReport } from './hephaestos-refactor-candidate-report.ts';
import { buildAutopilotBottleneckReport } from './runtime-position-runtime-autopilot-bottleneck-report.ts';
import { buildLunaManualReconcilePlaybook } from './luna-manual-reconcile-playbook.ts';
import { buildRuntimePositionStrategyAudit } from './runtime-position-strategy-audit.ts';

function parseArgs(argv = []) {
  const args = {
    json: false,
    telegram: false,
    targetMode: null,
    sync: false,
    requirePositionSync: false,
    markets: ['domestic', 'overseas', 'crypto'],
    limit: 5,
    warmupHours: 24,
    warmupSamples: 3,
    maxPositionSyncAgeMinutes: 30,
  };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--telegram') args.telegram = true;
    else if (raw === '--sync') args.sync = true;
    else if (raw === '--require-position-sync') args.requirePositionSync = true;
    else if (raw.startsWith('--target=')) args.targetMode = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--markets=')) args.markets = normalizeMarketList(raw.split('=').slice(1).join('=') || 'all');
    else if (raw.startsWith('--limit=')) args.limit = Math.max(1, Number(raw.split('=').slice(1).join('=') || 5));
    else if (raw.startsWith('--warmup-hours=')) args.warmupHours = Math.max(1, Number(raw.split('=').slice(1).join('=') || 24));
    else if (raw.startsWith('--warmup-samples=')) args.warmupSamples = Math.max(1, Number(raw.split('=').slice(1).join('=') || 3));
    else if (raw.startsWith('--max-position-sync-age-minutes=')) args.maxPositionSyncAgeMinutes = Math.max(1, Number(raw.split('=').slice(1).join('=') || 30));
  }
  return args;
}

export async function buildLunaL5FinalGateReport(args = {}) {
  const markets = normalizeMarketList(args.markets || ['domestic', 'overseas', 'crypto']);
  const flags = resolvePositionLifecycleFlags();
  const targetMode = normalizeLifecycleMode(args.targetMode || flags.mode || 'supervised_l4');
  const syncRequired = args.sync === true || args.requirePositionSync === true || targetMode === 'autonomous_l5' || flags.mode === 'autonomous_l5';
  const [readinessReport, preflightReport, syncReport] = await Promise.all([
    runPositionLifecycleOperationalReadiness({
      json: true,
      sync: syncRequired,
      requirePositionSync: syncRequired,
      markets,
      limit: Math.max(args.limit || 5, 50),
    }),
    runPositionExecutePreflightDrill({
      json: true,
      limit: args.limit || 5,
      requirePositionSync: syncRequired,
      markets,
    }),
    syncRequired
      ? runPositionSyncFinalGate({ markets, requireAllMarkets: true })
      : Promise.resolve(null),
  ]);

  const positionSyncGate = syncReport?.gate || buildPositionSyncFinalGate({
    syncSummary: readinessReport.positionSyncSummary || null,
    requiredMarkets: markets,
  });
  const configDoctor = buildLunaL5ConfigDoctor({
    flags,
    targetMode,
  });
  const executePreflight = preflightReport.drill;
  const bottleneck = buildAutopilotBottleneckReport({ hours: args.warmupHours || 24 });
  const [manualReconcilePlaybook, positionStrategyAudit] = targetMode === 'autonomous_l5'
    ? await Promise.all([
      buildLunaManualReconcilePlaybook({ exchange: 'binance', hours: 24, limit: 100 }).catch((error) => ({
        ok: false,
        status: 'manual_reconcile_playbook_failed',
        summary: { tasks: 1 },
        blockers: [`manual_reconcile_playbook_failed:${error?.message || String(error)}`],
      })),
      buildRuntimePositionStrategyAudit({ json: true }).catch((error) => ({
        ok: false,
        status: 'position_strategy_audit_failed',
        dustProfiles: 1,
        duplicateManagedProfileScopes: 0,
        unmatchedManagedPositions: 0,
        error: error?.message || String(error),
      })),
    ])
    : [null, null];
  const supervisedWarmupGate = buildSupervisedWarmupGate({
    targetMode,
    currentFlags: flags,
    bottleneck,
    minSamples: args.warmupSamples || 3,
    minCleanSamples: args.warmupSamples || 3,
  });
  const autonomousOperationalGate = buildAutonomousOperationalGate({
    targetMode,
    positionSyncGate: syncRequired ? positionSyncGate : null,
    manualReconcilePlaybook,
    positionStrategyAudit,
    bottleneck,
    maxPositionSyncAgeMinutes: args.maxPositionSyncAgeMinutes || 30,
  });
  const cutoverGate = buildLifecycleCutoverGate({
    targetMode,
    currentFlags: flags,
    readiness: readinessReport.readiness,
    positionSyncGate: syncRequired ? positionSyncGate : null,
    executePreflight,
    configDoctor,
    supervisedWarmupGate,
    autonomousOperationalGate,
  });
  const hephaestosRefactor = await buildHephaestosRefactorReport({ maxCandidates: 8 }).catch((error) => ({
    ok: false,
    status: 'hephaestos_refactor_report_failed',
    warnings: [`hephaestos_refactor_report_failed:${error?.message || String(error)}`],
  }));

  return buildLunaL5FinalGate({
    cutoverGate,
    positionSyncGate: syncRequired ? positionSyncGate : null,
    executePreflight,
    configDoctor,
    hephaestosRefactor,
    supervisedWarmupGate,
    autonomousOperationalGate,
  });
}

export function renderLunaL5FinalGate(report = {}) {
  return [
    '🌙 Luna L5 final gate',
    `status: ${report.status || 'unknown'}`,
    `blockers: ${(report.blockers || []).join(' / ') || 'none'}`,
    `warnings: ${(report.warnings || []).slice(0, 8).join(' / ') || 'none'}`,
    `cutover: ${report.cutoverGate?.status || 'n/a'}`,
    `sync: ${report.positionSyncGate?.status || 'not-required'}`,
    `preflight: ${report.executePreflight?.status || 'n/a'}`,
    `warmup: ${report.supervisedWarmupGate?.status || report.cutoverGate?.supervisedWarmupGate?.status || 'not-required'}`,
    `autonomous-ops: ${report.autonomousOperationalGate?.status || 'not-required'}`,
    `config: ${report.configDoctor?.status || 'n/a'}`,
    `next: ${report.nextAction || 'unknown'}`,
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await buildLunaL5FinalGateReport(args);
  appendLunaL5TransitionHistory({
    eventType: 'luna_l5_final_gate',
    status: report.status,
    ok: report.ok,
    targetMode: normalizeLifecycleMode(args.targetMode || resolvePositionLifecycleFlags().mode || 'supervised_l4'),
    blockers: report.blockers || [],
    warnings: report.warnings || [],
    nextAction: report.nextAction,
  });
  if (args.telegram) await publishAlert(buildLunaL5AlarmPayload(report));
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderLunaL5FinalGate(report));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: main,
    errorPrefix: '❌ luna-l5-final-gate 실패:',
  });
}
