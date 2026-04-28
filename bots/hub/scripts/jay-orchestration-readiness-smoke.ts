#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function boolEnv(name: string): boolean {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function repoPath(...parts: string[]): string {
  return path.resolve(__dirname, '..', '..', '..', ...parts);
}

async function main() {
  const runtimeConfig = require('../../orchestrator/lib/runtime-config.ts');
  const config = runtimeConfig.getJayOrchestrationConfig();
  const requiredFlags = [
    'commanderEnabled',
    'hubPlanIntegration',
    'incidentStoreEnabled',
    'commanderDispatch',
    'teamBusEnabled',
    'threeTierTelegram',
    'skillExtraction',
    'sessionCompaction',
  ];
  const requiredFiles = [
    'bots/orchestrator/lib/jay-control-plan-client.ts',
    'bots/orchestrator/lib/jay-incident-store.ts',
    'bots/orchestrator/lib/jay-meeting-reporter.ts',
    'bots/orchestrator/lib/jay-skill-extractor.ts',
    'bots/orchestrator/lib/jay-team-bus.ts',
    'bots/hub/lib/control/commander-dispatcher.ts',
    'bots/hub/lib/control/session-compaction.ts',
    'packages/core/lib/commander-contract.ts',
  ];

  for (const file of requiredFiles) {
    assert.equal(fs.existsSync(repoPath(file)), true, `required Jay orchestration file missing: ${file}`);
  }
  for (const flag of requiredFlags) {
    assert.equal(typeof config?.[flag], 'boolean', `jayOrchestration.${flag} must be boolean`);
  }

  if (boolEnv('JAY_ORCHESTRATION_REQUIRE_ENABLED')) {
    for (const flag of requiredFlags.slice(0, 7)) {
      assert.equal(config?.[flag], true, `jayOrchestration.${flag} must be enabled for runtime cutover`);
    }
    assert.ok(String(process.env.HUB_AUTH_TOKEN || '').trim(), 'HUB_AUTH_TOKEN is required for runtime cutover');
    assert.ok(String(process.env.HUB_CONTROL_CALLBACK_SECRET || '').trim(), 'HUB_CONTROL_CALLBACK_SECRET is required for runtime cutover');
  }

  console.log(JSON.stringify({
    ok: true,
    files: requiredFiles.length,
    flags: requiredFlags.length,
    runtime_cutover_required: boolEnv('JAY_ORCHESTRATION_REQUIRE_ENABLED'),
  }));
}

main().catch((error) => {
  console.error(`jay_orchestration_readiness_smoke_failed: ${error?.message || error}`);
  process.exit(1);
});
