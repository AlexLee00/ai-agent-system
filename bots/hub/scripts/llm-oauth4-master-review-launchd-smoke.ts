#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const plistPath = path.join(repoRoot, 'bots/hub/launchd/ai.hub.llm-oauth4-master-review.plist');

function parsePlist(filePath) {
  const result = spawnSync('plutil', ['-convert', 'json', '-o', '-', filePath], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `plutil failed: ${result.stderr || result.status}`);
  return JSON.parse(result.stdout);
}

function asNumber(value, name) {
  const numeric = Number(value);
  assert(Number.isFinite(numeric), `${name} must be numeric`);
  return numeric;
}

function main() {
  const plist = parsePlist(plistPath);
  const args = Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments : [];
  const env = plist.EnvironmentVariables || {};

  assert.equal(plist.Label, 'ai.hub.llm-oauth4-master-review', 'unexpected launchd label');
  assert(args.some((entry) => String(entry).endsWith('/bots/hub/scripts/llm-oauth4-master-review.ts')), 'launchd must run llm-oauth4-master-review.ts');
  assert.equal(plist.RunAtLoad, true, 'OAuth4 master review must run at load');
  assert(asNumber(plist.StartInterval, 'StartInterval') <= 3600, 'OAuth4 master review must run at least hourly');
  assert.equal(String(env.LLM_OAUTH4_REVIEW_STRICT || '').trim(), 'true', 'hourly OAuth4 master review must run in strict mode');
  assert.equal(asNumber(env.LLM_OAUTH4_REVIEW_HOURS, 'LLM_OAUTH4_REVIEW_HOURS'), 168, 'review window must remain 168h');

  for (const key of Object.keys(env)) {
    assert(
      !/(TOKEN|SECRET|API_KEY|PASSWORD|CLIENT_SECRET)/i.test(key),
      `OAuth4 master review launchd must not embed secret-like env key: ${key}`,
    );
  }

  console.log(JSON.stringify({
    ok: true,
    label: plist.Label,
    interval_s: plist.StartInterval,
    strict: true,
  }));
}

main();
