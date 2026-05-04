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

function tsxStepWithArgs(tsxBin: string, scriptDir: string, hubRoot: string, script: string, args: string[] = []): Step {
  return {
    label: `${script} ${args.join(' ')}`.trim(),
    command: tsxBin,
    args: [path.join(scriptDir, script), ...args],
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
    'multi-team-agent-llm-primary-fallback-drill.ts',
    'team-llm-route-drill-report-smoke.ts',
    'agent-hub-transition-audit.ts',
    'hub-transition-completion-gate.ts',
    'llm-routing-standard-smoke.ts',
    'investment-selector-explicit-keys-smoke.ts',
    'llm-oauth-4-balance-smoke.ts',
    'llm-oauth4-rollout-launchd-smoke.ts',
    'llm-oauth4-master-review-smoke.ts',
    'llm-oauth4-master-review-launchd-smoke.ts',
    'llm-anthropic-primary-audit.ts',
    'gemini-route-assignment-smoke.ts',
    'steward-gemini-model-drill-smoke.ts',
    'oauth-ops-readiness-smoke.ts',
    'telegram-pending-queue-migration-smoke.ts',
    'telegram-hub-secrets-smoke.ts',
    'telegram-topic-routing-precedence-smoke.ts',
    'telegram-personal-fallback-guard-smoke.ts',
    'control-plane-smoke.ts',
    'jay-orchestration-readiness-smoke.ts',
    'jay-formation-decision-llm-smoke.ts',
    'jay-control-plan-integration-smoke.ts',
    'jay-observer-smoke.ts',
    'jay-incident-e2e-dry-run-smoke.ts',
    'jay-runtime-cutover-drill-smoke.ts',
    'jay-commander-bot-command-smoke.ts',
    'jay-telegram-meeting-dry-run.ts',
    'jay-staged-enable-plan.ts',
    'jay-status-report.ts',
    'jay-incident-janitor.ts',
    'jay-commander-queue-hygiene.ts',
    'jay-runtime-launchd-smoke.ts',
    'jay-runtime-lock-smoke.ts',
    'jay-runtime-process-check.ts',
    'jay-readiness.ts',
    'commander-contract-adherence-smoke.ts',
    'jay-3tier-routing-smoke.ts',
    'jay-skill-extraction-smoke.ts',
    'jay-skill-reuse-smoke.ts',
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
    'gemini-cli-live-error-smoke.ts',
    'gemini-codeassist-service-status-smoke.ts',
    'gemini-oauth-project-readiness-smoke.ts',
    'gemini-quota-project-policy-smoke.ts',
    'gemini-codeassist-oauth-direct-smoke.ts',
    'hub-unified-oauth-direct-smoke.ts',
    'claude-code-oauth-direct-smoke.ts',
    'oauth-refresh-monitor-contract-smoke.ts',
    'oauth-refresh-lock-smoke.ts',
    'oauth-refresh-lock-janitor-smoke.ts',
    'oauth-provider-boundary-smoke.ts',
    'oauth-monitor-launchd-smoke.ts',
    'runtime-profile-settings-smoke.ts',
    'server-hardening-smoke.ts',
    'local-embedding-health-smoke.ts',
    'steward-local-embedding-alarm-smoke.ts',
    'retired-gateway-marker-precommit-smoke.ts',
    'blog-alarm-dedup-smoke.ts',
    'alarm-activation-stage1-smoke.ts',
    'alarm-activation-stage2-smoke.ts',
    'alarm-activation-stage3-smoke.ts',
    'luna-live-fire-callback-smoke.ts',
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

function runNodeImportTest(hubRoot: string, relativeFile: string): void {
  runStep({
    label: relativeFile,
    command: process.execPath,
    args: ['--import', 'tsx', '--test', relativeFile],
    cwd: hubRoot,
  });
}

function runUnit(scriptDir: string, hubRoot: string, jestBin: string, tsxBin: string): void {
  runStep(tsxStep(tsxBin, scriptDir, hubRoot, 'secret-leak-smoke.ts'));
  runNodeImportTest(hubRoot, '__tests__/alarm-policy.node.test.js');
  runStep(unitJestStep(jestBin, hubRoot));
  runSteps(unitSmokeScripts().map((script) => {
    if (script === 'retired-gateway-residue-audit.ts') {
      return tsxStepWithArgs(tsxBin, scriptDir, hubRoot, script, ['--check-only']);
    }
    if (script === 'jay-commander-queue-hygiene.ts') {
      return tsxStepWithArgs(tsxBin, scriptDir, hubRoot, script, ['--smoke']);
    }
    return tsxStep(tsxBin, scriptDir, hubRoot, script);
  }));
}

function runRuntime(scriptDir: string, hubRoot: string, tsxBin: string): void {
  const runtimeScripts = [
    'jay-incident-store-smoke.ts',
    'team-bus-bridging-smoke.ts',
    'jay-to-commander-dispatch-smoke.ts',
    'session-compaction-smoke.ts',
    'launchd-callback-secret-smoke.ts',
    'oauth-runtime-refresh-gate.ts',
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
