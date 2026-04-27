#!/usr/bin/env tsx
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const REQUIRED_PLISTS = [
  {
    name: 'hub_resource_api',
    repo: path.join(repoRoot, 'bots', 'hub', 'launchd', 'ai.hub.resource-api.plist'),
    installed: path.join(os.homedir(), 'Library', 'LaunchAgents', 'ai.hub.resource-api.plist'),
  },
  {
    name: 'orchestrator',
    repo: path.join(repoRoot, 'bots', 'orchestrator', 'launchd', 'ai.orchestrator.plist'),
    installed: path.join(os.homedir(), 'Library', 'LaunchAgents', 'ai.orchestrator.plist'),
  },
  {
    name: 'steward_hourly',
    repo: path.join(repoRoot, 'bots', 'orchestrator', 'launchd', 'ai.steward.hourly.plist'),
    installed: path.join(os.homedir(), 'Library', 'LaunchAgents', 'ai.steward.hourly.plist'),
  },
  {
    name: 'steward_daily',
    repo: path.join(repoRoot, 'bots', 'orchestrator', 'launchd', 'ai.steward.daily.plist'),
    installed: path.join(os.homedir(), 'Library', 'LaunchAgents', 'ai.steward.daily.plist'),
  },
  {
    name: 'steward_weekly',
    repo: path.join(repoRoot, 'bots', 'orchestrator', 'launchd', 'ai.steward.weekly.plist'),
    installed: path.join(os.homedir(), 'Library', 'LaunchAgents', 'ai.steward.weekly.plist'),
  },
];

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function read(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function envValueFromPlist(text: string, key: string): string {
  const pattern = new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`);
  return text.match(pattern)?.[1] || '';
}

function checkPlist(file: string, required = true) {
  const text = read(file);
  if (!text) {
    return { file, ok: !required, exists: false, value: null, reason: required ? 'plist_missing' : 'plist_not_installed' };
  }
  const value = envValueFromPlist(text, 'HUB_ALARM_USE_CLASS_TOPICS');
  const ok = value === 'true' || value === '1';
  const staleRuntime = /bots\/orchestrator\/src\/steward\.js|dist\/ts-runtime\/bots\/orchestrator\/src\/orchestrator\.js/.test(text);
  return {
    file,
    ok: ok && !staleRuntime,
    exists: true,
    value: value || null,
    reason: !ok ? 'HUB_ALARM_USE_CLASS_TOPICS_not_enabled'
      : staleRuntime ? 'stale_orchestrator_launchd_runtime'
        : null,
  };
}

function main() {
  const checks = REQUIRED_PLISTS.map((item) => ({
    name: item.name,
    repo: checkPlist(item.repo, true),
    installed: checkPlist(item.installed, hasFlag('strict-installed')),
  }));
  const ok = checks.every((item) => item.repo.ok && item.installed.ok);
  const result = {
    ok,
    checks,
    checked_at: new Date().toISOString(),
  };
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`launchd_alarm_class_topic_smoke: ok=${ok}`);
    for (const item of checks) {
      console.log(`${item.name}: repo=${item.repo.ok} installed=${item.installed.ok}`);
    }
  }
  if (!ok) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  checkPlist,
};
