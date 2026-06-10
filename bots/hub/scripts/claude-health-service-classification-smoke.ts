#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const hsm = require(path.join(repoRoot, 'packages/core/lib/health-state-manager'));
const ownership = require(path.join(repoRoot, 'packages/core/lib/service-ownership'));

const CLAUDE_DEV_LAUNCHD_SERVICES = [
  'ai.claude.reviewer',
  'ai.claude.guardian',
  'ai.claude.builder',
  'ai.claude.codex-notifier',
];

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

async function main() {
  const healthCheck = readRepoFile('bots/claude/scripts/health-check.ts');
  const healthReport = readRepoFile('bots/claude/scripts/health-report.ts');

  for (const label of CLAUDE_DEV_LAUNCHD_SERVICES) {
    const service = ownership.getServiceOwnership(label);
    assert.equal(service?.owner, 'launchd', `${label} must be registered in service ownership catalog`);
    assert.equal(ownership.isOptionalService(label), false, `${label} must not be hidden as optional`);
    assert.equal(ownership.isExpectedIdleService(label), false, `${label} must not be hidden as expected idle`);

    assert.equal(hsm.isDevService(label), true, `${label} must be classified as Claude dev service`);
    assert.equal(hsm.getAlertTag(label), '[점검] ', `${label} must add operator-check tag`);
    assert.equal(hsm.getAlertLevel(label), 2, `${label} must alert at level 2, not level 3 auto-repair`);

    assert.match(healthCheck, new RegExp(`['"]${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`), `${label} must be monitored by health-check`);
    assert.match(healthReport, new RegExp(`['"]${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`), `${label} must be visible in health-report`);
  }

  assert.equal(hsm.getAlertLevel('ai.claude.commander'), 3, 'core Claude commander must remain level 3');
  console.log('claude_health_service_classification_smoke_ok');
}

main().catch((error) => {
  console.error(`claude_health_service_classification_smoke_failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
