#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const plistPath = path.join(repoRoot, 'bots/hub/launchd/ai.hub.llm-oauth-monitor.plist');

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

  assert.equal(plist.Label, 'ai.hub.llm-oauth-monitor', 'unexpected launchd label');
  assert(args.some((entry) => String(entry).endsWith('/bots/hub/scripts/run-oauth-monitor.ts')), 'oauth monitor must run run-oauth-monitor.ts');
  assert.equal(plist.RunAtLoad, true, 'oauth monitor must run at load');
  assert(asNumber(plist.StartInterval, 'StartInterval') <= 900, 'oauth monitor interval must be 15 minutes or less');
  assert.equal(String(env.HUB_OAUTH_MONITOR_REQUIRE_GEMINI || '').trim(), 'true', 'Gemini OAuth readiness must be required');
  assert.equal(String(env.GEMINI_OAUTH_PROJECT_ID || '').trim(), 'gen-lang-client-0627707293', 'Gemini quota project must be wired into oauth monitor launchd');
  assert(asNumber(env.HUB_GEMINI_OAUTH_WARN_HOURS, 'HUB_GEMINI_OAUTH_WARN_HOURS') >= 0.5, 'Gemini warn window must allow proactive refresh');
  assert(asNumber(env.HUB_GEMINI_OAUTH_CRITICAL_HOURS, 'HUB_GEMINI_OAUTH_CRITICAL_HOURS') >= 0.1, 'Gemini critical window must be non-zero');

  for (const key of Object.keys(env)) {
    assert(
      !/(TOKEN|SECRET|API_KEY|PASSWORD|CLIENT_SECRET)/i.test(key),
      `oauth monitor launchd must not embed secret-like env key: ${key}`,
    );
  }

  console.log(JSON.stringify({
    ok: true,
    label: plist.Label,
    interval_s: plist.StartInterval,
    gemini_required: true,
  }));
}

main();
