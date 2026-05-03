#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { inspectLaunchdList, inspectLaunchdPrint } from '../shared/launchd-service.ts';
import { buildLunaFullIntegrationClosureGate } from './runtime-luna-full-integration-closure-gate.ts';
import { buildLunaLiveFireFinalGate } from './luna-live-fire-final-gate.ts';

export const PROTECTED_LIVE_FIRE_SERVICES = [
  'ai.luna.tradingview-ws',
  'ai.investment.commander',
  'ai.elixir.supervisor',
  'ai.luna.marketdata-mcp',
  'ai.claude.auto-dev.autonomous',
  'ai.hub.resource-api',
];

const LIVE_CUTOVER_APPLY_COMMAND = 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-live-fire-cutover -- --apply --confirm=enable-luna-live-fire --json';
const LIVE_CUTOVER_WATCHDOG_COMMAND = 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-live-fire-watchdog -- --json';

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

function hasPid(value) {
  const pid = Number(value);
  return Number.isFinite(pid) && pid > 0;
}

function errorMessage(error) {
  return error?.message || String(error);
}

function classifyProtectedService(label, listStatus = {}, printStatus = {}) {
  const loaded = listStatus.loaded === true || printStatus.loaded === true;
  const running = hasPid(listStatus.pid) || hasPid(printStatus.pid);
  const pid = hasPid(listStatus.pid) ? Number(listStatus.pid) : (hasPid(printStatus.pid) ? Number(printStatus.pid) : null);
  const blockers = [];
  const warnings = [];
  const lastExit = listStatus.lastExitStatus ?? printStatus.lastExitCode ?? null;

  if (!loaded) blockers.push('protected_service_not_loaded');
  if (!running) blockers.push('protected_pid_missing');
  const intentionalRestartTrace = running && [-15, -9].includes(Number(lastExit));
  if (lastExit != null && Number(lastExit) !== 0 && !intentionalRestartTrace) warnings.push(`previous_exit_status_${lastExit}`);

  return {
    label,
    ok: blockers.length === 0,
    loaded,
    running,
    pid,
    lastExitStatus: lastExit,
    blockers,
    warnings,
    list: listStatus,
    print: printStatus,
  };
}

export function inspectProtectedLiveFireServices({ labels = PROTECTED_LIVE_FIRE_SERVICES } = {}) {
  return labels.map((label) => classifyProtectedService(
    label,
    inspectLaunchdList(label),
    inspectLaunchdPrint(label),
  ));
}

function summarizeProtectedServices(services = []) {
  return {
    total: services.length,
    loaded: services.filter((service) => service.loaded === true).length,
    running: services.filter((service) => service.running === true).length,
    blocked: services.filter((service) => service.ok !== true).length,
  };
}

function checklistItem(key, ok, status, details = {}) {
  return {
    key,
    ok: ok === true,
    status: status || (ok ? 'clear' : 'blocked'),
    ...details,
  };
}

function buildChecklist({ closure = {}, finalGate = {}, protectedServices = [] } = {}) {
  const preflight = finalGate.preflight || {};
  const parity = preflight.parity || {};
  const killSwitch = finalGate.killSwitch || {};
  const protectedSummary = summarizeProtectedServices(protectedServices);
  const closureHardBlockers = closure.hardBlockers || [];
  const closureHasHardBlockers = closureHardBlockers.length > 0 || closure.operationalStatus === 'code_complete_operational_blocked';
  return [
    checklistItem(
      'closure_gate',
      !closureHasHardBlockers,
      closure.operationalStatus || 'unknown',
      {
        hardBlockers: closureHardBlockers,
        pendingObservation: closure.pendingObservation || [],
      },
    ),
    checklistItem(
      'live_fire_final_gate',
      finalGate.ok === true,
      finalGate.status || 'unknown',
      { blockers: finalGate.blockers || [] },
    ),
    checklistItem(
      'position_parity',
      parity.clear === true,
      parity.skipped ? 'position_parity_skipped' : (parity.clear === true ? 'position_parity_clear' : 'position_parity_not_clear'),
      { summary: parity.summary || null },
    ),
    checklistItem(
      'kill_switch_consistency',
      killSwitch.ok === true,
      killSwitch.status || 'unknown',
      { blockers: killSwitch.blockers || [] },
    ),
    checklistItem(
      'protected_pid_visibility',
      protectedServices.length > 0 && protectedServices.every((service) => service.ok === true),
      protectedServices.length > 0 && protectedServices.every((service) => service.ok === true)
        ? 'protected_services_running'
        : 'protected_services_attention',
      { summary: protectedSummary },
    ),
    checklistItem(
      'approval_boundary',
      true,
      'separate_master_approval_required',
      {
        applyAllowed: false,
        mutationExecuted: false,
      },
    ),
  ];
}

