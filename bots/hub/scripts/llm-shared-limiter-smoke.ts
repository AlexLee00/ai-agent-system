#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const limiterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-llm-limiter-smoke-'));
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

async function main() {
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
  assert.equal(state.capabilities.multi_process, true);
  assert.equal(state.capabilities.fairness_scope.includes('provider'), true);

  console.log(JSON.stringify({
    ok: true,
    shared_limiter: true,
    scopes: Object.keys(state.scopes).sort(),
  }));
}

main().finally(() => {
  resetSharedLimiterForTests();
  fs.rmSync(limiterDir, { recursive: true, force: true });
}).catch((error) => {
  console.error('[llm-shared-limiter-smoke] failed:', error?.message || error);
  process.exitCode = 1;
});
