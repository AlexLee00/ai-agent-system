#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const launchdDir = path.join(repoRoot, 'bots/blog/launchd');
// B3 소셜 분리(runTsB3 삭제 어서션과 정합). 재개 시 bots/social-media 소유 plist로 신규 설계한다.
// instagram-token-health와 instagram-token-refresh는 각각 2026-04-12/04-21 추가된 별도 plist였고, 2026-06-13 각각 삭제됐다.
const checkedPlists = [
  'ai.blog.bestseller-sync.plist',
  'ai.blog.collect-competition.plist',
  'ai.blog.collect-performance.plist',
  'ai.blog.collect-views.plist',
  'ai.blog.commenter.plist',
  'ai.blog.crank-tracker.plist',
  'ai.blog.daily.plist',
  'ai.blog.health-check.plist',
  'ai.blog.neighbor-commenter.plist',
  'ai.blog.neighbor-sympathy.plist',
  'ai.blog.reddit-trends.plist',
  'ai.blog.topic-planner.plist',
  'ai.blog.trend-collector.plist',
  'ai.blog.weekly-evolution.plist',
];

type LaunchdPlist = {
  ProgramArguments?: string[];
  WorkingDirectory?: string;
};

function readPlist(plistPath: string): LaunchdPlist {
  const raw = execFileSync('plutil', ['-convert', 'json', '-o', '-', plistPath], { encoding: 'utf8' });
  return JSON.parse(raw) as LaunchdPlist;
}

for (const plistName of checkedPlists) {
  const plistPath = path.join(launchdDir, plistName);
  assert.equal(fs.existsSync(plistPath), true, `${plistName} must exist`);
  const plist = readPlist(plistPath);
  const args = plist.ProgramArguments || [];
  const entrypoint = args.at(-1);

  assert.equal(args[0], '/opt/homebrew/bin/node', `${plistName} must run through node`);
  assert.equal(args.includes('--disable-warning=DEP0205'), true, `${plistName} must suppress Node 26 DEP0205 noise`);
  assert.equal(args.includes('--import'), true, `${plistName} must load tsx through node --import`);
  assert.equal(args.includes('tsx'), true, `${plistName} must use the tsx import hook`);
  assert.equal(args.includes('/opt/homebrew/bin/tsx'), false, `${plistName} must not run direct tsx`);
  assert.equal(args.some((arg) => arg.endsWith('/node_modules/.bin/tsx')), false, `${plistName} must not run direct local tsx`);
  assert.equal(Boolean(entrypoint && fs.existsSync(entrypoint)), true, `${plistName} entrypoint must exist`);
  assert.equal(entrypoint?.endsWith('.ts'), true, `${plistName} must point at the maintained TypeScript source`);
  assert.equal(Boolean(plist.WorkingDirectory && fs.existsSync(plist.WorkingDirectory)), true, `${plistName} must set an existing WorkingDirectory`);
}

console.log('blog_launchd_node26_runner_smoke_ok');
