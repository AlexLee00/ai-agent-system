import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const launchdDir = path.join(repoRoot, 'bots/hub/launchd');
const checkedPlists = [
  'ai.hub.daily-backup.plist',
  'ai.hub.hourly-status-digest.plist',
  'ai.hub.incident-summary.plist',
  'ai.hub.alarm-noise-report.plist',
  'ai.hub.bg-proxy.plist',
  'ai.hub.llm-auto-routing-monitor.plist',
  'ai.hub.llm-cache-cleanup.plist',
  'ai.hub.llm-groq-fallback-test.plist',
  'ai.hub.llm-model-check.plist',
  'ai.hub.llm-oauth4-master-review.plist',
  'ai.hub.monthly-restore-drill.plist',
  'ai.hub.noisy-producer-auto-learn.plist',
  'ai.hub.resource-api-green.plist',
  'ai.hub.roundtable-reflection.plist',
  'ai.hub.secrets-auto-rotate.plist',
  'ai.hub.secrets-expiry-check.plist',
  'ai.hub.weekly-advisory-digest.plist',
  'ai.hub.weekly-audit-digest.plist',
  'ai.hub.weekly-metrics-digest.plist',
  'ai.llm.daily-report.plist',
];

type LaunchdPlist = {
  ProgramArguments?: string[];
  WorkingDirectory?: string;
};

function readPlist(plistPath: string): LaunchdPlist {
  const raw = execFileSync('plutil', ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8' });
  return JSON.parse(raw) as LaunchdPlist;
}

function resolveEntrypoint(entrypoint: string, workingDirectory: string): string {
  return path.isAbsolute(entrypoint) ? entrypoint : path.resolve(workingDirectory, entrypoint);
}

for (const plistName of checkedPlists) {
  const plistPath = path.join(launchdDir, plistName);
  assert.equal(fs.existsSync(plistPath), true, `${plistName} must exist`);
  const plist = readPlist(plistPath);
  const args = plist.ProgramArguments || [];
  const workingDirectory = plist.WorkingDirectory || repoRoot;
  const entrypoint = args.find((arg) => arg.endsWith('.ts')) || '';

  assert.equal(args[0], '/opt/homebrew/bin/node', `${plistName} must run through node`);
  assert.equal(args.includes('--disable-warning=DEP0205'), true, `${plistName} must suppress Node 26 DEP0205 noise`);
  assert.equal(args.includes('--import'), true, `${plistName} must load tsx through node --import`);
  assert.equal(args.includes('tsx'), true, `${plistName} must use the tsx import hook`);
  assert.equal(args.includes('/opt/homebrew/bin/tsx'), false, `${plistName} must not run direct tsx`);
  assert.equal(args.some((arg) => arg.endsWith('/node_modules/.bin/tsx')), false, `${plistName} must not run direct local tsx`);
  assert.equal(Boolean(entrypoint), true, `${plistName} must include a TypeScript entrypoint`);
  assert.equal(fs.existsSync(resolveEntrypoint(entrypoint, workingDirectory)), true, `${plistName} entrypoint must exist`);
  assert.equal(fs.existsSync(workingDirectory), true, `${plistName} must set an existing WorkingDirectory`);
}

console.log('hub_launchd_node26_runner_smoke_ok');
