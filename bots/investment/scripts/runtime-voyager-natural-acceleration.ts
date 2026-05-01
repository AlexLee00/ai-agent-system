#!/usr/bin/env node
// @ts-nocheck
import {
  VOYAGER_NATURAL_ACCELERATION_CONFIRM,
  runVoyagerNaturalAcceleration,
} from '../shared/voyager-natural-acceleration.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasArg(name) {
  return process.argv.includes(`--${name}`);
}

export async function runVoyagerNaturalAccelerationSmoke() {
  const result = await runVoyagerNaturalAcceleration({
    days: 30,
    market: 'crypto',
    dryRun: true,
    enabled: false,
    extractFn: async () => ({ ok: true, candidates: 9, extracted: 4, dryRun: true }),
  });
  if (!result.ok || result.status !== 'disabled_default_off' || result.applied) {
    throw new Error('default-off dry-run acceleration contract failed');
  }
  const blocked = await runVoyagerNaturalAcceleration({
    days: 30,
    market: 'crypto',
    dryRun: false,
    enabled: true,
    confirm: 'wrong',
    extractFn: async () => ({ ok: true, candidates: 9, extracted: 4, dryRun: false }),
  });
  if (blocked.ok || blocked.status !== 'confirm_required') {
    throw new Error('confirmed apply gate must block missing confirm');
  }
  return { ok: true, result, blocked, confirmRequired: VOYAGER_NATURAL_ACCELERATION_CONFIRM };
}

async function main() {
  const result = hasArg('smoke')
    ? await runVoyagerNaturalAccelerationSmoke()
    : await runVoyagerNaturalAcceleration({
      days: Number(argValue('days', 365)),
      market: argValue('market', 'all'),
      dryRun: !hasArg('apply'),
      apply: hasArg('apply'),
      confirm: argValue('confirm', ''),
    });
  if (hasArg('json') || hasArg('smoke')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`[voyager-natural-acceleration] ${result.status} projected=${result.projectedTotalSkills || 0}/${result.targetSkillCount || 0}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ voyager-natural-acceleration 실패:',
  });
}
