#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaPostLiveFireVerification } from './luna-post-live-fire-verify.ts';

const CONFIRM = 'rollback-luna-live-fire';
const ROLLBACK_COMMAND = 'launchctl unsetenv LUNA_INTELLIGENT_DISCOVERY_MODE && launchctl setenv LUNA_LIVE_FIRE_ENABLED false';

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = '') {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
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

function readLaunchctlEnv(name) {
  const result = runCommand('launchctl', ['getenv', name]);
  return result.ok ? String(result.stdout || '').trim() : '';
}

function envTrue(name) {
  const raw = String(process.env[name] || readLaunchctlEnv(name) || '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

function liveFireCapable(report = {}, { checkRuntimeEnv = true } = {}) {
  const gate = report.liveFireGate || report.operating?.liveFireGate || {};
  const mode = String(gate.mode || '').toLowerCase();
  const explicitLiveFireEnabled = checkRuntimeEnv && envTrue('LUNA_LIVE_FIRE_ENABLED');
  return gate.allowLiveFire === true || explicitLiveFireEnabled || Boolean(gate.liveFireEnabled === true && (mode === 'autonomous_l5' || mode === 'autonomous'));
}

function applyRollbackEnv() {
  const unsetMode = runCommand('launchctl', ['unsetenv', 'LUNA_INTELLIGENT_DISCOVERY_MODE']);
  const disableLiveFire = runCommand('launchctl', ['setenv', 'LUNA_LIVE_FIRE_ENABLED', 'false']);
  return {
    ok: unsetMode.ok && disableLiveFire.ok,
    steps: { unsetMode, disableLiveFire },
  };
}

export function evaluateLunaLiveFireWatchdog(report = {}, options = {}) {
  const blockers = Array.isArray(report.blockers) ? report.blockers : [];
  const liveCapable = liveFireCapable(report, options);
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
  forceStop = false,
} = {}) {
  if (apply && forceStop) {
    if (confirm !== CONFIRM) {
      return {
        ok: false,
        checkedAt: new Date().toISOString(),
        status: 'emergency_stop_blocked',
        rollbackRecommended: true,
        liveCapable: true,
        blockers: ['confirm_required'],
        rollbackCommand: ROLLBACK_COMMAND,
        confirmRequired: CONFIRM,
        dryRun: false,
        applied: false,
        applyBlockedReason: 'confirm_required',
        forceStop,
      };
    }
    const rollbackResult = applyRollbackEnv();
    let postVerify = null;
    let evaluated = null;
    try {
      postVerify = await buildLunaPostLiveFireVerification({ exchange, hours });
      evaluated = evaluateLunaLiveFireWatchdog(postVerify);
    } catch (error) {
      evaluated = {
        ok: rollbackResult.ok,
        checkedAt: new Date().toISOString(),
        status: rollbackResult.ok ? 'emergency_stop_applied_post_verify_failed' : 'rollback_failed',
        rollbackRecommended: true,
        liveCapable: true,
        blockers: [`post_verify_failed:${error?.message || error}`],
        rollbackCommand: ROLLBACK_COMMAND,
        confirmRequired: CONFIRM,
        postVerify: null,
      };
    }
    return {
      ...evaluated,
      ok: rollbackResult.ok,
      dryRun: false,
      status: rollbackResult.ok ? 'emergency_stop_applied' : 'rollback_failed',
      applied: rollbackResult.ok,
      forceStop,
      rollbackResult,
      postVerify,
    };
  }
  const postVerify = await buildLunaPostLiveFireVerification({ exchange, hours });
  const evaluated = evaluateLunaLiveFireWatchdog(postVerify);
  if (!apply) return { ...evaluated, dryRun: true, applied: false };
  if (!forceStop && !evaluated.rollbackRecommended) {
    return { ...evaluated, dryRun: false, applied: false, applyBlockedReason: 'rollback_not_recommended' };
  }
  if (confirm !== CONFIRM) {
    return { ...evaluated, ok: false, dryRun: false, applied: false, applyBlockedReason: 'confirm_required' };
  }
  const rollbackResult = applyRollbackEnv();
  return {
    ...evaluated,
    ok: rollbackResult.ok,
    dryRun: false,
    status: rollbackResult.ok ? (forceStop ? 'emergency_stop_applied' : 'rollback_applied') : 'rollback_failed',
    applied: rollbackResult.ok,
    forceStop,
    rollbackResult,
  };
}

export async function runLunaLiveFireWatchdogSmoke() {
  const clear = evaluateLunaLiveFireWatchdog({
    ok: true,
    blockers: [],
    liveFireGate: { mode: 'shadow', allowLiveFire: false },
  }, { checkRuntimeEnv: false });
  assert.equal(clear.status, 'watchdog_clear');

  const attention = evaluateLunaLiveFireWatchdog({
    ok: false,
    blockers: ['trade_reconciliation_not_clear:trade_reconciliation_attention'],
    liveFireGate: { mode: 'shadow', allowLiveFire: false },
  }, { checkRuntimeEnv: false });
  assert.equal(attention.status, 'watchdog_attention');
  assert.equal(attention.rollbackRecommended, false);

  const rollback = evaluateLunaLiveFireWatchdog({
    ok: false,
    blockers: ['worker_not_ready:entry_trigger_worker_attention'],
    liveFireGate: { mode: 'autonomous_l5', allowLiveFire: true },
  }, { checkRuntimeEnv: false });
  assert.equal(rollback.status, 'rollback_recommended');
  assert.equal(rollback.rollbackRecommended, true);
  assert.equal(ROLLBACK_COMMAND.includes('LUNA_LIVE_FIRE_ENABLED false'), true);

  const preApprovalAutonomous = evaluateLunaLiveFireWatchdog({
    ok: false,
    blockers: ['worker_not_ready:entry_trigger_worker_attention'],
    liveFireGate: { mode: 'autonomous_l5', allowLiveFire: false },
  }, { checkRuntimeEnv: false });
  assert.equal(preApprovalAutonomous.status, 'watchdog_attention');
  assert.equal(preApprovalAutonomous.rollbackRecommended, false);

  return { ok: true, clear, attention, rollback, preApprovalAutonomous };
}

async function main() {
  const json = hasFlag('--json');
  const smoke = hasFlag('--smoke');
  const apply = hasFlag('--apply');
  const forceStop = hasFlag('--force-stop') || hasFlag('--emergency-stop');
  const confirm = argValue('--confirm', '');
  const exchange = argValue('--exchange', 'binance');
  const hours = Number(argValue('--hours', 6));
  const result = smoke
    ? await runLunaLiveFireWatchdogSmoke()
    : await runLunaLiveFireWatchdog({ exchange, hours, apply, confirm, forceStop });
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
