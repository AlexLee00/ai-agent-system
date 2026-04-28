#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function hasArg(name) {
  return process.argv.includes(name);
}

function run(script, args = []) {
  const startedAt = Date.now();
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const result = spawnSync(path.join(repoRoot, 'node_modules', '.bin', 'tsx'), [path.join(__dirname, script), ...args], {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    script,
    args,
    ok: Number(result.status || 0) === 0,
    status: Number(result.status || 0),
    durationMs: Date.now() - startedAt,
    stdout: String(result.stdout || '').trim().slice(0, 5000),
    stderr: String(result.stderr || '').trim().slice(0, 2000),
  };
}

async function main() {
  const json = hasArg('--json');
  const steps = [
    run('jay-runtime-env-check.ts', ['--json']),
    run('jay-runtime-launchd-smoke.ts'),
    run('jay-readiness.ts', ['--strict']),
    run('team-llm-route-drill.ts', ['--mock', '--json']),
    run('telegram-routing-readiness-report.ts', ['--json']),
    run('hub-transition-completion-gate.ts'),
    run('jay-runtime-process-check.ts', ['--json']),
  ];
  const payload = {
    ok: steps.every((step) => step.ok),
    steps,
  };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`# Jay runtime preflight (${payload.ok ? 'ok' : 'needs-attention'})`);
    for (const step of steps) {
      console.log(`- ${step.ok ? 'ok' : 'fail'} ${step.script} (${step.durationMs}ms)`);
      if (!step.ok) {
        const first = (step.stderr || step.stdout || '').split('\n')[0];
        if (first) console.log(`  ${first}`);
      }
    }
  }

  if (!payload.ok) process.exit(1);
}

main().catch((error) => {
  console.error(`jay_runtime_preflight_failed: ${error?.message || error}`);
  process.exit(1);
});
