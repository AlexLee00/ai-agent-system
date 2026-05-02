#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(__dirname, '..', '..', '..');

const TARGETS = [
  {
    label: 'ai.hub.resource-api',
    plistPath: path.join(repoRoot, 'bots/hub/launchd/ai.hub.resource-api.plist'),
  },
  {
    label: 'ai.investment.commander',
    plistPath: path.join(repoRoot, 'bots/investment/launchd/ai.investment.commander.plist'),
  },
];

function parsePlist(filePath: string): any {
  const result = spawnSync('plutil', ['-convert', 'json', '-o', '-', filePath], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `plutil failed for ${filePath}: ${result.stderr || result.status}`);
  return JSON.parse(result.stdout);
}

function normalizeVersion(value: any): string {
  return String(value || '').trim().toLowerCase();
}

function asPercent(value: any): number {
  const parsed = Number(value);
  assert(Number.isFinite(parsed), `rollout percent must be numeric (received: ${value})`);
  const rounded = Math.floor(parsed);
  assert(rounded >= 0 && rounded <= 100, `rollout percent out of range: ${rounded}`);
  return rounded;
}

function main(): void {
  const results: any[] = [];

  for (const target of TARGETS) {
    const plist = parsePlist(target.plistPath);
    assert.equal(plist.Label, target.label, `unexpected label for ${target.plistPath}`);
    const env = plist.EnvironmentVariables || {};

    const useOauthPrimary = String(env.LLM_USE_OAUTH_PRIMARY || '').trim().toLowerCase();
    assert.equal(useOauthPrimary, 'true', `${target.label}: LLM_USE_OAUTH_PRIMARY must be true`);

    const version = normalizeVersion(env.LLM_TEAM_SELECTOR_VERSION);
    assert(
      version === 'v3_oauth_4' || version === 'v3.0_oauth_4' || version === 'oauth4',
      `${target.label}: LLM_TEAM_SELECTOR_VERSION must be oauth4`,
    );

    const percent = asPercent(env.LLM_TEAM_SELECTOR_AB_PERCENT);
    results.push({
      label: target.label,
      selectorVersion: version,
      rolloutPercent: percent,
    });
  }

  console.log(JSON.stringify({
    ok: true,
    targets: results,
  }, null, 2));
}

try {
  main();
} catch (error: any) {
  console.error('[llm-oauth4-rollout-launchd-smoke] failed:', error?.message || error);
  process.exit(1);
}
