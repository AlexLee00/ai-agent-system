#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { evaluateLunaLiveFireReadinessGate } from './luna-live-fire-readiness-core.ts';
import { buildLunaLiveFireReadinessGate } from './luna-live-fire-readiness-gate.ts';

const CONFIRM = 'enable-luna-live-fire';

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

export async function runLunaLiveFireOperator({ apply = false, confirm = '' } = {}) {
  const readiness = await buildLunaLiveFireReadinessGate();
  const allowed = readiness.ok && readiness.status === 'live_fire_ready';
  const command = 'launchctl setenv LUNA_INTELLIGENT_DISCOVERY_MODE autonomous_l5';
  const rollbackCommand = 'launchctl unsetenv LUNA_INTELLIGENT_DISCOVERY_MODE';

  const result = {
    ok: allowed,
    checkedAt: new Date().toISOString(),
    status: allowed ? 'live_fire_enable_ready' : 'live_fire_enable_blocked',
    dryRun: !apply,
    command,
    rollbackCommand,
    confirmRequired: CONFIRM,
    blockers: readiness.blockers || [],
    readiness,
  };

  if (!apply) return result;
  if (!allowed) {
    return { ...result, applied: false, applyBlockedReason: 'readiness_not_met' };
  }
  if (confirm !== CONFIRM) {
    return { ...result, ok: false, applied: false, applyBlockedReason: 'confirm_required' };
  }

  const applyResult = runCommand('launchctl', ['setenv', 'LUNA_INTELLIGENT_DISCOVERY_MODE', 'autonomous_l5']);
  return {
    ...result,
    ok: applyResult.ok,
    status: applyResult.ok ? 'live_fire_enabled' : 'live_fire_enable_failed',
    applied: applyResult.ok,
    applyResult,
  };
}

export async function runLunaLiveFireOperatorSmoke() {
  const readiness = evaluateLunaLiveFireReadinessGate({
    operating: {
      status: 'luna_l5_operating',
      readinessWarnings: [],
      killSwitches: { LUNA_VALIDATION_ENABLED: 'true', LUNA_PREDICTION_ENABLED: 'true' },
    },
    worker: {
      ok: true,
      heartbeat: { ageMinutes: 0, payload: { result: { mode: 'shadow', allowLiveFire: false, readyBlocked: 1 } } },
      stats: { duplicateFiredScopeCount: 0 },
    },
  });
  assert.equal(readiness.status, 'live_fire_ready');
  assert.equal(CONFIRM, 'enable-luna-live-fire');
  return {
    ok: true,
    readiness,
    confirmRequired: CONFIRM,
  };
}

async function main() {
  const smoke = hasFlag('--smoke');
  const json = hasFlag('--json');
  const apply = hasFlag('--apply');
  const confirm = argValue('--confirm', '');
  const result = smoke ? await runLunaLiveFireOperatorSmoke() : await runLunaLiveFireOperator({ apply, confirm });
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.status || 'luna live-fire operator smoke ok'}${apply ? '' : ' (dry-run)'}`);
  if (!smoke && apply && !result.ok) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna live-fire operator 실패:',
  });
}
