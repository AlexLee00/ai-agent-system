#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ownerChildMode = process.argv.includes('--owner-child');
const limiterDir = ownerChildMode && process.env.HUB_LLM_SHARED_LIMITER_DIR
  ? process.env.HUB_LLM_SHARED_LIMITER_DIR
  : fs.mkdtempSync(path.join(os.tmpdir(), 'hub-llm-limiter-smoke-'));
process.env.HUB_LLM_SHARED_LIMITER_DIR = limiterDir;
process.env.HUB_LLM_SHARED_LIMITER_BACKEND = 'file';
process.env.HUB_LLM_SHARED_LIMITER_ENABLED = 'true';
process.env.HUB_LLM_SHARED_MAX_IN_FLIGHT = '1';
process.env.HUB_LLM_SHARED_TEAM_MAX_IN_FLIGHT = '1';
process.env.HUB_LLM_SHARED_PROVIDER_MAX_IN_FLIGHT = '1';

const {
  acquireSharedLimiterLease,
  getSharedLimiterState,
  resetSharedLimiterForTests,
} = require('../lib/llm/shared-limiter.ts');

function runOwnerChild() {
  return acquireSharedLimiterLease({ team: 'luna', provider: 'openai-oauth' }).then(async (lease) => {
    console.log(JSON.stringify({ ok: lease.ok, reason: lease.reason || null }));
    if (lease.ok) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      await lease.release();
    }
  });
}

function spawnOwnerChild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', __filename, '--owner-child'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || `owner child exited ${code}`));
      const line = stdout.trim().split('\n').find((entry) => entry.startsWith('{'));
      if (!line) return reject(new Error(`owner child result missing: ${stdout}`));
      return resolve(JSON.parse(line));
    });
  });
}

async function main() {
  resetSharedLimiterForTests();
  const ownerResults = await Promise.all([spawnOwnerChild(), spawnOwnerChild()]);
  assert.equal(ownerResults.filter((result) => result.ok).length, 1, 'file backend must allow one Hub process');
  assert.equal(
    ownerResults.filter((result) => !result.ok)[0]?.reason,
    'shared_limiter_file_backend_single_process',
  );
  resetSharedLimiterForTests();

  const first = await acquireSharedLimiterLease({ team: 'luna', provider: 'openai-oauth' });
  assert.equal(first.ok, true, 'first shared lease must be acquired');

  const second = await acquireSharedLimiterLease({ team: 'luna', provider: 'openai-oauth' });
  assert.equal(second.ok, false, 'second shared lease must be rejected when limit=1');
  assert.equal(second.reason, 'shared_limiter_full');
  assert(second.retryAfterMs > 0, 'shared limiter rejection must expose retryAfterMs');

  first.release();
  const third = await acquireSharedLimiterLease({ team: 'luna', provider: 'openai-oauth' });
  assert.equal(third.ok, true, 'shared lease must be reusable after release');
  third.release();

  const state = getSharedLimiterState();
  assert.equal(state.enabled, true);
  assert.equal(state.backend, 'file');
  assert.equal(state.dir, limiterDir);
  assert.equal(state.capabilities.multi_process, false);
  assert.equal(state.capabilities.fairness_scope.includes('provider'), true);

  console.log(JSON.stringify({
    ok: true,
    shared_limiter: true,
    scopes: Object.keys(state.scopes).sort(),
  }));
}

const run = ownerChildMode ? runOwnerChild : main;
run().finally(() => {
  if (!ownerChildMode) {
    resetSharedLimiterForTests();
    fs.rmSync(limiterDir, { recursive: true, force: true });
  }
}).catch((error) => {
  console.error('[llm-shared-limiter-smoke] failed:', error?.message || error);
  process.exitCode = 1;
});
