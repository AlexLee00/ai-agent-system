#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const launchdDir = path.join(repoRoot, 'bots/claude/launchd');
const checkedPlists = [
  'ai.claude.auto-dev.plist',
  'ai.claude.auto-dev.shadow.plist',
  'ai.claude.codex-notifier.plist',
  'ai.claude.health-check.plist',
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
  assert.equal(args.some((arg) => arg.endsWith('/node_modules/.bin/tsx')), false, `${plistName} must not run direct local tsx`);
}

console.log('claude_launchd_node26_runner_smoke_ok');
