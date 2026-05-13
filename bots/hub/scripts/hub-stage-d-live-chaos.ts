#!/usr/bin/env tsx

const fs = require('node:fs');

const {
  DEFAULT_ALLOWED_PATHS,
  MAX_SAFE_LATENCY_MS,
  MAX_SAFE_PERCENT,
  STATE_FILE,
  readChaosState,
} = require('../src/middleware/stage-d-chaos');

const CONFIRM_1PCT = 'hub-stage-d-live-chaos-1pct';

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function argValue(name: string): string | null {
  const prefix = `${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix));
  return raw ? raw.slice(prefix.length) : null;
}

function clamp(value: unknown, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function buildState(percent: number, latencyMs: number, ttlMinutes: number) {
  return {
    enabled: true,
    mode: 'live_canary_latency',
    percent,
    latencyMs,
    allowedPaths: Array.from(DEFAULT_ALLOWED_PATHS),
    expiresAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
    updatedBy: 'hub-stage-d-live-chaos',
  };
}

async function main(): Promise<void> {
  const apply = hasFlag('--apply');
  const disable = hasFlag('--disable');
  const confirm = argValue('--confirm');
  const percent = clamp(argValue('--percent') || 1, 0, MAX_SAFE_PERCENT);
  const latencyMs = clamp(argValue('--latency-ms') || 500, 0, MAX_SAFE_LATENCY_MS);
  const ttlMinutes = clamp(argValue('--ttl-minutes') || 10, 1, 60);

  const result: any = {
    ok: true,
    checkedAt: new Date().toISOString(),
    stage: 'hub_stage_d',
    task: 'D5_live_chaos',
    dryRun: !apply,
    stateFile: STATE_FILE,
    currentState: readChaosState(),
    requested: { percent, latencyMs, ttlMinutes, disable },
    safety: {
      defaultDisabled: true,
      maxSafePercent: MAX_SAFE_PERCENT,
      maxSafeLatencyMs: MAX_SAFE_LATENCY_MS,
      allowedPaths: Array.from(DEFAULT_ALLOWED_PATHS),
      protectedServiceMutation: false,
      dataMutation: false,
    },
    applyGate: `--apply --confirm=${CONFIRM_1PCT} --percent=1 --latency-ms=500`,
  };

  if (!apply) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (confirm !== CONFIRM_1PCT) {
    result.ok = false;
    result.error = 'confirm_required';
    result.requiredConfirm = CONFIRM_1PCT;
    console.log(JSON.stringify(result, null, 2));
    process.exit(2);
  }
  if (percent > 1) {
    result.ok = false;
    result.error = 'percent_above_1_requires_separate_master_approval';
    console.log(JSON.stringify(result, null, 2));
    process.exit(2);
  }

  if (disable) {
    fs.writeFileSync(STATE_FILE, `${JSON.stringify({ enabled: false, mode: 'disabled', updatedAt: new Date().toISOString() }, null, 2)}\n`);
  } else {
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(buildState(percent, latencyMs, ttlMinutes), null, 2)}\n`);
  }
  result.currentState = readChaosState();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: Error) => {
  console.error(error);
  process.exit(1);
});
