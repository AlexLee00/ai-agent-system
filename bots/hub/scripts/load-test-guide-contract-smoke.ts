#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function assertFile(relativePath) {
  assert.equal(
    fs.existsSync(path.join(repoRoot, relativePath)),
    true,
    `${relativePath} must exist`,
  );
}

const guide = read('docs/hub/LOAD_TEST_GUIDE.md');
const packageJson = JSON.parse(read('bots/hub/package.json'));
const weeklyPlist = read('bots/hub/launchd/ai.hub.llm-load-test-weekly.plist');

for (const file of [
  'tests/load/run-all.sh',
  'tests/load/baseline.js',
  'tests/load/peak.js',
  'tests/load/chaos.js',
  'tests/load/multi-team.js',
  'tests/load/analyze-results.ts',
]) {
  assertFile(file);
}

assert.match(guide, /tests\/load\/multi-team\.js/, 'load guide must point to the tracked multi-team scenario');
assert.match(guide, /tests\/load\/run-all\.sh/, 'load guide must point to the tracked runner');
assert.doesNotMatch(guide, /hub-llm-multiteam\.js/, 'load guide must not reference retired k6 script paths');
assert.match(packageJson.scripts['load:k6'], /\.\.\/\.\.\/tests\/load\/run-all\.sh/, 'load:k6 must run the tracked load runner');
assert.match(packageJson.scripts['load:k6:short'], /SHORT_MODE=true/, 'load:k6:short must enable short mode');
assert.match(weeklyPlist, /tests\/load\/run-all\.sh/, 'weekly launchd load test must use the tracked runner');

console.log(JSON.stringify({
  ok: true,
  load_runner: 'tests/load/run-all.sh',
  scenarios: ['baseline', 'peak', 'chaos', 'multi-team'],
}));
