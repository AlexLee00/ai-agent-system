#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const allowedJsFiles = new Map([
  ['bots/hub/__tests__/secrets-meta.node.test.js', 'node-test-runner-suite'],
  ['bots/hub/__tests__/alarm-policy.node.test.js', 'node-test-runner-suite'],
  ['bots/hub/lib/secrets-meta.js', 'node-test-runner-fixture'],
  ['bots/hub/scripts/telegram-callback-poller.js', 'ts-source-bridge'],
]);

const result = spawnSync('find', [
  'bots/hub',
  '-type',
  'f',
  '(',
  '-name',
  '*.js',
  '-o',
  '-name',
  '*.cjs',
  '-o',
  '-name',
  '*.mjs',
  ')',
  '-not',
  '-path',
  '*/node_modules/*',
], {
  cwd: repoRoot,
  encoding: 'utf8',
});

assert.equal(result.status, 0, result.stderr || 'find failed');
const files = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort();
const unexpected = files.filter((file) => !allowedJsFiles.has(file));
assert.deepEqual(unexpected, [], `unexpected Hub JS runtime islands:\n${unexpected.join('\n')}`);

const bridgePath = path.join(repoRoot, 'bots/hub/scripts/telegram-callback-poller.js');
const bridgeSource = fs.readFileSync(bridgePath, 'utf8');
assert.match(bridgeSource, /loadTsSourceBridge/, 'telegram callback JS bridge must only load TS source');
assert.ok(bridgeSource.split(/\r?\n/).filter(Boolean).length <= 4, 'telegram callback JS bridge must stay tiny');

console.log(JSON.stringify({
  ok: true,
  js_files: files.length,
  allowed_js_islands: Object.fromEntries(allowedJsFiles),
}));
