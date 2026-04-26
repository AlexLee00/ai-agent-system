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
  const legacyIsolationScript = (prefix) => `${prefix}-runtime-legacy-gateway-isolation-smoke.ts`;
  const args = process.argv.slice(2).filter(Boolean);
  const target = args.find((arg) => !arg.startsWith('-')) || 'all';

  if (target === 'secrets-meta') {
    process.exit(run(process.execPath, ['--test', '__tests__/secrets-meta.node.test.js']));
  }
  if (target === 'unit') {
    const secretLeakStatus = run(tsxBin, [path.join(scriptDir, 'secret-leak-smoke.ts')]);
    if (secretLeakStatus !== 0) process.exit(secretLeakStatus);
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
    const alarmStatus = run(tsxBin, [path.join(scriptDir, 'hub-alarm-delivery-acceptance-smoke.ts')]);
    if (alarmStatus !== 0) process.exit(alarmStatus);
    const alarmGovernorStatus = run(tsxBin, [path.join(scriptDir, 'alarm-governor-smoke.ts')]);
    if (alarmGovernorStatus !== 0) process.exit(alarmGovernorStatus);
    const alarmShimStatus = run(tsxBin, [path.join(scriptDir, 'hub-alarm-no-legacy-shim-smoke.ts')]);
    if (alarmShimStatus !== 0) process.exit(alarmShimStatus);
    const alarmEnvStatus = run(tsxBin, [path.join(scriptDir, 'hub-alarm-env-smoke.ts')]);
    if (alarmEnvStatus !== 0) process.exit(alarmEnvStatus);
    const alarmImportTransitionStatus = run(tsxBin, [path.join(scriptDir, 'hub-alarm-import-transition-smoke.ts')]);
    if (alarmImportTransitionStatus !== 0) process.exit(alarmImportTransitionStatus);
    const postAlarmStatus = run(tsxBin, [path.join(scriptDir, 'hub-postalarm-no-legacy-fallback-smoke.ts')]);
    if (postAlarmStatus !== 0) process.exit(postAlarmStatus);
    const legacyGatewayIndependenceStatus = run(tsxBin, [path.join(scriptDir, 'legacy-gateway-independence-smoke.ts')]);
    if (legacyGatewayIndependenceStatus !== 0) process.exit(legacyGatewayIndependenceStatus);
    const runtimeWorkspaceStatus = run(tsxBin, [path.join(scriptDir, 'runtime-workspace-independence-smoke.ts')]);
    if (runtimeWorkspaceStatus !== 0) process.exit(runtimeWorkspaceStatus);
    const activeRuntimeIsolationStatus = run(tsxBin, [path.join(scriptDir, legacyIsolationScript('active'))]);
    if (activeRuntimeIsolationStatus !== 0) process.exit(activeRuntimeIsolationStatus);
    const legacyGatewayAdminGuardStatus = run(tsxBin, [path.join(scriptDir, 'legacy-gateway-admin-guard-smoke.ts')]);
    if (legacyGatewayAdminGuardStatus !== 0) process.exit(legacyGatewayAdminGuardStatus);
    const claudeRuntimeIsolationStatus = run(tsxBin, [path.join(scriptDir, legacyIsolationScript('claude'))]);
    if (claudeRuntimeIsolationStatus !== 0) process.exit(claudeRuntimeIsolationStatus);
    const investmentRuntimeIsolationStatus = run(tsxBin, [path.join(scriptDir, legacyIsolationScript('investment'))]);
    if (investmentRuntimeIsolationStatus !== 0) process.exit(investmentRuntimeIsolationStatus);
    const reservationRuntimeIsolationStatus = run(tsxBin, [path.join(scriptDir, legacyIsolationScript('reservation'))]);
    if (reservationRuntimeIsolationStatus !== 0) process.exit(reservationRuntimeIsolationStatus);
    const llmControlIndependenceStatus = run(tsxBin, [path.join(scriptDir, 'llm-control-independence-smoke.ts')]);
    if (llmControlIndependenceStatus !== 0) process.exit(llmControlIndependenceStatus);
    const teamLlmRouteDrillStatus = run(tsxBin, [path.join(scriptDir, 'team-llm-route-drill.ts')]);
    if (teamLlmRouteDrillStatus !== 0) process.exit(teamLlmRouteDrillStatus);
    const agentHubTransitionStatus = run(tsxBin, [path.join(scriptDir, 'agent-hub-transition-audit.ts')]);
    if (agentHubTransitionStatus !== 0) process.exit(agentHubTransitionStatus);
    const videoHubTransitionStatus = run(tsxBin, [path.join(scriptDir, 'video-hub-transition-smoke.ts')]);
    if (videoHubTransitionStatus !== 0) process.exit(videoHubTransitionStatus);
    const llmRoutingStandardStatus = run(tsxBin, [path.join(scriptDir, 'llm-routing-standard-smoke.ts')]);
    if (llmRoutingStandardStatus !== 0) process.exit(llmRoutingStandardStatus);
    const tgPendingMigrationStatus = run(tsxBin, [path.join(scriptDir, 'telegram-pending-queue-migration-smoke.ts')]);
    if (tgPendingMigrationStatus !== 0) process.exit(tgPendingMigrationStatus);
    const tgHubSecretsStatus = run(tsxBin, [path.join(scriptDir, 'telegram-hub-secrets-smoke.ts')]);
    if (tgHubSecretsStatus !== 0) process.exit(tgHubSecretsStatus);
    const tgTopicPrecedenceStatus = run(tsxBin, [path.join(scriptDir, 'telegram-topic-routing-precedence-smoke.ts')]);
    if (tgTopicPrecedenceStatus !== 0) process.exit(tgTopicPrecedenceStatus);
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
    const teamOauthStatus = run(tsxBin, [path.join(scriptDir, 'team-oauth-readiness-report.ts')]);
    if (teamOauthStatus !== 0) process.exit(teamOauthStatus);
    const telegramTopicStatus = run(tsxBin, [path.join(scriptDir, 'telegram-topic-routing-live-smoke.ts')]);
    if (telegramTopicStatus !== 0) process.exit(telegramTopicStatus);
    process.exit(run(tsxBin, [path.join(scriptDir, 'telegram-routing-readiness-report.ts')]));
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
