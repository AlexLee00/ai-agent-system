#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaL5OperatingReport } from './luna-l5-operating-report.ts';
import { buildLunaEntryTriggerWorkerReadiness } from './luna-entry-trigger-worker-readiness.ts';
import {
  evaluateLunaLiveFireReadinessGate,
  renderLunaLiveFireReadinessGate,
} from './luna-live-fire-readiness-core.ts';

function boolArg(name) {
  return process.argv.includes(name);
}

function numEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
}

function readLaunchctlEnv(name) {
  const proc = spawnSync('launchctl', ['getenv', name], { encoding: 'utf8' });
  return proc.status === 0 ? String(proc.stdout || '').trim() : '';
}

function runtimeEnv(name) {
  return String(process.env[name] || readLaunchctlEnv(name) || '').trim();
}

function runtimeEnvTrue(name) {
  return ['true', '1', 'yes', 'on'].includes(runtimeEnv(name).toLowerCase());
}

export async function buildLunaLiveFireReadinessGate({ hours = 24 } = {}) {
  const [operating, worker] = await Promise.all([
    buildLunaL5OperatingReport({ hours }),
    buildLunaEntryTriggerWorkerReadiness({ hours }),
  ]);
  return evaluateLunaLiveFireReadinessGate({
    operating,
    worker,
    minShadowReadyBlocked: Math.max(0, Math.round(numEnv('LUNA_LIVE_FIRE_MIN_SHADOW_READY_BLOCKED', 0))),
    runtimeLiveFireEnabled: runtimeEnvTrue('LUNA_LIVE_FIRE_ENABLED'),
    runtimeDiscoveryMode: runtimeEnv('LUNA_INTELLIGENT_DISCOVERY_MODE') || null,
  });
}

export async function runLunaLiveFireReadinessGateSmoke() {
  const ready = evaluateLunaLiveFireReadinessGate({
    operating: {
      status: 'luna_l5_operating',
      readinessWarnings: [],
      killSwitches: {
        LUNA_VALIDATION_ENABLED: 'true',
        LUNA_PREDICTION_ENABLED: 'true',
      },
    },
    worker: {
      ok: true,
      status: 'entry_trigger_worker_ready',
      heartbeat: { ageMinutes: 1, payload: { result: { mode: 'shadow', allowLiveFire: false, readyBlocked: 2 } } },
      stats: { duplicateFiredScopeCount: 0 },
    },
    minShadowReadyBlocked: 1,
  });
  assert.equal(ready.ok, true);
  assert.equal(ready.status, 'live_fire_ready');
  assert.ok(ready.commands[0].includes('LUNA_INTELLIGENT_DISCOVERY_MODE'));

  const blocked = evaluateLunaLiveFireReadinessGate({
    operating: {
      status: 'luna_l5_operating',
      readinessWarnings: [],
      killSwitches: {
        LUNA_VALIDATION_ENABLED: 'true',
        LUNA_PREDICTION_ENABLED: 'true',
      },
    },
    worker: {
      ok: true,
      heartbeat: { ageMinutes: 1, payload: { result: { mode: 'shadow', allowLiveFire: false, readyBlocked: 2 } } },
      stats: { duplicateFiredScopeCount: 1 },
    },
  });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.blockers.some((item) => item.includes('duplicate_fired_scopes')));

  const migrated = evaluateLunaLiveFireReadinessGate({
    operating: {
      status: 'luna_l5_operating',
      readinessWarnings: [],
      killSwitches: {
        LUNA_VALIDATION_ENABLED: 'true',
        LUNA_PREDICTION_ENABLED: 'true',
      },
    },
    worker: {
      ok: true,
      status: 'entry_trigger_worker_migrated_to_luna_skill',
      heartbeat: { ageMinutes: 99, payload: { result: { mode: 'autonomous_l5', allowLiveFire: false } } },
      stats: { duplicateFiredScopeCount: 0 },
    },
  });
  assert.equal(migrated.ok, true);
  assert.equal(migrated.status, 'live_fire_ready');
  assert.equal(migrated.allowLiveFire, false);
  assert.equal(migrated.heartbeatAllowLiveFire, false);
  assert.equal(migrated.blockers.some((item) => item.includes('worker_heartbeat_stale')), false);

  const runtimeEnabled = evaluateLunaLiveFireReadinessGate({
    operating: {
      status: 'luna_l5_operating',
      readinessWarnings: [],
      killSwitches: {
        LUNA_VALIDATION_ENABLED: 'true',
        LUNA_PREDICTION_ENABLED: 'true',
      },
    },
    worker: {
      ok: true,
      status: 'entry_trigger_worker_migrated_to_luna_skill',
      heartbeat: { ageMinutes: 99, payload: { result: { mode: 'autonomous_l5', allowLiveFire: false } } },
      stats: { duplicateFiredScopeCount: 0 },
    },
    runtimeLiveFireEnabled: true,
    runtimeDiscoveryMode: 'autonomous_l5',
  });
  assert.equal(runtimeEnabled.ok, true);
  assert.equal(runtimeEnabled.status, 'live_fire_already_enabled');
  assert.equal(runtimeEnabled.allowLiveFire, true);

  return { ok: true, ready, blocked, migrated, runtimeEnabled };
}

async function main() {
  const json = boolArg('--json');
  const smoke = boolArg('--smoke');
  const report = smoke ? await runLunaLiveFireReadinessGateSmoke() : await buildLunaLiveFireReadinessGate();
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(smoke ? 'luna live-fire readiness gate smoke ok' : renderLunaLiveFireReadinessGate(report));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna live-fire readiness gate 실패:',
  });
}
