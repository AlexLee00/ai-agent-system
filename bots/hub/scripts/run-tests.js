#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  return Number(result.status ?? 1);
}

function main() {
  const scriptDir = __dirname;
  const repoRoot = path.resolve(scriptDir, '..', '..', '..');
  const jestBin = path.join(repoRoot, 'node_modules', '.bin', 'jest');
  const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
  const args = process.argv.slice(2).filter(Boolean);
  const target = args.find((arg) => !arg.startsWith('-')) || 'all';

  if (target === 'secrets-meta') {
    process.exit(run(process.execPath, ['--test', '__tests__/secrets-meta.node.test.js']));
  }
  if (target === 'unit') {
    const jestStatus = run(jestBin, [
      '__tests__/request-context.test.ts',
      '__tests__/llm-request-schema.test.ts',
      '__tests__/admission-control.test.ts',
      '__tests__/oauth-redaction.test.ts',
      '__tests__/oauth-local-import.test.ts',
      '__tests__/control-plan-schema.test.ts',
      '__tests__/control-planner.test.ts',
      '__tests__/control-tool-registry.test.ts',
      '__tests__/telegram-callback-router.test.ts',
      '--runInBand',
    ]);
    if (jestStatus !== 0) process.exit(jestStatus);
    const appFactoryStatus = run(tsxBin, [path.join(scriptDir, 'app-factory-smoke.ts')]);
    if (appFactoryStatus !== 0) process.exit(appFactoryStatus);
    const alarmStatus = run(tsxBin, [path.join(scriptDir, 'openclaw-hub-alarm-smoke.ts')]);
    if (alarmStatus !== 0) process.exit(alarmStatus);
    const alarmGovernorStatus = run(tsxBin, [path.join(scriptDir, 'alarm-governor-smoke.ts')]);
    if (alarmGovernorStatus !== 0) process.exit(alarmGovernorStatus);
    const alarmShimStatus = run(tsxBin, [path.join(scriptDir, 'hub-alarm-client-shim-smoke.ts')]);
    if (alarmShimStatus !== 0) process.exit(alarmShimStatus);
    const alarmEnvStatus = run(tsxBin, [path.join(scriptDir, 'hub-alarm-env-smoke.ts')]);
    if (alarmEnvStatus !== 0) process.exit(alarmEnvStatus);
    const postAlarmStatus = run(tsxBin, [path.join(scriptDir, 'openclaw-postalarm-fallback-smoke.ts')]);
    if (postAlarmStatus !== 0) process.exit(postAlarmStatus);
    const openClawIndependenceStatus = run(tsxBin, [path.join(scriptDir, 'openclaw-independence-smoke.ts')]);
    if (openClawIndependenceStatus !== 0) process.exit(openClawIndependenceStatus);
    const tgPendingMigrationStatus = run(tsxBin, [path.join(scriptDir, 'telegram-pending-queue-migration-smoke.ts')]);
    if (tgPendingMigrationStatus !== 0) process.exit(tgPendingMigrationStatus);
    const tgHubSecretsStatus = run(tsxBin, [path.join(scriptDir, 'telegram-hub-secrets-smoke.ts')]);
    if (tgHubSecretsStatus !== 0) process.exit(tgHubSecretsStatus);
    const controlPlaneStatus = run(tsxBin, [path.join(scriptDir, 'control-plane-smoke.ts')]);
    if (controlPlaneStatus !== 0) process.exit(controlPlaneStatus);
    const acceptanceStatus = run(tsxBin, [path.join(scriptDir, 'l5-acceptance-smoke.ts')]);
    if (acceptanceStatus !== 0) process.exit(acceptanceStatus);
    const openAiOauthStatus = run(tsxBin, [path.join(scriptDir, 'openai-oauth-direct-smoke.ts')]);
    if (openAiOauthStatus !== 0) process.exit(openAiOauthStatus);
    const openAiOauthTokenStoreStatus = run(tsxBin, [path.join(scriptDir, 'openai-oauth-token-store-smoke.ts')]);
    if (openAiOauthTokenStoreStatus !== 0) process.exit(openAiOauthTokenStoreStatus);
    const openAiCodexBackendDirectStatus = run(tsxBin, [path.join(scriptDir, 'openai-codex-backend-direct-smoke.ts')]);
    if (openAiCodexBackendDirectStatus !== 0) process.exit(openAiCodexBackendDirectStatus);
    const openAiCodexBackendCanaryStatus = run(tsxBin, [path.join(scriptDir, 'openai-codex-chatgpt-backend-canary-smoke.ts')]);
    if (openAiCodexBackendCanaryStatus !== 0) process.exit(openAiCodexBackendCanaryStatus);
    const openAiOauthCanaryStatus = run(tsxBin, [path.join(scriptDir, 'openai-oauth-canary-permission-smoke.ts')]);
    if (openAiOauthCanaryStatus !== 0) process.exit(openAiOauthCanaryStatus);
    const claudeOauthStatus = run(tsxBin, [path.join(scriptDir, 'claude-code-oauth-direct-smoke.ts')]);
    if (claudeOauthStatus !== 0) process.exit(claudeOauthStatus);
    process.exit(run(tsxBin, [path.join(scriptDir, 'runtime-profile-settings-smoke.ts')]));
  }
  if (target === 'runtime') {
    const launchdStatus = run(tsxBin, [path.join(scriptDir, 'launchd-callback-secret-smoke.ts')]);
    if (launchdStatus !== 0) process.exit(launchdStatus);
    process.exit(run(tsxBin, [path.join(scriptDir, 'telegram-topic-routing-live-smoke.ts')]));
  }
  if (target === 'all') {
    const secretsStatus = run(process.execPath, ['--test', '__tests__/secrets-meta.node.test.js']);
    if (secretsStatus !== 0) process.exit(secretsStatus);
    const unitStatus = run(process.execPath, [__filename, 'unit']);
    process.exit(unitStatus);
  }

  console.error(`[hub test] unknown target: ${target}`);
  console.error('[hub test] supported targets: all, secrets-meta, unit, runtime');
  process.exit(1);
}

main();