function blockersFromChecklist(checklist = [], protectedServices = []) {
  const blockers = [];
  for (const item of checklist || []) {
    if (item.ok === true) continue;
    if (item.key === 'closure_gate') {
      blockers.push(...(item.hardBlockers || []).map((blocker) => `closure:${blocker}`));
      if ((item.hardBlockers || []).length === 0) blockers.push(`closure:${item.status}`);
    } else if (item.key === 'live_fire_final_gate') {
      blockers.push(...(item.blockers || []).map((blocker) => `live_fire:${blocker}`));
      if ((item.blockers || []).length === 0) blockers.push(`live_fire:${item.status}`);
    } else if (item.key === 'position_parity') {
      blockers.push('position_parity_not_clear');
    } else if (item.key === 'kill_switch_consistency') {
      blockers.push(...(item.blockers || []).map((blocker) => `kill_switch:${blocker}`));
      if ((item.blockers || []).length === 0) blockers.push(`kill_switch:${item.status}`);
    }
  }
  for (const service of protectedServices || []) {
    for (const blocker of service.blockers || []) {
      blockers.push(`protected_service:${service.label}:${blocker}`);
    }
  }
  return uniq(blockers);
}

function warningsFromReports({ closure = {}, finalGate = {}, protectedServices = [] } = {}) {
  return uniq([
    ...(closure.warnings || []).map((warning) => `closure:${warning}`),
    ...(finalGate.worker?.warnings || []).map((warning) => `worker:${warning}`),
    ...protectedServices.flatMap((service) => (service.warnings || []).map((warning) => `protected_service:${service.label}:${warning}`)),
  ]);
}

function buildNextActions({ decision, hardBlockers = [], pendingObservation = [] } = {}) {
  if (hardBlockers.length > 0) {
    return [
      'resolve hard blockers before requesting live cutover approval',
      'rerun npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-live-fire-preapproval -- --json',
    ];
  }
  if (pendingObservation.length > 0) {
    return [
      'continue pending operational observation before live cutover approval',
      'rerun Luna closure gate after observation criteria are satisfied',
    ];
  }
  if (decision === 'approval_possible') {
    return [
      'request explicit master approval for live-fire cutover',
      'only after approval, run the apply command shown in commands.cutoverApply',
      'start watchdog immediately after successful cutover apply',
    ];
  }
  return ['rerun preapproval package after resolving status'];
}

