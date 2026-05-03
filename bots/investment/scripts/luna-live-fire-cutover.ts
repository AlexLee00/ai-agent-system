#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildLunaLiveFireCutoverPreflight,
  renderLunaLiveFireCutoverPreflight,
  publishLunaLiveFireCutoverPreflight,
} from './luna-live-fire-cutover-preflight.ts';
import {
  buildLunaLiveFireFinalGate,
  renderLunaLiveFireFinalGate,
  publishLunaLiveFireFinalGate,
} from './luna-live-fire-final-gate.ts';

const CONFIRM = 'enable-luna-live-fire';
const CUTOVER_COMMAND = 'launchctl setenv LUNA_INTELLIGENT_DISCOVERY_MODE autonomous_l5 && launchctl setenv LUNA_LIVE_FIRE_ENABLED true';
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

function applyCutoverEnv() {
  const setMode = runCommand('launchctl', ['setenv', 'LUNA_INTELLIGENT_DISCOVERY_MODE', 'autonomous_l5']);
  const enableLiveFire = runCommand('launchctl', ['setenv', 'LUNA_LIVE_FIRE_ENABLED', 'true']);
  return {
    ok: setMode.ok && enableLiveFire.ok,
    steps: { setMode, enableLiveFire },
  };
}

export async function runLunaLiveFireCutover({
  exchange = 'binance',
  hours = 6,
  withPositionParity = true,
  apply = false,
  confirm = '',
  telegram = false,
  liveLookup = false,
} = {}) {
  const finalGate = await buildLunaLiveFireFinalGate({ exchange, hours, withPositionParity, liveLookup });
  const preflight = finalGate.preflight || await buildLunaLiveFireCutoverPreflight({ exchange, hours, withPositionParity });
  const result = {
    ok: finalGate.ok,
    checkedAt: new Date().toISOString(),
    status: finalGate.ok ? 'live_fire_cutover_ready' : 'live_fire_cutover_blocked',
    dryRun: !apply,
    applied: false,
    command: CUTOVER_COMMAND,
    rollbackCommand: ROLLBACK_COMMAND,
    confirmRequired: CONFIRM,
    blockers: finalGate.blockers || [],
    preflight,
    finalGate,
  };

  if (telegram) {
    await publishLunaLiveFireFinalGate(finalGate);
    await publishLunaLiveFireCutoverPreflight(preflight);
  }
  if (!apply) return result;
  if (!finalGate.ok) {
    return { ...result, ok: false, applyBlockedReason: 'final_gate_not_clear' };
  }
  if (confirm !== CONFIRM) {
    return { ...result, ok: false, applyBlockedReason: 'confirm_required' };
  }

  const applyResult = applyCutoverEnv();
  return {
    ...result,
    ok: applyResult.ok,
    status: applyResult.ok ? 'live_fire_cutover_applied' : 'live_fire_cutover_failed',
    applied: applyResult.ok,
    applyResult,
  };
}

export async function runLunaLiveFireCutoverSmoke() {
  assert.equal(CONFIRM, 'enable-luna-live-fire');
  assert.ok(CUTOVER_COMMAND.includes('autonomous_l5'));
  assert.ok(CUTOVER_COMMAND.includes('LUNA_LIVE_FIRE_ENABLED true'));
  assert.ok(ROLLBACK_COMMAND.includes('LUNA_LIVE_FIRE_ENABLED false'));
  return { ok: true, confirmRequired: CONFIRM };
}

async function main() {
  const json = hasFlag('--json');
  const smoke = hasFlag('--smoke');
  const apply = hasFlag('--apply');
  const telegram = hasFlag('--telegram');
  const withPositionParity = !hasFlag('--skip-position-parity');
  const liveLookup = hasFlag('--live-lookup');
  const confirm = argValue('--confirm', '');
  const exchange = argValue('--exchange', 'binance');
  const hours = Number(argValue('--hours', 6));
  const result = smoke
    ? await runLunaLiveFireCutoverSmoke()
    : await runLunaLiveFireCutover({ exchange, hours, withPositionParity, apply, confirm, telegram, liveLookup });
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(smoke ? 'luna live-fire cutover smoke ok' : `${result.status || 'unknown'}${apply ? '' : ' (dry-run)'}\n${renderLunaLiveFireFinalGate(result.finalGate || {})}\n\n${renderLunaLiveFireCutoverPreflight(result.preflight || {})}`);
  if (!smoke && apply && result.ok === false) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna live-fire cutover 실패:',
  });
}
