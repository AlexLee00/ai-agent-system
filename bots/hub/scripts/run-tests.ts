#!/usr/bin/env tsx

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type TestTarget = 'all' | 'secrets-meta' | 'unit' | 'runtime' | 'runtime-live';
type Step = {
  label: string;
  command: string;
  args: string[];
  cwd?: string;
};

function run(command: string, args: string[], cwd?: string): number {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd });
  return Number(result.status ?? 1);
}

function runStep(step: Step): void {
  const status = run(step.command, step.args, step.cwd);
  if (status !== 0) {
    console.error(`[hub test] failed step: ${step.label}`);
    process.exit(status);
  }
}

function isEnabledFlag(name: string): boolean {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function tsxStep(tsxBin: string, scriptDir: string, hubRoot: string, script: string): Step {
  return {
    label: script,
    command: tsxBin,
    args: [path.join(scriptDir, script)],
    cwd: hubRoot,
  };
}

function runSteps(steps: Step[]): void {
  for (const step of steps) runStep(step);
}

function unitJestStep(jestBin: string, hubRoot: string): Step {
  return {
    label: 'jest unit suites',
    command: jestBin,
    cwd: hubRoot,
    args: [
      '__tests__/request-context.test.ts',
      '__tests__/llm-request-schema.test.ts',
      '__tests__/admission-control.test.ts',
      '__tests__/oauth-redaction.test.ts',
      '__tests__/oauth-local-import.test.ts',
      '__tests__/oauth-flow.test.ts',
      '__tests__/control-plan-schema.test.ts',
      '__tests__/control-planner.test.ts',
      '__tests__/control-tool-registry.test.ts',
      '__tests__/telegram-callback-router.test.ts',
      '--runInBand',
    ],
  };
}

function unitSmokeScripts(): string[] {
  const legacyIsolationScript = (prefix: string) => `${prefix}-runtime-legacy-gateway-isolation-smoke.ts`;
  return [
    'app-factory-smoke.ts',
    'hub-alarm-delivery-acceptance-smoke.ts',
    'alarm-governor-smoke.ts',
    'alarm-autonomy-contract-smoke.ts',
    'auto-dev-alarm-result-smoke.ts',
    'alarm-contract-audit-smoke.ts',
    'hub-alarm-no-legacy-shim-smoke.ts',
    'hub-alarm-env-smoke.ts',
    'hub-alarm-import-transition-smoke.ts',
    'hub-postalarm-no-legacy-fallback-smoke.ts',
    'legacy-gateway-independence-smoke.ts',
    'retired-gateway-residue-audit.ts',
    'runtime-workspace-independence-smoke.ts',
    'runtime-env-policy-smoke.ts',
    'file-guard-retired-workspace-smoke.ts',
    'sse-event-guard-smoke.ts',
    'session-checkpoint-smoke.ts',
    'hub-js-ts-island-smoke.ts',
    'hub-resilience-contract-smoke.ts',
    legacyIsolationScript('active'),
    'legacy-gateway-admin-guard-smoke.ts',
    'public-api-optional-smoke.ts',
    legacyIsolationScript('claude'),
    legacyIsolationScript('investment'),
    legacyIsolationScript('reservation'),
    'llm-control-independence-smoke.ts',
    'provider-circuit-standard-smoke.ts',
    'llm-cooldown-reset-smoke.ts',
    'llm-direct-provider-route-guard-smoke.ts',
    'team-llm-route-drill.ts',
    'team-llm-route-drill-report-smoke.ts',
    'agent-hub-transition-audit.ts',
    'hub-transition-completion-gate.ts',
    'video-hub-transition-smoke.ts',
    'llm-routing-standard-smoke.ts',
    'gemini-route-assignment-smoke.ts',
    'telegram-pending-queue-migration-smoke.ts',
    'telegram-hub-secrets-smoke.ts',
    'telegram-topic-routing-precedence-smoke.ts',
    'telegram-personal-fallback-guard-smoke.ts',
    'control-plane-smoke.ts',
    'l5-acceptance-smoke.ts',
    'openai-oauth-direct-smoke.ts',
    'openai-oauth-token-store-smoke.ts',
    'openai-codex-backend-direct-smoke.ts',
    'openai-codex-chatgpt-backend-canary-smoke.ts',
    'openai-oauth-canary-permission-smoke.ts',
    'gemini-oauth-smoke.ts',
    'gemini-oauth-direct-smoke.ts',
    'gemini-cli-oauth-import-smoke.ts',
    'gemini-cli-oauth-adapter-smoke.ts',
    'gemini-oauth-project-readiness-smoke.ts',
    'gemini-codeassist-oauth-direct-smoke.ts',
    'hub-unified-oauth-direct-smoke.ts',
    'claude-code-oauth-direct-smoke.ts',
    'oauth-refresh-monitor-contract-smoke.ts',
    'oauth-provider-boundary-smoke.ts',
    'oauth-monitor-launchd-smoke.ts',
    'runtime-profile-settings-smoke.ts',
    'server-hardening-smoke.ts',
    'retired-gateway-marker-precommit-smoke.ts',
    'blog-alarm-dedup-smoke.ts',
  ];
}

function runSecretsMeta(hubRoot: string): void {
  runStep({
    label: 'secrets metadata node tests',
    command: process.execPath,
    args: ['--test', '__tests__/secrets-meta.node.test.js'],
    cwd: hubRoot,
  });
}

function runUnit(scriptDir: string, hubRoot: string, jestBin: string, tsxBin: string): void {
  runStep(tsxStep(tsxBin, scriptDir, hubRoot, 'secret-leak-smoke.ts'));
  runStep(unitJestStep(jestBin, hubRoot));
  runSteps(unitSmokeScripts().map((script) => tsxStep(tsxBin, scriptDir, hubRoot, script)));
}

function runRuntime(scriptDir: string, hubRoot: string, tsxBin: string): void {
  const runtimeScripts = [
    'launchd-callback-secret-smoke.ts',
    'team-oauth-readiness-report.ts',
    ...(isEnabledFlag('HUB_RUNTIME_CHECK_LIVE_LLM') ? ['team-llm-route-drill.ts'] : []),
    'telegram-topic-routing-live-smoke.ts',
    'telegram-routing-readiness-report.ts',
    'telegram-team-topic-monitor.ts',
    'launchd-alarm-class-topic-smoke.ts',
    'openclaw-runtime-retirement-smoke.ts',
  ];
  runSteps(runtimeScripts.map((script) => tsxStep(tsxBin, scriptDir, hubRoot, script)));
}

function main(): void {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const hubRoot = path.resolve(scriptDir, '..');
  const repoRoot = path.resolve(hubRoot, '..', '..');
  const jestBin = path.join(repoRoot, 'node_modules', '.bin', 'jest');
  const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
  const args = process.argv.slice(2).filter(Boolean);
  const target = (args.find((arg) => !arg.startsWith('-')) || 'all') as TestTarget;

  if (target === 'runtime-live') {
    process.env.HUB_RUNTIME_CHECK_LIVE_LLM ||= '1';
    process.env.HUB_TEAM_LLM_DRILL_LIVE ||= '1';
  }

  if (target === 'secrets-meta') {
    runSecretsMeta(hubRoot);
    return;
  }
  if (target === 'unit') {
    runUnit(scriptDir, hubRoot, jestBin, tsxBin);
    return;
  }
  if (target === 'runtime' || target === 'runtime-live') {
    runRuntime(scriptDir, hubRoot, tsxBin);
    return;
  }
  if (target === 'all') {
    runSecretsMeta(hubRoot);
    runUnit(scriptDir, hubRoot, jestBin, tsxBin);
    return;
  }

  console.error(`[hub test] unknown target: ${target}`);
  console.error('[hub test] supported targets: all, secrets-meta, unit, runtime, runtime-live');
  process.exit(1);
}

main();
