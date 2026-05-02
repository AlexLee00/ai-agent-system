#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaReconcileBlockerReport } from './luna-reconcile-blocker-report.ts';
import { buildLunaLiveFireFinalGate } from './luna-live-fire-final-gate.ts';
import { runLuna7DayReport } from './runtime-luna-7day-report.ts';
import { runLuna100PercentCompletionReport } from './runtime-luna-100-percent-completion-report.ts';
import { buildPosttradeFeedbackL5Gate } from './runtime-posttrade-feedback-l5-gate.ts';
import { buildAgentMemoryDashboard } from './runtime-agent-memory-dashboard.ts';
import { runAgentMessageBusHygiene } from './runtime-agent-message-bus-hygiene.ts';
import { runVoyagerSkillAutoExtractionVerify } from './voyager-skill-auto-extraction-verify.ts';
import { buildLunaOperationalClosurePackFromReports } from '../shared/luna-operational-closure-pack.ts';
import { buildLunaReconcileEvidencePack } from './runtime-luna-reconcile-evidence-pack.ts';
import { buildLunaReconcileAckPreflight } from './luna-reconcile-ack-preflight.ts';
import { runLunaCurriculumBootstrap } from './runtime-luna-curriculum-bootstrap.ts';

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function uniq(items = []) {
  return [...new Set(items.filter(Boolean).map((item) => String(item)))];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSettleableLiveFireBlocker(liveFire = {}) {
  if (liveFire?.ok !== false) return false;
  const blockers = (liveFire.blockers || []).map((item) => String(item || ''));
  return blockers.some((item) =>
    item.startsWith('post_live_fire_attention:') ||
    item.startsWith('live_fire_readiness_blocked:'));
}

function blockerFromReconcile(report = {}) {
  const blockers = [];
  for (const item of report.blockers || []) {
    if (item.acked === true || item.severity === 'acknowledged') continue;
    if (item.severity === 'hard_block' || item.resolutionClass === 'pending_without_lookup_key') {
      blockers.push(`reconcile:${item.symbol || item.id}:${item.resolutionClass || item.blockCode}`);
    }
  }
  if (report.status === 'reconcile_blocker_query_failed') blockers.push('reconcile:query_failed');
  return blockers;
}

function warningFromMemory(readiness = {}) {
  return (readiness.warnings || []).map((warning) => `agent_memory:${warning}`);
}

function pendingFrom7Day(report = {}) {
  return (report.pendingReasons || []).map((reason) => `7day:${reason}`);
}

function pendingFrom100(report = {}) {
  return (report.pendingObservation || report.outstandingTasks || []).map((reason) => `100_percent:${reason}`);
}

function buildNextActions({ hardBlockers = [], warnings = [], pendingObservation = [], evidence = {} } = {}) {
  const actions = [];
  if (hardBlockers.some((item) => item.startsWith('reconcile:'))) {
    actions.push('run luna-reconcile-blocker-report, complete manual reconcile/ack evidence, then rerun closure gate');
  }
  if (hardBlockers.some((item) => item.startsWith('live_fire:'))) {
    actions.push(evidence.liveFire?.nextAction || 'resolve live-fire final gate blockers');
  }
  if (warnings.some((item) => item.includes('stale_bus_messages'))) {
    actions.push('run runtime:agent-message-bus-hygiene -- --dry-run, then apply only with --apply --confirm=luna-agent-bus-hygiene');
  }
  if (warnings.some((item) => item.includes('curriculum_bootstrap_required'))) {
    actions.push('run runtime:luna-curriculum-bootstrap dry-run, then apply only with --confirm=luna-curriculum-bootstrap');
  }
  if (pendingObservation.some((item) => item.includes('skills'))) {
    actions.push('wait for natural close-cycle reflexions or run Voyager validation fixture without promoting production skill');
  }
  if (pendingObservation.some((item) => item.includes('7day') || item.includes('fired') || item.includes('reflexion'))) {
    actions.push('continue natural 7-day observation; do not mark operational complete until criteria pass');
  }
  if (actions.length === 0) actions.push('operational closure gate clear; keep live cutover behind separate master approval');
  return uniq(actions);
}

export function buildLunaFullIntegrationClosureGateFromReports({
  fullIntegration = {},
  reconcile = {},
  liveFire = {},
  sevenDay = {},
  posttrade = {},
  memory = {},
  busHygiene = {},
  voyager = {},
  reconcileEvidence = {},
  ackPreflight = {},
  curriculum = {},
} = {}) {
  const hardBlockers = [
    ...blockerFromReconcile(reconcile),
    ...(liveFire.ok === false ? (liveFire.blockers || ['live_fire:blocked']).map((item) => `live_fire:${item}`) : []),
    ...(posttrade.ok === false ? (posttrade.blockers || ['posttrade_l5_blocked']).map((item) => `posttrade:${item}`) : []),
    ...(memory.readiness?.blockers || []).map((item) => `agent_memory:${item}`),
    ...(busHygiene.ok === false ? ['agent_message_bus_hygiene:query_failed'] : []),
  ];
  const warnings = [
    ...warningFromMemory(memory.readiness || {}),
    ...(busHygiene.before?.staleCount > 0 ? [`agent_message_bus_hygiene:stale:${busHygiene.before.staleCount}`] : []),
    ...(voyager.validationFixture?.fixtureUsed ? ['voyager_validation_fixture_used:not_production_skill'] : []),
    ...(curriculum.toCreate > 0 ? [`curriculum_bootstrap_required:${curriculum.toCreate}`] : []),
  ];
  const pendingObservation = [
    ...pendingFrom7Day(sevenDay),
    ...pendingFrom100(fullIntegration),
    ...(voyager.pendingReason ? [`voyager:${voyager.pendingReason}`] : []),
  ];
  const codeComplete = fullIntegration.codeComplete !== false;
  const ok = hardBlockers.length === 0 && pendingObservation.length === 0;
  const operationalStatus = hardBlockers.length > 0
    ? 'code_complete_operational_blocked'
    : pendingObservation.length > 0
      ? 'code_complete_operational_pending'
      : 'operational_complete';
  const evidence = {
    fullIntegration: {
      codeComplete,
      passed: fullIntegration.passed === true,
      operationalStatus: fullIntegration.operationalStatus || null,
      outstandingTasks: fullIntegration.outstandingTasks || [],
    },
    reconcile: {
      status: reconcile.status || null,
      summary: reconcile.summary || {},
      acknowledgedAuditOnly: Number(reconcile.summary?.acknowledged || 0),
    },
    liveFire: {
      status: liveFire.status || null,
      blockers: liveFire.blockers || [],
      nextAction: liveFire.operatingSummary?.nextAction || null,
      settledFrom: liveFire.settledFrom || null,
    },
    sevenDay: {
      status: sevenDay.status || null,
      criteria: sevenDay.criteria || {},
      pendingReasons: sevenDay.pendingReasons || [],
    },
    posttrade: {
      status: posttrade.status || null,
      blockers: posttrade.blockers || [],
    },
    memory: {
      status: memory.status || null,
      readiness: memory.readiness || {},
    },
    busHygiene: {
      status: busHygiene.status || null,
      staleCount: busHygiene.before?.staleCount ?? busHygiene.staleCount ?? 0,
      dryRun: busHygiene.action?.dryRun ?? true,
      classification: busHygiene.plan?.[0]?.classification || null,
    },
    voyager: {
      status: voyager.status || null,
      naturalDataReady: voyager.naturalDataReady ?? voyager.readyForExtraction ?? false,
      fixtureUsed: voyager.validationFixture?.fixtureUsed === true,
      productionSkillPromoted: voyager.productionSkillPromoted === true,
    },
    reconcileEvidence: {
      status: reconcileEvidence.status || null,
      summary: reconcileEvidence.summary || {},
    },
    ackPreflight: {
      status: ackPreflight.status || null,
      liveLookup: ackPreflight.liveLookup === true,
      summary: ackPreflight.summary || {},
    },
    curriculum: {
      status: curriculum.status || null,
      toCreate: Number(curriculum.toCreate || 0),
      dryRun: curriculum.dryRun !== false,
    },
  };
  const result = {
    ok,
    codeComplete,
    operationalStatus,
    hardBlockers: uniq(hardBlockers),
    warnings: uniq(warnings),
    pendingObservation: uniq(pendingObservation),
    nextActions: buildNextActions({ hardBlockers, warnings, pendingObservation, evidence }),
    evidence,
  };
  result.evidence.operationalPack = buildLunaOperationalClosurePackFromReports({
    closure: result,
    reconcile,
    liveFire,
    sevenDay,
    fullIntegration,
    busHygiene,
    voyager,
    curriculum,
    reconcileEvidence,
    ackPreflight,
  });
  return result;
}

export async function buildLunaFullIntegrationClosureGate({
  exchange = 'binance',
  hours = 24,
  days = 7,
  includeValidationFixture = false,
  settleLiveFire = true,
  settleDelayMs = 1500,
} = {}) {
  const [fullIntegration, reconcile, initialLiveFire, sevenDay, posttrade, memory, busHygiene, voyager, reconcileEvidence, ackPreflight, curriculum] = await Promise.all([
    runLuna100PercentCompletionReport({ outputFile: null }),
    buildLunaReconcileBlockerReport({ exchange, hours }),
    buildLunaLiveFireFinalGate({ exchange, hours: Math.min(hours, 24), liveLookup: false, withPositionParity: true }),
    runLuna7DayReport({ days }),
    buildPosttradeFeedbackL5Gate({ strict: false }).catch((error) => ({
      ok: false,
      status: 'posttrade_l5_gate_failed',
      blockers: [`posttrade_error:${error?.message || String(error)}`],
    })),
    buildAgentMemoryDashboard({ days, market: 'all' }).catch((error) => ({
      ok: false,
      status: 'agent_memory_dashboard_failed',
      readiness: { blockers: [`dashboard_error:${error?.message || String(error)}`], warnings: [] },
    })),
    runAgentMessageBusHygiene({ staleHours: 6, limit: 100, apply: false, dryRun: true }),
    runVoyagerSkillAutoExtractionVerify({ validationFixture: includeValidationFixture }),
    buildLunaReconcileEvidencePack({ exchange, hours, limit: 100 }),
    buildLunaReconcileAckPreflight({ exchange, hours, limit: 100, liveLookup: false }),
    runLunaCurriculumBootstrap({ market: 'any', apply: false }),
  ]);
  let liveFire = initialLiveFire;
  if (settleLiveFire && isSettleableLiveFireBlocker(initialLiveFire)) {
    if (settleDelayMs > 0) await sleep(settleDelayMs);
    const retried = await buildLunaLiveFireFinalGate({
      exchange,
      hours: Math.min(hours, 24),
      liveLookup: false,
      withPositionParity: true,
    });
    liveFire = retried.ok === true
      ? {
        ...retried,
        settledFrom: {
          status: initialLiveFire.status || null,
          blockers: initialLiveFire.blockers || [],
          checkedAt: initialLiveFire.checkedAt || null,
        },
      }
      : {
        ...retried,
        settledFrom: {
          status: initialLiveFire.status || null,
          blockers: initialLiveFire.blockers || [],
          checkedAt: initialLiveFire.checkedAt || null,
        },
      };
  }
  return buildLunaFullIntegrationClosureGateFromReports({
    fullIntegration,
    reconcile,
    liveFire,
    sevenDay,
    posttrade,
    memory,
    busHygiene,
    voyager,
    reconcileEvidence,
    ackPreflight,
    curriculum,
  });
}

export async function runLunaFullIntegrationClosureGateSmoke() {
  const clear = buildLunaFullIntegrationClosureGateFromReports({
    fullIntegration: { codeComplete: true, passed: true, pendingObservation: [], outstandingTasks: [] },
    reconcile: { ok: true, status: 'reconcile_blockers_clear', summary: { total: 0, hard: 0, acknowledged: 0 }, blockers: [] },
    liveFire: { ok: true, status: 'luna_live_fire_final_gate_clear', blockers: [], operatingSummary: { nextAction: 'enable_live_fire_cutover' } },
    sevenDay: { status: 'complete', pendingReasons: [], criteria: { fired5: true, reflexions5: true, skills1: true, smokeReg0: true } },
    posttrade: { ok: true, status: 'posttrade_l5_gate_clear', blockers: [] },
    memory: { status: 'agent_memory_dashboard_ready', readiness: { blockers: [], warnings: [] } },
    busHygiene: { ok: true, status: 'agent_message_bus_hygiene_clear', before: { staleCount: 0 }, action: { dryRun: true } },
    voyager: { status: 'ready_for_extraction', naturalDataReady: true, readyForExtraction: true },
    reconcileEvidence: { status: 'reconcile_evidence_clear', summary: { manualReconcileRequired: 0, manualAckRequired: 0 } },
    ackPreflight: { status: 'ack_preflight_no_candidates', liveLookup: false, summary: { candidates: 0 } },
    curriculum: { status: 'curriculum_bootstrap_already_seeded', toCreate: 0, dryRun: true },
  });
  assert.equal(clear.ok, true);
  assert.equal(clear.operationalStatus, 'operational_complete');

  const blocked = buildLunaFullIntegrationClosureGateFromReports({
    fullIntegration: {
      codeComplete: true,
      passed: false,
      pendingObservation: ['reflexion_memory 4/5건', 'skill_library 0건'],
      outstandingTasks: ['reflexion_memory 4/5건', 'skill_library 0건'],
    },
    reconcile: {
      ok: false,
      status: 'reconcile_blockers_present',
      summary: { total: 2, hard: 1, acknowledged: 1 },
      blockers: [
        { id: 'sig-1', symbol: 'ORCA/USDT', severity: 'hard_block', resolutionClass: 'manual_reconcile_required', acked: false },
        { id: 'sig-2', symbol: 'BTC/USDT', severity: 'acknowledged', resolutionClass: 'acknowledged', acked: true },
      ],
    },
    liveFire: { ok: false, status: 'luna_live_fire_final_gate_blocked', blockers: ['manual_reconcile_tasks:1'], operatingSummary: { nextAction: 'complete_manual_wallet_journal_position_reconcile' } },
    sevenDay: { status: 'pending_observation', pendingReasons: ['fired 1/5'], criteria: { fired5: false } },
    posttrade: { ok: true, status: 'posttrade_l5_gate_clear', blockers: [] },
    memory: { status: 'agent_memory_dashboard_attention', readiness: { blockers: [], warnings: ['stale_bus_messages_3'] } },
    busHygiene: { ok: true, status: 'agent_message_bus_hygiene_clear', before: { staleCount: 3 }, action: { dryRun: true } },
    voyager: { status: 'pending_observation', naturalDataReady: false, pendingReason: 'insufficient_natural_data: reflexion 4/5', validationFixture: { fixtureUsed: true } },
    reconcileEvidence: { status: 'reconcile_evidence_required', summary: { manualReconcileRequired: 1, manualAckRequired: 0 } },
    ackPreflight: { status: 'ack_preflight_requires_exchange_lookup', liveLookup: false, summary: { candidates: 0 } },
    curriculum: { status: 'curriculum_bootstrap_plan_ready', toCreate: 2, dryRun: true },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.operationalStatus, 'code_complete_operational_blocked');
  assert.ok(blocked.hardBlockers.some((item) => item.includes('reconcile:ORCA/USDT')));
  assert.ok(blocked.hardBlockers.some((item) => item.includes('live_fire:manual_reconcile_tasks:1')));
  assert.ok(blocked.warnings.some((item) => item.includes('stale_bus_messages')));
  assert.ok(blocked.warnings.some((item) => item.includes('curriculum_bootstrap_required')));
  assert.ok(blocked.pendingObservation.some((item) => item.includes('7day')));
  return { ok: true, clear, blocked };
}

async function main() {
  const json = hasFlag('--json');
  const smoke = hasFlag('--smoke');
  const result = smoke
    ? await runLunaFullIntegrationClosureGateSmoke()
    : await buildLunaFullIntegrationClosureGate({
      exchange: argValue('--exchange', 'binance'),
      hours: Number(argValue('--hours', 24)),
      days: Number(argValue('--days', 7)),
      includeValidationFixture: hasFlag('--validation-fixture'),
      settleLiveFire: !hasFlag('--no-live-fire-settle'),
      settleDelayMs: Number(argValue('--live-fire-settle-delay-ms', 1500)),
    });
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (smoke) console.log('luna full integration closure gate smoke ok');
  else {
    console.log(`${result.operationalStatus} ok=${result.ok}`);
    console.log(`hardBlockers=${result.hardBlockers.join(',') || 'none'}`);
    console.log(`pending=${result.pendingObservation.join(' | ') || 'none'}`);
    console.log(`next=${result.nextActions[0] || 'none'}`);
  }
  if (!smoke && hasFlag('--fail-on-blocked') && result.ok !== true) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna full integration closure gate 실패:',
  });
}
