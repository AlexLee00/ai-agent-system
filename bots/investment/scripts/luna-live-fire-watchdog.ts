#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaPostLiveFireVerification } from './luna-post-live-fire-verify.ts';

const CONFIRM = 'rollback-luna-live-fire';
const ROLLBACK_COMMAND = 'launchctl unsetenv LUNA_INTELLIGENT_DISCOVERY_MODE';

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = '') {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function liveFireCapable(report = {}) {
  const gate = report.liveFireGate || report.operating?.liveFireGate || {};
  const mode = String(gate.mode || '').toLowerCase();
  return gate.allowLiveFire === true || mode === 'autonomous_l5' || mode === 'autonomous';
}

function runCommand(command, args = []) {
  const proc = spawnSync(command, args, { encoding: 'utf8' });
  return {
    ok: proc.status === 0,
    status: proc.status,
    stdout: String(proc.stdout || '').trim(),
    stderr: String(proc.stderr || '').trim(),
    command: [command, ...args].join(' '),
  };
}

export function evaluateLunaLiveFireWatchdog(report = {}) {
  const blockers = Array.isArray(report.blockers) ? report.blockers : [];
  const liveCapable = liveFireCapable(report);
  const rollbackRecommended = liveCapable && blockers.length > 0;
  return {
    ok: blockers.length === 0,
    checkedAt: new Date().toISOString(),
    status: blockers.length === 0
      ? 'watchdog_clear'
      : (rollbackRecommended ? 'rollback_recommended' : 'watchdog_attention'),
    rollbackRecommended,
    liveCapable,
    blockers,
    rollbackCommand: ROLLBACK_COMMAND,
    confirmRequired: CONFIRM,
    postVerify: report,
  };
}

export async function runLunaLiveFireWatchdog({
  exchange = 'binance',
  hours = 6,
  apply = false,
  confirm = '',
} = {}) {
  const postVerify = await buildLunaPostLiveFireVerification({ exchange, hours });
  const evaluated = evaluateLunaLiveFireWatchdog(postVerify);
  if (!apply) return { ...evaluated, dryRun: true, applied: false };
  if (!evaluated.rollbackRecommended) {
    return { ...evaluated, dryRun: false, applied: false, applyBlockedReason: 'rollback_not_recommended' };
  }
  if (confirm !== CONFIRM) {
    return { ...evaluated, ok: false, dryRun: false, applied: false, applyBlockedReason: 'confirm_required' };
  }
  const rollbackResult = runCommand('launchctl', ['unsetenv', 'LUNA_INTELLIGENT_DISCOVERY_MODE']);
  return {
    ...evaluated,
    ok: rollbackResult.ok,
    dryRun: false,
    status: rollbackResult.ok ? 'rollback_applied' : 'rollback_failed',
    applied: rollbackResult.ok,
    rollbackResult,
  };
}

export async function runLunaLiveFireWatchdogSmoke() {
  const clear = evaluateLunaLiveFireWatchdog({
    ok: true,
    blockers: [],
    liveFireGate: { mode: 'shadow', allowLiveFire: false },
  });
  assert.equal(clear.status, 'watchdog_clear');

  const attention = evaluateLunaLiveFireWatchdog({
    ok: false,
    blockers: ['trade_reconciliation_not_clear:trade_reconciliation_attention'],
    liveFireGate: { mode: 'shadow', allowLiveFire: false },
  });
  assert.equal(attention.status, 'watchdog_attention');
  assert.equal(attention.rollbackRecommended, false);

  const rollback = evaluateLunaLiveFireWatchdog({
    ok: false,
    blockers: ['worker_not_ready:entry_trigger_worker_attention'],
    liveFireGate: { mode: 'autonomous_l5', allowLiveFire: true },
  });
  assert.equal(rollback.status, 'rollback_recommended');
  assert.equal(rollback.rollbackRecommended, true);

  return { ok: true, clear, attention, rollback };
}

async function main() {
  const json = hasFlag('--json');
  const smoke = hasFlag('--smoke');
  const apply = hasFlag('--apply');
  const confirm = argValue('--confirm', '');
  const exchange = argValue('--exchange', 'binance');
  const hours = Number(argValue('--hours', 6));
  const result = smoke
    ? await runLunaLiveFireWatchdogSmoke()
    : await runLunaLiveFireWatchdog({ exchange, hours, apply, confirm });
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(smoke ? 'luna live-fire watchdog smoke ok' : `${result.status || 'unknown'}${apply ? '' : ' (dry-run)'}`);
  if (!smoke && apply && result.ok === false) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna live-fire watchdog 실패:',
  });
}
