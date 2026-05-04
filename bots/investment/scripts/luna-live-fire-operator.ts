#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaDelegatedAuthorityDecision } from '../shared/luna-delegated-authority.ts';
import { evaluateLunaLiveFireReadinessGate } from './luna-live-fire-readiness-core.ts';
import { buildLunaLiveFireReadinessGate } from './luna-live-fire-readiness-gate.ts';

const CONFIRM = 'enable-luna-live-fire';
const DEFAULT_MAX_TRADE_USDT = 50;
const DEFAULT_MAX_DAILY_USDT = 200;
const DEFAULT_MAX_OPEN_POSITIONS = 2;

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

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function applyLiveFireEnv({ maxUsdt = DEFAULT_MAX_TRADE_USDT, maxDailyUsdt = DEFAULT_MAX_DAILY_USDT, maxOpen = DEFAULT_MAX_OPEN_POSITIONS } = {}) {
  const setMode = runCommand('launchctl', ['setenv', 'LUNA_INTELLIGENT_DISCOVERY_MODE', 'autonomous_l5']);
  const setMaxTrade = runCommand('launchctl', ['setenv', 'LUNA_MAX_TRADE_USDT', String(maxUsdt)]);
  const setMaxDaily = runCommand('launchctl', ['setenv', 'LUNA_LIVE_FIRE_MAX_DAILY', String(maxDailyUsdt)]);
  const setMaxOpen = runCommand('launchctl', ['setenv', 'LUNA_LIVE_FIRE_MAX_OPEN', String(maxOpen)]);
  const enableLiveFire = runCommand('launchctl', ['setenv', 'LUNA_LIVE_FIRE_ENABLED', 'true']);
  return {
    ok: setMode.ok && setMaxTrade.ok && setMaxDaily.ok && setMaxOpen.ok && enableLiveFire.ok,
    caps: { maxUsdt, maxDailyUsdt, maxOpen },
    steps: { setMode, setMaxTrade, setMaxDaily, setMaxOpen, enableLiveFire },
  };
}

export async function runLunaLiveFireOperator({
  apply = false,
  confirm = '',
  maxUsdt = DEFAULT_MAX_TRADE_USDT,
  maxDailyUsdt = DEFAULT_MAX_DAILY_USDT,
  maxOpen = DEFAULT_MAX_OPEN_POSITIONS,
} = {}) {
  const caps = {
    maxUsdt: positiveNumber(maxUsdt, DEFAULT_MAX_TRADE_USDT),
    maxDailyUsdt: positiveNumber(maxDailyUsdt, DEFAULT_MAX_DAILY_USDT),
    maxOpen: Math.max(1, Math.round(positiveNumber(maxOpen, DEFAULT_MAX_OPEN_POSITIONS))),
  };
  const readiness = await buildLunaLiveFireReadinessGate();
  const allowed = readiness.ok && readiness.status === 'live_fire_ready';
  const delegatedAuthority = buildLunaDelegatedAuthorityDecision({
    action: 'live_fire_enable',
    readiness,
    caps,
  });
  const command = `launchctl setenv LUNA_INTELLIGENT_DISCOVERY_MODE autonomous_l5 && launchctl setenv LUNA_MAX_TRADE_USDT ${caps.maxUsdt} && launchctl setenv LUNA_LIVE_FIRE_MAX_DAILY ${caps.maxDailyUsdt} && launchctl setenv LUNA_LIVE_FIRE_MAX_OPEN ${caps.maxOpen} && launchctl setenv LUNA_LIVE_FIRE_ENABLED true`;
  const rollbackCommand = 'launchctl unsetenv LUNA_INTELLIGENT_DISCOVERY_MODE && launchctl setenv LUNA_LIVE_FIRE_ENABLED false';

  const result = {
    ok: allowed,
    checkedAt: new Date().toISOString(),
    status: allowed ? 'live_fire_enable_ready' : 'live_fire_enable_blocked',
    dryRun: !apply,
    command,
    rollbackCommand,
    confirmRequired: CONFIRM,
    delegatedAuthority,
    caps,
    blockers: readiness.blockers || [],
    readiness,
  };

  if (!apply) return result;
  if (!allowed) {
    return { ...result, applied: false, applyBlockedReason: 'readiness_not_met' };
  }
  if (confirm !== CONFIRM && !delegatedAuthority.canSelfApprove) {
    return { ...result, ok: false, applied: false, applyBlockedReason: 'confirm_required' };
  }

  const applyResult = applyLiveFireEnv(caps);
  return {
    ...result,
    ok: applyResult.ok,
    status: applyResult.ok ? 'live_fire_enabled' : 'live_fire_enable_failed',
    applied: applyResult.ok,
    approvalSource: confirm === CONFIRM ? 'operator_confirm' : delegatedAuthority.approvalSource,
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
  const delegated = buildLunaDelegatedAuthorityDecision({
    action: 'live_fire_enable',
    env: { LUNA_DELEGATED_AUTHORITY_ENABLED: 'true' },
    readiness: { ok: true, status: 'live_fire_ready', blockers: [] },
    caps: { maxUsdt: DEFAULT_MAX_TRADE_USDT, maxDailyUsdt: DEFAULT_MAX_DAILY_USDT, maxOpen: DEFAULT_MAX_OPEN_POSITIONS },
  });
  assert.equal(delegated.canSelfApprove, true);
  return {
    ok: true,
    readiness,
    confirmRequired: CONFIRM,
    defaultCaps: {
      maxUsdt: DEFAULT_MAX_TRADE_USDT,
      maxDailyUsdt: DEFAULT_MAX_DAILY_USDT,
      maxOpen: DEFAULT_MAX_OPEN_POSITIONS,
    },
  };
}

async function main() {
  const smoke = hasFlag('--smoke');
  const json = hasFlag('--json');
  const apply = hasFlag('--apply');
  const confirm = argValue('--confirm', '');
  const maxUsdt = Number(argValue('--max-usdt', DEFAULT_MAX_TRADE_USDT));
  const maxDailyUsdt = Number(argValue('--max-daily-usdt', DEFAULT_MAX_DAILY_USDT));
  const maxOpen = Number(argValue('--max-open', DEFAULT_MAX_OPEN_POSITIONS));
  const result = smoke
    ? await runLunaLiveFireOperatorSmoke()
    : await runLunaLiveFireOperator({ apply, confirm, maxUsdt, maxDailyUsdt, maxOpen });
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
