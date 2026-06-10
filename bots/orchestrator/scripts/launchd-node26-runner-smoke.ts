#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const launchdDir = path.join(repoRoot, 'bots/orchestrator/launchd');
const checkedPlists = [
  'ai.event.reminders.plist',
  'ai.metty.trace.plist',
  'ai.steward.daily.plist',
  'ai.steward.hourly.plist',
  'ai.steward.weekly.plist',
];

function readProgramArguments(plistPath: string): string[] {
  const raw = execFileSync('plutil', ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8' });
  const parsed = JSON.parse(raw) as { ProgramArguments?: string[] };
  return parsed.ProgramArguments || [];
}

for (const plistName of checkedPlists) {
  const plistPath = path.join(launchdDir, plistName);
  assert.equal(fs.existsSync(plistPath), true, `${plistName} must exist`);
  const args = readProgramArguments(plistPath);

  assert.equal(args[0], '/opt/homebrew/bin/node', `${plistName} must run through node`);
  assert.equal(args.includes('/opt/homebrew/bin/tsx'), false, `${plistName} must not run direct tsx`);
  assert.equal(args.includes('--disable-warning=DEP0205'), true, `${plistName} must suppress Node 26 tsx DEP0205 warnings`);
  assert.equal(args.includes('--import'), true, `${plistName} must load tsx through node --import`);
  assert.equal(args.includes('tsx'), true, `${plistName} must include the tsx loader`);
}

console.log('orchestrator_launchd_node26_runner_smoke_ok');