export function buildLunaLiveFirePreapprovalPackageFromReports({
  closure = {},
  finalGate = {},
  protectedServices = [],
  checkedAt = new Date().toISOString(),
  exchange = 'binance',
  hours = 24,
  days = 7,
} = {}) {
  const checklist = buildChecklist({ closure, finalGate, protectedServices });
  const hardBlockers = blockersFromChecklist(checklist, protectedServices);
  const pendingObservation = uniq(closure.pendingObservation || []);
  const warnings = warningsFromReports({ closure, finalGate, protectedServices });
  const decision = hardBlockers.length > 0
    ? 'approval_blocked'
    : pendingObservation.length > 0
      ? 'approval_deferred'
      : 'approval_possible';
  const status = decision === 'approval_possible'
    ? 'luna_live_fire_preapproval_ready'
    : decision === 'approval_deferred'
      ? 'luna_live_fire_preapproval_deferred'
      : 'luna_live_fire_preapproval_blocked';

  return {
    ok: decision === 'approval_possible',
    checkedAt,
    exchange,
    hours,
    days,
    decision,
    status,
    approvalRequired: decision === 'approval_possible',
    applyAllowed: false,
    dryRun: true,
    mutationExecuted: false,
    hardBlockers,
    warnings,
    pendingObservation,
    checklist,
    evidence: {
      closure: {
        ok: closure.ok === true,
        operationalStatus: closure.operationalStatus || null,
        hardBlockers: closure.hardBlockers || [],
        warnings: closure.warnings || [],
        pendingObservation: closure.pendingObservation || [],
      },
      liveFireFinalGate: {
        ok: finalGate.ok === true,
        status: finalGate.status || null,
        blockers: finalGate.blockers || [],
        operatingSummary: finalGate.operatingSummary || {},
      },
      cutoverPreflight: {
        ok: finalGate.preflight?.ok === true,
        status: finalGate.preflight?.status || null,
        blockers: finalGate.preflight?.blockers || [],
        parity: finalGate.preflight?.parity || null,
      },
      killSwitch: {
        ok: finalGate.killSwitch?.ok === true,
        status: finalGate.killSwitch?.status || null,
        blockers: finalGate.killSwitch?.blockers || [],
      },
      protectedServices: {
        summary: summarizeProtectedServices(protectedServices),
        services: protectedServices,
      },
      safetyBoundary: {
        liveTradeCommandsExecuted: false,
        cutoverApplied: false,
        reconcileApplied: false,
        cleanupApplied: false,
        launchdChanged: false,
      },
    },
    commands: {
      preapproval: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-live-fire-preapproval -- --json',
      closureGate: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-full-integration-closure-gate -- --json',
      finalGate: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-live-fire-final-gate -- --json',
      cutoverApply: LIVE_CUTOVER_APPLY_COMMAND,
      watchdog: LIVE_CUTOVER_WATCHDOG_COMMAND,
    },
    nextActions: buildNextActions({ decision, hardBlockers, pendingObservation }),
  };
}

export async function buildLunaLiveFirePreapprovalPackage({
  exchange = 'binance',
  hours = 24,
  days = 7,
} = {}) {
  const protectedServices = inspectProtectedLiveFireServices();
  const finalGate = await buildLunaLiveFireFinalGate({ exchange, hours: Math.min(hours, 24), liveLookup: false, withPositionParity: true }).catch((error) => ({
    ok: false,
    status: 'luna_live_fire_final_gate_failed',
    blockers: [`live_fire_final_gate_failed:${errorMessage(error)}`],
    operatingSummary: { nextAction: 'repair_live_fire_final_gate_runtime' },
    preflight: { ok: false, status: 'live_fire_cutover_preflight_failed', blockers: ['live_fire_final_gate_failed'], parity: { clear: null } },
    killSwitch: { ok: false, status: 'kill_switch_consistency_unknown', blockers: ['live_fire_final_gate_failed'] },
  }));
  const closure = await buildLunaFullIntegrationClosureGate({
    exchange,
    hours,
    days,
    settleLiveFire: true,
    liveFireOverride: finalGate,
  }).catch((error) => ({
    ok: false,
    operationalStatus: 'code_complete_operational_blocked',
    hardBlockers: [`closure_gate_failed:${errorMessage(error)}`],
    warnings: [],
    pendingObservation: [],
  }));
  return buildLunaLiveFirePreapprovalPackageFromReports({
    closure,
    finalGate,
    protectedServices,
    exchange,
    hours,
    days,
  });
}

