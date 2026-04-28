#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import { buildLunaL5ReadinessReport } from './luna-l5-readiness-report.ts';

const CONFIRM = 'sync-luna-kill-switches';
const SWITCHES = [
  'LUNA_V2_ENABLED',
  'LUNA_MAPEK_ENABLED',
  'LUNA_VALIDATION_ENABLED',
  'LUNA_PREDICTION_ENABLED',
];

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function normalize(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;
  if (['1', 'true', 'yes', 'on'].includes(text)) return 'true';
  if (['0', 'false', 'no', 'off'].includes(text)) return 'false';
  return text;
}

function desiredForKey(key, desired = {}) {
  return normalize(desired[key] ?? 'true');
}

export function evaluateKillSwitchConsistency(switches = {}, desired = {}) {
  const items = SWITCHES.map((key) => {
    const snapshot = switches[key] || {};
    const desiredValue = desiredForKey(key, desired);
    const values = {
      process: normalize(snapshot.process),
      launchctl: normalize(snapshot.launchctl),
      repoPlist: normalize(snapshot.repoPlist),
      installedPlist: normalize(snapshot.installedPlist),
      effectiveHint: normalize(snapshot.effectiveHint),
    };
    const durablePresent = [values.launchctl, values.installedPlist, values.repoPlist].filter((value) => value != null);
    const durableConflict = new Set(durablePresent).size > 1;
    const processConflict = values.process != null && values.effectiveHint != null && values.process !== values.effectiveHint;
    const effectiveMismatch = values.effectiveHint !== desiredValue;
    return {
      key,
      desired: desiredValue,
      values,
      conflicts: durableConflict,
      durableConflict,
      processConflict,
      effectiveMismatch,
      status: durableConflict ? 'source_conflict' : effectiveMismatch ? 'effective_mismatch' : processConflict ? 'process_env_stale' : 'consistent',
      command: `launchctl setenv ${key} ${desiredValue}`,
    };
  });
  const blockers = items.filter((item) => item.durableConflict || item.effectiveMismatch);
  const warnings = items.filter((item) => item.processConflict && !item.durableConflict && !item.effectiveMismatch);
  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? (warnings.length ? 'kill_switch_consistent_with_process_warnings' : 'kill_switch_consistent') : 'kill_switch_consistency_required',
    items,
    blockers,
    warnings,
    commands: blockers.map((item) => item.command),
  };
}

export async function buildLunaKillSwitchConsistency({
  desired = {},
} = {}) {
  const readiness = await buildLunaL5ReadinessReport();
  return {
    checkedAt: new Date().toISOString(),
    ...evaluateKillSwitchConsistency(readiness.G1_killSwitches || {}, desired),
  };
}

export async function applyLunaKillSwitchConsistency(report = {}, {
  confirm = '',
} = {}) {
  if (confirm !== CONFIRM) {
    return {
      ...report,
      applied: false,
      applyBlockedReason: 'confirm_required',
      confirmRequired: CONFIRM,
    };
  }
  const results = [];
  for (const item of report.blockers || []) {
    const proc = spawnSync('launchctl', ['setenv', item.key, item.desired], { encoding: 'utf8' });
    results.push({
      key: item.key,
      desired: item.desired,
      ok: proc.status === 0,
      status: proc.status,
      stderr: String(proc.stderr || '').trim(),
    });
  }
  return {
    ...report,
    applied: results.every((item) => item.ok),
    results,
  };
}

export function renderLunaKillSwitchConsistency(report = {}) {
  return [
    '🧭 Luna kill-switch consistency',
    `status: ${report.status || 'unknown'}`,
    `blockers: ${(report.blockers || []).length ? report.blockers.map((item) => `${item.key}:${item.status}`).join(' / ') : 'none'}`,
    `next: ${(report.commands || []).length ? report.commands[0] : 'none'}`,
  ].join('\n');
}

export async function publishLunaKillSwitchConsistency(report = {}) {
  return publishAlert({
    from_bot: 'luna',
    event_type: 'report',
    alert_level: report.ok ? 1 : 2,
    message: renderLunaKillSwitchConsistency(report),
    payload: {
      checkedAt: report.checkedAt,
      status: report.status,
      blockers: report.blockers || [],
    },
  });
}

export async function runLunaKillSwitchConsistencySmoke() {
  const clear = evaluateKillSwitchConsistency({
    LUNA_V2_ENABLED: { effectiveHint: 'true', launchctl: 'true' },
    LUNA_MAPEK_ENABLED: { effectiveHint: 'true', launchctl: 'true' },
    LUNA_VALIDATION_ENABLED: { effectiveHint: 'true', launchctl: 'true' },
    LUNA_PREDICTION_ENABLED: { effectiveHint: 'true', launchctl: 'true' },
  });
  assert.equal(clear.ok, true);
  const conflict = evaluateKillSwitchConsistency({
    LUNA_V2_ENABLED: { effectiveHint: 'true', launchctl: 'true' },
    LUNA_MAPEK_ENABLED: { effectiveHint: 'true', launchctl: 'true' },
    LUNA_VALIDATION_ENABLED: { effectiveHint: 'true', launchctl: 'true', process: 'false' },
    LUNA_PREDICTION_ENABLED: { effectiveHint: 'false', launchctl: 'false' },
  });
  assert.equal(conflict.ok, false);
  assert.ok(conflict.warnings.some((item) => item.key === 'LUNA_VALIDATION_ENABLED'));
  assert.ok(conflict.commands.some((command) => command.includes('LUNA_PREDICTION_ENABLED')));
  return { ok: true, clear, conflict };
}

async function main() {
  const json = hasFlag('--json');
  const smoke = hasFlag('--smoke');
  const telegram = hasFlag('--telegram');
  const apply = hasFlag('--apply');
  const desired = Object.fromEntries(SWITCHES.map((key) => [key, argValue(`--${key}`, 'true')]));
  const report = smoke ? await runLunaKillSwitchConsistencySmoke() : await buildLunaKillSwitchConsistency({ desired });
  const result = (!smoke && apply)
    ? await applyLunaKillSwitchConsistency(report, { confirm: argValue('--confirm', '') })
    : report;
  if (telegram && !smoke) await publishLunaKillSwitchConsistency(result);
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(smoke ? 'luna kill-switch consistency smoke ok' : renderLunaKillSwitchConsistency(result));
  if (!smoke && hasFlag('--fail-on-blocked') && result.ok === false) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna kill-switch consistency 실패:',
  });
}
