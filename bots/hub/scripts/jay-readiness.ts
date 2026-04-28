#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function hasArg(name) {
  return process.argv.includes(name);
}

function runStep(name, script, args = []) {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
  const startedAt = Date.now();
  const result = spawnSync(tsxBin, [path.join(__dirname, script), ...args], {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    name,
    ok: Number(result.status || 0) === 0,
    status: Number(result.status || 0),
    durationMs: Date.now() - startedAt,
    stdout: String(result.stdout || '').trim().slice(0, 4000),
    stderr: String(result.stderr || '').trim().slice(0, 4000),
  };
}

function parseJsonOutput(text) {
  try {
    return JSON.parse(String(text || '').trim());
  } catch {
    return null;
  }
}

async function main() {
  const strict = hasArg('--strict');
  const requireProcess = hasArg('--require-process');
  const json = hasArg('--json') || strict;
  const steps = [
    runStep('cutover_plan', 'jay-staged-enable-plan.ts', ['--json']),
    runStep('status', 'jay-status-report.ts', ['--json']),
    runStep('incident_janitor', 'jay-incident-janitor.ts', ['--json']),
    runStep('incident_e2e_dry_run', 'jay-incident-e2e-dry-run-smoke.ts'),
    runStep('telegram_meeting_dry_run', 'jay-telegram-meeting-dry-run.ts'),
    runStep('commander_bot_command', 'jay-commander-bot-command-smoke.ts'),
    runStep('runtime_launchd', 'jay-runtime-launchd-smoke.ts'),
    runStep('runtime_process', 'jay-runtime-process-check.ts', requireProcess ? ['--strict', '--json'] : ['--json']),
    runStep('orchestration_readiness', 'jay-orchestration-readiness-smoke.ts'),
  ];

  const cutover = parseJsonOutput(steps[0].stdout);
  const strictReady = !strict || (cutover && cutover.readyCount === cutover.total);
  const payload = {
    ok: steps.every((step) => step.ok) && strictReady,
    strict,
    requireProcess,
    strictReady,
    cutover: cutover
      ? {
        readyCount: cutover.readyCount,
        total: cutover.total,
        adapterModes: cutover.adapterModes,
      }
      : null,
    steps,
  };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`# Jay readiness (${payload.ok ? 'ok' : 'needs-attention'})`);
    if (payload.cutover) {
      console.log(`cutover: ${payload.cutover.readyCount}/${payload.cutover.total} ready`);
      console.log(`adapters: ${JSON.stringify(payload.cutover.adapterModes)}`);
    }
    for (const step of steps) {
      console.log(`- ${step.ok ? 'ok' : 'fail'} ${step.name} (${step.durationMs}ms)`);
      if (!step.ok && step.stderr) console.log(`  ${step.stderr.split('\n')[0]}`);
    }
  }

  if (!payload.ok) process.exit(1);
}

main().catch((error) => {
  console.error(`jay_readiness_failed: ${error?.message || error}`);
  process.exit(1);
});
