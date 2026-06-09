#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process';
import path from 'node:path';

type SmokeStep = {
  label: string;
  scriptPath: string;
};

function run(tsxBin: string, step: SmokeStep, cwd: string): void {
  const result = spawnSync(tsxBin, [step.scriptPath], { stdio: 'inherit', cwd });
  const status = Number(result.status ?? 1);
  if (status !== 0) {
    throw new Error(`smoke_failed:${step.label}`);
  }
}

function buildSteps(repoRoot: string): SmokeStep[] {
  const hubScripts = path.join(repoRoot, 'bots', 'hub', 'scripts');
  const names = [
    'jay-formation-decision-llm-smoke.ts',
    'jay-control-plan-integration-smoke.ts',
    'jay-incident-store-smoke.ts',
    'commander-contract-adherence-smoke.ts',
    'team-bus-bridging-smoke.ts',
    'jay-to-commander-dispatch-smoke.ts',
    'jay-3tier-routing-smoke.ts',
    'jay-skill-extraction-smoke.ts',
    'jay-skill-reuse-smoke.ts',
    'session-compaction-smoke.ts',
  ];
  return names.map((name) => ({
    label: name,
    scriptPath: path.join(hubScripts, name),
  }));
}

function main() {
  const currentDir = __dirname;
  const repoRoot = path.resolve(currentDir, '..', '..', '..');
  const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
  const steps = buildSteps(repoRoot);
  for (const step of steps) run(tsxBin, step, repoRoot);
  console.log('jay_orchestration_smoke_suite_ok');
}

main();
