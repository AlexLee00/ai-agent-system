#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import { buildLunaLiveFireCutoverPreflight } from './luna-live-fire-cutover-preflight.ts';
import { buildLunaReconcileAckPreflight } from './luna-reconcile-ack-preflight.ts';
import { buildLunaManualReconcilePlaybook } from './luna-manual-reconcile-playbook.ts';
import { buildLunaKillSwitchConsistency } from './luna-kill-switch-consistency.ts';
import { buildLunaEntryTriggerWorkerReadiness } from './luna-entry-trigger-worker-readiness.ts';

const require = createRequire(import.meta.url);

async function loadPostAlarm() {
  const module = require('../../../packages/core/lib/hub-alarm-client.js');
  return module.postAlarm || module.default?.postAlarm;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function summarizeBlockers({
  preflight,
  ackPreflight,
  manualPlaybook,
  killSwitch,
  worker,
} = {}) {
  const blockers = [];
  if (!preflight?.ok) blockers.push(...(preflight.blockers || ['cutover_preflight_blocked']));
  if (ackPreflight?.summary?.unsafe > 0) blockers.push(`ack_preflight_unsafe:${ackPreflight.summary.unsafe}`);
  if (ackPreflight?.summary?.lookupFailed > 0) blockers.push(`ack_lookup_failed:${ackPreflight.summary.lookupFailed}`);
  if (manualPlaybook?.summary?.tasks > 0) blockers.push(`manual_reconcile_tasks:${manualPlaybook.summary.tasks}`);
  if (!killSwitch?.ok) blockers.push(`kill_switch_consistency:${(killSwitch.blockers || []).length}`);
  if (!worker?.ok) blockers.push(`entry_trigger_worker:${(worker.warnings || []).length}`);
  return [...new Set(blockers)];
}

function summarizeNextAction({
  blockers = [],
  preflight,
  ackPreflight,
  manualPlaybook,
  killSwitch,
  worker,
} = {}) {
  if (ackPreflight?.summary?.readyToAck > 0 && ackPreflight?.summary?.unsafe === 0 && ackPreflight?.summary?.lookupFailed === 0) {
    return 'apply_verified_ack_then_rerun_final_gate';
  }
  if ((manualPlaybook?.summary?.manualReconcileRequired || 0) > 0) return 'complete_manual_wallet_journal_position_reconcile';
  if (preflight?.parity?.clear === false) return 'resolve_position_parity_before_live_fire';
  if (!killSwitch?.ok) return 'fix_luna_kill_switch_consistency';
  if (!worker?.ok) return 'repair_entry_trigger_worker_runtime';
  if (blockers.length > 0) return 'resolve_live_fire_blockers';
  if (preflight?.readiness?.status === 'live_fire_already_enabled') return 'continue_live_fire_watchdog_monitoring';
  return 'enable_live_fire_cutover';
}

function buildOperatingSummary({
  blockers = [],
  preflight,
  ackPreflight,
  manualPlaybook,
  killSwitch,
  worker,
} = {}) {
  const nextAction = summarizeNextAction({ blockers, preflight, ackPreflight, manualPlaybook, killSwitch, worker });
  return {
    nextAction,
    safeAckReady: Number(ackPreflight?.summary?.readyToAck || 0),
    manualAckRequired: Number(manualPlaybook?.summary?.manualAckRequired || 0),
    manualReconcileRequired: Number(manualPlaybook?.summary?.manualReconcileRequired || 0),
    parityRequired: preflight?.withPositionParity === true,
    parityClear: preflight?.parity?.clear ?? null,
    killSwitchClear: killSwitch?.ok === true,
    workerReady: worker?.ok === true,
    liveFireReady: blockers.length === 0,
  };
}

export async function buildLunaLiveFireFinalGate({
  exchange = 'binance',
  hours = 6,
  liveLookup = false,
  withPositionParity = true,
} = {}) {
  const [preflight, ackPreflight, manualPlaybook, killSwitch, worker] = await Promise.all([
    buildLunaLiveFireCutoverPreflight({ exchange, hours, withPositionParity }),
    buildLunaReconcileAckPreflight({ exchange, hours, liveLookup }),
    buildLunaManualReconcilePlaybook({ exchange, hours }),
    buildLunaKillSwitchConsistency(),
    buildLunaEntryTriggerWorkerReadiness({ exchange, hours }),
  ]);
  const blockers = summarizeBlockers({ preflight, ackPreflight, manualPlaybook, killSwitch, worker });
  const operatingSummary = buildOperatingSummary({ blockers, preflight, ackPreflight, manualPlaybook, killSwitch, worker });
  return {
    ok: blockers.length === 0,
    checkedAt: new Date().toISOString(),
    status: blockers.length === 0 ? 'luna_live_fire_final_gate_clear' : 'luna_live_fire_final_gate_blocked',
    exchange,
    hours,
    liveLookup,
    withPositionParity,
    blockers,
    operatingSummary,
    preflight,
    ackPreflight,
    manualPlaybook,
    killSwitch,
    worker: {
      status: worker.status,
      ok: worker.ok,
      warnings: worker.warnings || [],
      heartbeat: worker.heartbeat,
      installedPlist: worker.installedPlist,
      launchctl: worker.launchctl,
    },
    nextCommands: blockers.length === 0
      ? (operatingSummary.nextAction === 'continue_live_fire_watchdog_monitoring'
        ? ['npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-live-fire-watchdog']
        : [
            'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-live-fire-cutover -- --apply --confirm=enable-luna-live-fire --max-usdt=50 --max-daily-usdt=200 --max-open=2',
            'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-live-fire-watchdog',
          ])
      : [
      ...(operatingSummary.safeAckReady > 1
        ? [`npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-reconcile-ack-batch -- --apply --confirm=ack-luna-reconcile-batch --reason=operator_verified_absent_order --evidence=binance_client_order_lookup_not_found`]
        : []),
      ...(ackPreflight.nextCommands || []),
      ...(killSwitch.commands || []),
      ...(!worker.ok && worker.installCommand ? [worker.installCommand] : []),
    ].filter(Boolean),
  };
}

export function renderLunaLiveFireFinalGate(report = {}) {
  return [
    '🧱 Luna live-fire final gate',
    `status: ${report.status || 'unknown'} / exchange=${report.exchange || 'n/a'} / ${report.hours || 6}h`,
    `blockers: ${(report.blockers || []).length ? report.blockers.join(' / ') : 'none'}`,
    `nextAction: ${report.operatingSummary?.nextAction || 'unknown'}`,
    `ackReady=${report.operatingSummary?.safeAckReady ?? 'n/a'} / manualReconcile=${report.operatingSummary?.manualReconcileRequired ?? 'n/a'} / parity=${report.operatingSummary?.parityClear ?? 'n/a'} / killSwitch=${report.killSwitch?.status || 'unknown'} / worker=${report.worker?.status || 'unknown'}`,
    `next: ${(report.nextCommands || []).length ? report.nextCommands[0] : 'none'}`,
  ].join('\n');
}

export async function publishLunaLiveFireFinalGate(report = {}) {
  const published = await publishAlert({
    from_bot: 'luna',
    event_type: 'report',
    alert_level: report.ok ? 1 : 2,
    message: renderLunaLiveFireFinalGate(report),
    payload: {
      checkedAt: report.checkedAt,
      status: report.status,
      blockers: report.blockers || [],
      operatingSummary: report.operatingSummary || {},
      ackSummary: report.ackPreflight?.summary || {},
      manualSummary: report.manualPlaybook?.summary || {},
      killSwitchBlockers: report.killSwitch?.blockers || [],
      workerWarnings: report.worker?.warnings || [],
    },
  });
  if (!report.ok) return published;
  const postAlarm = await loadPostAlarm();
  if (typeof postAlarm !== 'function') return published;
  await postAlarm({
    fromBot: 'luna',
    team: 'emergency',
    alertLevel: 4,
    alarmType: 'work',
    visibility: 'emergency',
    actionability: 'needs_human',
    eventType: 'luna_live_fire_control',
    title: 'Luna live-fire emergency stop',
    message: [
      'Luna live-fire cutover control',
      `status=${report.status || 'unknown'}`,
      '1-tap emergency stop: launchctl live-fire flag OFF + autonomous discovery mode unset',
    ].join('\n'),
    payload: {
      checkedAt: report.checkedAt,
      status: report.status,
      emergencyStopCallback: 'luna_live_fire:emergency_stop',
    },
    inlineKeyboard: [[
      { text: '⛔ Luna live-fire 즉시 중단', callback_data: 'luna_live_fire:emergency_stop' },
    ]],
  });
  return published;
}

export async function runLunaLiveFireFinalGateSmoke() {
  const blockers = summarizeBlockers({
    preflight: { ok: false, blockers: ['reconcile_resolution_required:1'] },
    ackPreflight: { summary: { unsafe: 1, lookupFailed: 0 } },
    manualPlaybook: { summary: { tasks: 1 } },
    killSwitch: { ok: false, blockers: [{}] },
    worker: { ok: false, warnings: ['missing'] },
  });
  assert.ok(blockers.includes('ack_preflight_unsafe:1'));
  assert.ok(blockers.includes('manual_reconcile_tasks:1'));
  assert.ok(blockers.includes('kill_switch_consistency:1'));
  const summary = buildOperatingSummary({
    blockers,
    preflight: { withPositionParity: true, parity: { clear: false } },
    ackPreflight: { summary: { readyToAck: 1, unsafe: 0, lookupFailed: 0 } },
    manualPlaybook: { summary: { manualReconcileRequired: 1 } },
    killSwitch: { ok: false },
    worker: { ok: false },
  });
  assert.equal(summary.nextAction, 'apply_verified_ack_then_rerun_final_gate');
  const alreadyEnabled = buildOperatingSummary({
    blockers: [],
    preflight: { withPositionParity: true, parity: { clear: true }, readiness: { status: 'live_fire_already_enabled' } },
    ackPreflight: { summary: { readyToAck: 0, unsafe: 0, lookupFailed: 0 } },
    manualPlaybook: { summary: { manualReconcileRequired: 0 } },
    killSwitch: { ok: true },
    worker: { ok: true },
  });
  assert.equal(alreadyEnabled.nextAction, 'continue_live_fire_watchdog_monitoring');
  return { ok: true, blockers, summary };
}

async function main() {
  const json = hasFlag('--json');
  const smoke = hasFlag('--smoke');
  const telegram = hasFlag('--telegram');
  const liveLookup = hasFlag('--live-lookup');
  const withPositionParity = !hasFlag('--skip-position-parity');
  const exchange = argValue('--exchange', 'binance');
  const hours = Number(argValue('--hours', 6));
  const report = smoke
    ? await runLunaLiveFireFinalGateSmoke()
    : await buildLunaLiveFireFinalGate({ exchange, hours, liveLookup, withPositionParity });
  if (telegram && !smoke) await publishLunaLiveFireFinalGate(report);
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(smoke ? 'luna live-fire final gate smoke ok' : renderLunaLiveFireFinalGate(report));
  if (!smoke && hasFlag('--fail-on-blocked') && report.ok === false) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna live-fire final gate 실패:',
  });
}