export async function runLunaLiveFirePreapprovalPackageSmoke() {
  const protectedClear = PROTECTED_LIVE_FIRE_SERVICES.map((label, index) => classifyProtectedService(
    label,
    { loaded: true, pid: 1000 + index, lastExitStatus: 0 },
    { loaded: true, pid: 1000 + index, lastExitCode: 0 },
  ));
  const clear = buildLunaLiveFirePreapprovalPackageFromReports({
    closure: { ok: true, operationalStatus: 'operational_complete', hardBlockers: [], warnings: [], pendingObservation: [] },
    finalGate: {
      ok: true,
      status: 'luna_live_fire_final_gate_clear',
      blockers: [],
      operatingSummary: { nextAction: 'enable_live_fire_cutover' },
      preflight: { ok: true, status: 'live_fire_cutover_ready', blockers: [], parity: { clear: true, summary: { quantityMismatch: 0 } } },
      killSwitch: { ok: true, status: 'luna_kill_switch_consistent', blockers: [] },
    },
    protectedServices: protectedClear,
  });
  assert.equal(clear.ok, true);
  assert.equal(clear.decision, 'approval_possible');
  assert.equal(clear.approvalRequired, true);
  assert.equal(clear.applyAllowed, false);
  assert.equal(clear.evidence.safetyBoundary.liveTradeCommandsExecuted, false);

  const blocked = buildLunaLiveFirePreapprovalPackageFromReports({
    closure: { ok: false, operationalStatus: 'code_complete_operational_blocked', hardBlockers: ['reconcile:LUNC/USDT:manual_reconcile_required'], warnings: [], pendingObservation: [] },
    finalGate: {
      ok: false,
      status: 'luna_live_fire_final_gate_blocked',
      blockers: ['manual_reconcile_tasks:1'],
      preflight: { ok: false, status: 'live_fire_cutover_blocked', blockers: ['position_parity_not_clear'], parity: { clear: false } },
      killSwitch: { ok: true, status: 'luna_kill_switch_consistent', blockers: [] },
    },
    protectedServices: [
      ...protectedClear.slice(0, -1),
      classifyProtectedService(PROTECTED_LIVE_FIRE_SERVICES.at(-1), { loaded: true, pid: null }, { loaded: true, pid: null }),
    ],
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.decision, 'approval_blocked');
  assert.ok(blocked.hardBlockers.some((item) => item.includes('closure:reconcile:LUNC/USDT')));
  assert.ok(blocked.hardBlockers.some((item) => item.includes('protected_pid_missing')));

  const deferred = buildLunaLiveFirePreapprovalPackageFromReports({
    closure: { ok: false, operationalStatus: 'code_complete_operational_pending', hardBlockers: [], warnings: [], pendingObservation: ['7day:fired 3/5'] },
    finalGate: {
      ok: true,
      status: 'luna_live_fire_final_gate_clear',
      blockers: [],
      preflight: { ok: true, status: 'live_fire_cutover_ready', blockers: [], parity: { clear: true } },
      killSwitch: { ok: true, status: 'luna_kill_switch_consistent', blockers: [] },
    },
    protectedServices: protectedClear,
  });
  assert.equal(deferred.ok, false);
  assert.equal(deferred.decision, 'approval_deferred');
  assert.ok(deferred.pendingObservation.includes('7day:fired 3/5'));

  return { ok: true, clear, blocked, deferred };
}

function render(report = {}) {
  return [
    'Luna live-fire preapproval package',
    `status: ${report.status || 'unknown'} / decision=${report.decision || 'unknown'} / approvalRequired=${report.approvalRequired === true}`,
    `hardBlockers: ${(report.hardBlockers || []).length ? report.hardBlockers.join(' / ') : 'none'}`,
    `pending: ${(report.pendingObservation || []).length ? report.pendingObservation.join(' / ') : 'none'}`,
    `protected: running=${report.evidence?.protectedServices?.summary?.running ?? 'n/a'}/${report.evidence?.protectedServices?.summary?.total ?? 'n/a'}`,
    `next: ${(report.nextActions || [])[0] || 'none'}`,
  ].join('\n');
}

async function main() {
  const json = hasFlag('--json');
  const smoke = hasFlag('--smoke');
  const report = smoke
    ? await runLunaLiveFirePreapprovalPackageSmoke()
    : await buildLunaLiveFirePreapprovalPackage({
      exchange: argValue('--exchange', 'binance'),
      hours: Number(argValue('--hours', 24)),
      days: Number(argValue('--days', 7)),
    });
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(smoke ? 'luna live-fire preapproval package smoke ok' : render(report));
  if (!smoke && hasFlag('--fail-on-blocked') && report.ok !== true) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna live-fire preapproval package 실패:',
  });
}
