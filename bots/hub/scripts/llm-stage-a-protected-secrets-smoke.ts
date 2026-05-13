#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const ownershipPath = path.join(repoRoot, 'packages', 'core', 'config', 'service-ownership.json');
const launchdDir = path.join(repoRoot, 'bots', 'hub', 'launchd');

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

console.log(JSON.stringify({
  ok: true,
  protected_hub_labels: PROTECTED_14.length,
  secrets_expiry_monitored: true,
}, null, 2));
