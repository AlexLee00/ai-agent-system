#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type RunOptions = {
  cwd?: string;
  allowFailure?: boolean;
};

type StepResult = {
  command: string;
  args: string[];
  ok: boolean;
  status: number;
  ignoredFailure?: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
};

function hasArg(name: string) {
  return process.argv.includes(name);
}

function run(command: string, args: string[], options: RunOptions = {}): StepResult {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd || path.resolve(__dirname, '..', '..', '..'),
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    command,
    args,
    ok: Number(result.status || 0) === 0 || Boolean(options.allowFailure),
    status: Number(result.status || 0),
    ignoredFailure: Number(result.status || 0) !== 0 && Boolean(options.allowFailure),
    durationMs: Date.now() - startedAt,
    stdout: String(result.stdout || '').trim().slice(0, 4000),
    stderr: String(result.stderr || '').trim().slice(0, 4000),
  };
}

function launchdLabel(plistName: string) {
  return plistName.replace(/\.plist$/, '');
}

function tsxStep(script: string, args: string[] = []) {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  return run(path.join(repoRoot, 'node_modules', '.bin', 'tsx'), [path.join(__dirname, script), ...args], {
    cwd: repoRoot,
  });
}

function copyLaunchAgent(plistName: string) {
  const source = path.resolve(__dirname, '..', '..', 'orchestrator', 'launchd', plistName);
  const targetDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const target = path.join(targetDir, plistName);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(source, target);
  return target;
}

async function main() {
  const apply = hasArg('--apply');
  const strict = hasArg('--strict') || apply;
  const json = hasArg('--json') || apply;
  const steps: StepResult[] = [];

  const preflight = tsxStep('jay-runtime-preflight.ts', ['--json']);
  steps.push(preflight);

  const installed: string[] = [];
  if (apply && preflight.ok) {
    for (const plistName of ['ai.jay.runtime.plist', 'ai.jay.incident-janitor.plist']) {
      const target = copyLaunchAgent(plistName);
      const label = launchdLabel(plistName);
      const uid = typeof process.getuid === 'function'
        ? process.getuid()
        : Number(spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim());
      const userLabel = `gui/${uid}/${label}`;
      installed.push(target);
      steps.push(run('launchctl', ['bootout', userLabel], { allowFailure: true }));
      steps.push(run('launchctl', ['bootstrap', `gui/${uid}`, target]));
      steps.push(run('launchctl', ['enable', userLabel]));
      steps.push(run('launchctl', ['kickstart', '-k', userLabel]));
    }
  } else if (apply && !preflight.ok) {
    steps.push({
      command: 'jay-runtime-cutover',
      args: ['apply'],
      ok: false,
      status: 1,
      durationMs: 0,
      stdout: '',
      stderr: 'preflight_failed_apply_aborted',
    });
  }

  steps.push(apply && preflight.ok
    ? tsxStep('jay-runtime-postcheck.ts', ['--json'])
    : tsxStep('jay-runtime-process-check.ts', ['--json']));
  const payload = {
    ok: steps.every((step) => step.ok),
    apply,
    strict,
    installed,
    steps: steps.map((step) => ({
      command: step.command,
      args: step.args,
      ok: step.ok,
      status: step.status,
      ignoredFailure: step.ignoredFailure || undefined,
      durationMs: step.durationMs,
      stdout: step.stdout,
      stderr: step.stderr,
    })),
  };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`# Jay runtime cutover (${payload.ok ? 'ok' : 'needs-attention'})`);
    console.log(`apply: ${apply}`);
    for (const step of payload.steps) {
      const label = [path.basename(step.command), ...step.args.map((arg) => path.basename(String(arg)))].join(' ');
      console.log(`- ${step.ok ? 'ok' : 'fail'} ${label} (${step.durationMs}ms)`);
      if (!step.ok && step.stderr) console.log(`  ${step.stderr.split('\n')[0]}`);
    }
  }

  if (!payload.ok) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(`jay_runtime_cutover_failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
