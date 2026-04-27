#!/usr/bin/env tsx

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

type StepResult = {
  label: string;
  ok: boolean;
  status: number;
};

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const hubRoot = path.resolve(__dirname, '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

function runStep(label: string, args: string[]): StepResult {
  const result = spawnSync(tsxBin, args, {
    cwd: hubRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ok = Number(result.status) === 0;
  if (!ok) {
    process.stderr.write(`[${label}] failed\n${result.stdout || ''}${result.stderr || ''}\n`);
  }
  return { label, ok, status: Number(result.status ?? 1) };
}

function readJson(relativePath: string): any {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function main(): void {
  const steps = [
    runStep('transition-completion-gate', ['scripts/hub-transition-completion-gate.ts']),
    runStep('hub-alarm-inventory', ['scripts/generate-hub-alarm-inventory.ts']),
    runStep('retired-gateway-residue-audit', ['scripts/retired-gateway-residue-audit.ts']),
    runStep('openclaw-runtime-retirement', ['scripts/openclaw-runtime-retirement-smoke.ts']),
  ];

  const alarmInventory = readJson('bots/hub/output/hub-alarm-dependency-inventory.json');
  const residueAudit = readJson('bots/hub/output/openclaw-residue-audit.json');
  const blocking = {
    failed_steps: steps.filter((step) => !step.ok).map((step) => step.label),
    legacy_gateway_compat: Number(alarmInventory.categories?.legacy_gateway_compat || 0),
    runtime_blocker: Number(residueAudit.categories?.runtime_blocker || 0),
  };
  const actionRequired = {
    dirty_worktree: Number(residueAudit.categories?.dirty_worktree || 0),
    ignored_log: Number(residueAudit.categories?.ignored_log || 0),
    retired_home_archive_pending: Number(residueAudit.categories?.retired_home_archive_pending || 0),
  };
  const ok = blocking.failed_steps.length === 0
    && blocking.legacy_gateway_compat === 0
    && blocking.runtime_blocker === 0;

  console.log(JSON.stringify({
    ok,
    blocking,
    action_required: actionRequired,
    note: 'action_required entries are retained for explicit archive/delete decisions; they are not live runtime blockers.',
  }, null, 2));

  if (!ok) process.exit(1);
}

main();
