#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '../../..');
const {
  OUTPUT_PATH,
  buildHubStageBStabilityReport,
  writeHubStageBStabilityReport,
} = require('../lib/stage-b/stability.ts');

async function main() {
  const report = await buildHubStageBStabilityReport({ skipDb: true, skipLaunchctl: true });
  assert.equal(report.stage, 'hub_stage_b');
  assert.equal(report.dashboard.type, 'json');
  assert(report.dashboard.panels.includes('provider_tier_usage'), 'dashboard must expose provider tier usage');
  assert(report.dashboard.panels.includes('budget_guard_status'), 'dashboard must expose BillingGuard status');
  assert(report.dashboard.panels.includes('protected_launchd_status'), 'dashboard must expose protected launchd status');
  assert.equal(report.sentry.ok, true, 'Sentry readiness contract must be fail-closed and reportable');
  assert.equal(report.sentry.contract.noSecretLogging, true, 'Sentry contract must forbid secret logging');
  assert.equal(report.sentry.contract.failClosedOnMissingToken, true, 'Sentry contract must fail closed on missing token');

  const written = await writeHubStageBStabilityReport(report, OUTPUT_PATH);
  assert.equal(written, OUTPUT_PATH);
  const parsed = JSON.parse(fs.readFileSync(written, 'utf8'));
  assert.equal(parsed.stage, 'hub_stage_b');

  const guidePath = path.join(repoRoot, 'docs/hub/HUB_STAGE_B_OPERATIONS.md');
  assert(fs.existsSync(guidePath), 'Stage B operations guide must exist');
  const guide = fs.readFileSync(guidePath, 'utf8');
  assert.match(guide, /Hub→Selector→Agent/, 'guide must document control-plane flow');
  assert.match(guide, /Self-Healing/, 'guide must document self-healing boundaries');

  console.log(JSON.stringify({
    ok: true,
    stage: 'hub_stage_b',
    dashboard_output: written,
    sentry_mode: report.sentry.mode,
    panels: report.dashboard.panels.length,
  }, null, 2));
}

main().catch((error) => {
  console.error('[llm-stage-b-observability-smoke] failed:', error?.message || error);
  process.exit(1);
});
