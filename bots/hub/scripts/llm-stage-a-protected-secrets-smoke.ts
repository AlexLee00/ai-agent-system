#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const ownershipPath = path.join(repoRoot, 'packages', 'core', 'config', 'service-ownership.json');
const launchdDir = path.join(repoRoot, 'bots', 'hub', 'launchd');
const healthProviderPath = path.join(repoRoot, 'packages', 'core', 'lib', 'health-provider.ts');
const stageBPath = path.join(repoRoot, 'bots', 'hub', 'lib', 'stage-b', 'stability.ts');
const {
  getHubServiceLabels,
  getHubCoreServiceLabels,
} = require('../../../packages/core/lib/service-ownership.js');

const PROTECTED_14 = [
  'ai.hub.resource-api',
  'ai.hub.llm-oauth-monitor',
  'ai.hub.llm-oauth4-master-review',
  'ai.hub.llm-groq-fallback-test',
  'ai.hub.llm-model-check',
  'ai.hub.llm-cache-cleanup',
  'ai.hub.incident-summary',
  'ai.hub.severity-decay',
  'ai.hub.noisy-producer-auto-learn',
  'ai.hub.roundtable-reflection',
  'ai.hub.daily-metrics-digest',
  'ai.hub.hourly-status-digest',
  'ai.hub.weekly-audit-digest',
  'ai.hub.weekly-advisory-digest',
];

const ownership = JSON.parse(fs.readFileSync(ownershipPath, 'utf8'));
const byLabel = new Map(ownership.map((entry: any) => [entry.label, entry]));

for (const label of PROTECTED_14) {
  const entry = byLabel.get(label);
  assert(entry, `service ownership missing protected Hub label: ${label}`);
  assert.equal(entry.owner, 'launchd', `${label} must be launchd-owned`);
  assert.notEqual(entry.retired, true, `${label} must not be retired`);
  const plistPath = path.join(launchdDir, `${label}.plist`);
  assert(fs.existsSync(plistPath), `launchd plist missing for ${label}`);
}

const secretsEntry = byLabel.get('ai.hub.secrets-expiry-check');
assert(secretsEntry, 'secrets expiry label must be in ownership catalog');
assert.equal(secretsEntry.owner, 'launchd');
assert(fs.existsSync(path.join(launchdDir, 'ai.hub.secrets-expiry-check.plist')), 'secrets expiry launchd plist must exist');

const healthProviderSource = fs.readFileSync(healthProviderPath, 'utf8');
assert(
  healthProviderSource.includes('sanitizeLaunchctlPrintDetail')
    && healthProviderSource.includes('launchctlDetail: sanitizeLaunchctlPrintDetail(raw)'),
  'launchctl print detail must be sanitized before health reports expose it',
);
assert(
  !/launchctlDetail:\s*truncateText\(raw/.test(healthProviderSource),
  'launchctl print raw output must not be exposed through launchctlDetail',
);

const stageBSource = fs.readFileSync(stageBPath, 'utf8');
assert(stageBSource.includes('readLaunchctlPrintState'), 'Stage B protected status must inspect launchctl print state');
assert(stageBSource.includes('historicalExitStatus'), 'Stage B must separate historical launchctl status from current running state');

const secretsMonitorSource = fs.readFileSync(path.join(repoRoot, 'bots', 'hub', 'lib', 'secrets-store-monitor.ts'), 'utf8');
assert(secretsMonitorSource.includes('secret 값은 변경하지 않는다'), 'secrets monitor must explicitly declare monitor-only behavior');
assert(!/writeFileSync\s*\(\s*STORE_PATH/.test(secretsMonitorSource), 'secrets monitor must not mutate secrets-store.json');
assert(!/action_taken:\s*'rotated'/.test(secretsMonitorSource), 'secrets monitor must not claim rotation without a rotator');

const hubServiceLabels = new Set(getHubServiceLabels());
for (const label of getHubCoreServiceLabels()) {
  assert(hubServiceLabels.has(label), `Hub service status labels must include core label: ${label}`);
}

console.log(JSON.stringify({
  ok: true,
  protected_hub_labels: PROTECTED_14.length,
  secrets_expiry_monitored: true,
  secrets_monitor_only: true,
  launchctl_detail_redacted: true,
  historical_status_separated: true,
  core_service_labels_covered: true,
}, null, 2));
