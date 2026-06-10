#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function repoPath(...parts: string[]): string {
  return path.resolve(__dirname, '..', '..', '..', ...parts);
}

function extractString(plist: string, key: string): string {
  const pattern = new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`, 'm');
  const match = plist.match(pattern);
  return match ? match[1] : '';
}

function assertLaunchdNodePrebuiltDaemon(plist: string, daemonName: string): void {
  const buildDaemonsSource = fs.readFileSync(repoPath('scripts', 'build-daemons.mjs'), 'utf8');
  const daemonEntryPattern = new RegExp(`label:\\s*'${daemonName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'[^\\n}]*format:\\s*'cjs'`, 'm');
  const extension = daemonEntryPattern.test(buildDaemonsSource) ? '.cjs' : '.mjs';
  const daemonPath = repoPath('dist', 'daemons', `${daemonName}${extension}`);
  assert.match(plist, /<string>\/opt\/homebrew\/bin\/node<\/string>/, `${daemonName} should run through node`);
  assert.match(plist, new RegExp(`<string>${daemonPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>`), `${daemonName} should point at its prebuilt daemon bundle`);
  assert.equal(buildDaemonsSource.includes(`label: '${daemonName}'`), true, `${daemonName} must be included in build-daemons manifest`);
}

async function main() {
  const plistPath = repoPath('bots/orchestrator/launchd/ai.jay.runtime.plist');
  const janitorPlistPath = repoPath('bots/orchestrator/launchd/ai.jay.incident-janitor.plist');
  assert.equal(fs.existsSync(plistPath), true, 'Jay runtime launchd plist must exist');
  assert.equal(fs.existsSync(janitorPlistPath), true, 'Jay incident janitor launchd plist must exist');
  const plist = fs.readFileSync(plistPath, 'utf8');
  const janitorPlist = fs.readFileSync(janitorPlistPath, 'utf8');
  assert.equal(extractString(plist, 'Label'), 'ai.jay.runtime', 'launchd label should be ai.jay.runtime');
  assertLaunchdNodePrebuiltDaemon(plist, 'ai.jay.runtime');
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/, 'Jay runtime should be KeepAlive');
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/, 'Jay runtime should start at load');
  assert.equal(extractString(janitorPlist, 'Label'), 'ai.jay.incident-janitor', 'janitor label should be ai.jay.incident-janitor');
  assert.match(janitorPlist, /<string>\/opt\/homebrew\/bin\/node<\/string>/, 'Janitor should run through node');
  assert.match(janitorPlist, /<string>--disable-warning=DEP0205<\/string>/, 'Janitor should suppress Node 26 tsx DEP0205 warnings');
  assert.match(janitorPlist, /<string>--import<\/string>\s*<string>tsx<\/string>/, 'Janitor should load tsx through node --import');
  assert.match(janitorPlist, /jay-incident-janitor\.ts/, 'janitor should run jay-incident-janitor.ts');
  assert.match(janitorPlist, /<string>--apply<\/string>/, 'janitor should apply stale queue repair');
  assert.match(janitorPlist, /<key>StartInterval<\/key>\s*<integer>900<\/integer>/, 'janitor should run every 15 minutes');

  for (const key of [
    'JAY_INCIDENT_STORE_ENABLED',
    'JAY_HUB_PLAN_INTEGRATION',
    'JAY_COMMANDER_ENABLED',
    'JAY_COMMANDER_DISPATCH',
    'JAY_TEAM_BUS_ENABLED',
    'JAY_COMMANDER_BOT_QUEUE_ENABLED',
    'JAY_3TIER_TELEGRAM',
    'JAY_SKILL_EXTRACTION',
  ]) {
    assert.equal(extractString(plist, key), 'true', `${key} should be enabled in Jay runtime plist`);
  }

  for (const secretKey of [
    'HUB_AUTH_TOKEN',
    'HUB_CONTROL_CALLBACK_SECRET',
    'TELEGRAM_BOT_TOKEN',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
  ]) {
    assert.equal(plist.includes(`<key>${secretKey}</key>`), false, `${secretKey} must not be committed in plist`);
    assert.equal(janitorPlist.includes(`<key>${secretKey}</key>`), false, `${secretKey} must not be committed in janitor plist`);
  }
  assert.equal(/__SET_|changeme|placeholder/i.test(plist), false, 'plist must not contain placeholder secrets');
  assert.equal(/__SET_|changeme|placeholder/i.test(janitorPlist), false, 'janitor plist must not contain placeholder secrets');
  console.log('jay_runtime_launchd_smoke_ok');
}

main().catch((error) => {
  console.error(`jay_runtime_launchd_smoke_failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
