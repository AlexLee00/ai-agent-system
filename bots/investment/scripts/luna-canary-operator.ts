#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaValidationCanaryPreflight } from './luna-validation-canary-preflight.ts';
import { buildLunaPredictionCanaryPreflight } from './luna-prediction-canary-preflight.ts';

const PHASES = {
  validation: {
    key: 'LUNA_VALIDATION_ENABLED',
    preflight: buildLunaValidationCanaryPreflight,
  },
  prediction: {
    key: 'LUNA_PREDICTION_ENABLED',
    preflight: buildLunaPredictionCanaryPreflight,
  },
};

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    phase: 'validation',
    apply: false,
    rollback: false,
    verify: false,
    json: false,
    hours: 24,
  };
  for (const raw of argv) {
    if (raw === '--apply') args.apply = true;
    else if (raw === '--rollback') args.rollback = true;
    else if (raw === '--verify') args.verify = true;
    else if (raw === '--json') args.json = true;
    else if (raw.startsWith('--phase=')) args.phase = String(raw.split('=').slice(1).join('=') || 'validation').trim();
    else if (raw.startsWith('--hours=')) args.hours = Math.max(1, Number(raw.split('=').slice(1).join('=') || 24));
  }
  return args;
}

function runCommand(command, args = [], { env = null } = {}) {
  const proc = spawnSync(command, args, {
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  });
  return {
    ok: proc.status === 0,
    status: proc.status,
    stdout: String(proc.stdout || '').trim(),
    stderr: String(proc.stderr || '').trim(),
    command: [command, ...args].join(' '),
  };
}

export async function buildLunaCanaryOperationPlan({
  phase = 'validation',
  rollback = false,
  hours = 24,
} = {}) {
  const spec = PHASES[phase];
  if (!spec) throw new Error(`unsupported_canary_phase:${phase}`);
  const preflight = await spec.preflight({ hours });
  const alreadyEnabled = preflight?.alreadyEnabled === true;
  const target = rollback ? 'false' : 'true';
  const setCommand = `launchctl setenv ${spec.key} ${target}`;
  const rollbackCommand = `launchctl setenv ${spec.key} false`;
  const verifyCommands = [
    `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s check:luna-l5`,
    `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-l5-readiness -- --telegram`,
  ];
  const ready = rollback || preflight.ok === true;
  return {
    ok: ready,
    checkedAt: new Date().toISOString(),
    phase,
    key: spec.key,
    target,
    status: ready
      ? (rollback ? 'ready_to_rollback' : alreadyEnabled ? 'already_enabled' : 'ready_to_enable')
      : 'blocked',
    blockers: ready ? [] : (preflight.blockers || ['preflight_not_ready']),
    dryRun: true,
    command: alreadyEnabled && !rollback ? null : setCommand,
    rollbackCommand,
    verifyCommands,
    preflight,
  };
}

export async function runLunaCanaryOperation({
  phase = 'validation',
  rollback = false,
  apply = false,
  verify = false,
  hours = 24,
} = {}) {
  const plan = await buildLunaCanaryOperationPlan({ phase, rollback, hours });
  if (!apply) return plan;
  if (!plan.ok) {
    return {
      ...plan,
      applied: false,
      dryRun: false,
      applyError: 'preflight_blocked',
    };
  }
  const applied = runCommand('launchctl', ['setenv', plan.key, plan.target]);
  if (applied.ok) process.env[plan.key] = plan.target;
  const verified = verify
    ? runCommand(
        'npm',
        ['--prefix', '/Users/alexlee/projects/ai-agent-system/bots/investment', 'run', '-s', 'check:luna-l5'],
        { env: { [plan.key]: plan.target } },
      )
    : null;
  return {
    ...plan,
    dryRun: false,
    applied: applied.ok,
    applyResult: applied,
    verified: verified ? verified.ok : null,
    verifyResult: verified,
  };
}

export async function runLunaCanaryOperatorSmoke() {
  const validation = await buildLunaCanaryOperationPlan({ phase: 'validation' });
  assert.equal(validation.key, 'LUNA_VALIDATION_ENABLED');
  assert.ok(validation.rollbackCommand.includes('LUNA_VALIDATION_ENABLED false'));
  assert.ok(Array.isArray(validation.verifyCommands));
  const prediction = await buildLunaCanaryOperationPlan({ phase: 'prediction' });
  assert.equal(prediction.key, 'LUNA_PREDICTION_ENABLED');
  assert.ok(prediction.preflight?.predictiveSmoke?.ok);
  return { ok: true, validation, prediction };
}

async function main() {
  const args = parseArgs();
  const result = await runLunaCanaryOperation(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`luna canary operator — ${result.phase}/${result.key}: ${result.status}`);
    console.log(`command: ${result.command}`);
    console.log(`rollback: ${result.rollbackCommand}`);
    if (result.blockers?.length) console.log(`blockers: ${result.blockers.join(' / ')}`);
    if (result.applied != null) console.log(`applied: ${result.applied}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna canary operator 실패:',
  });
}
