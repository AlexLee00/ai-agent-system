#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function mustInclude(file, needle, label) {
  const text = read(file);
  assert(text.includes(needle), `${label} missing ${needle}`);
}

mustInclude('bots/hub/src/route-registry.ts', "app.post('/hub/llm/jobs'", 'async job route');
mustInclude('bots/hub/src/route-registry.ts', "app.get('/hub/llm/jobs/:id/result'", 'async job result route');
mustInclude('bots/hub/lib/routes/llm.ts', 'buildProviderBackpressure', 'provider backpressure propagation');
mustInclude('bots/hub/lib/routes/llm.ts', "res.set('Retry-After'", 'provider retry-after propagation');
mustInclude('bots/hub/lib/llm/admission-control.ts', 'HUB_LLM_OVERFLOW_TO_JOB', 'overflow-to-job contract');
mustInclude('bots/hub/lib/llm/admission-control.ts', 'getSharedLimiterState', 'shared limiter state');
mustInclude('bots/hub/lib/llm/shared-limiter.ts', 'HUB_LLM_SHARED_LIMITER_DIR', 'shared limiter implementation');
mustInclude('bots/hub/lib/llm/shared-limiter.ts', 'shared_limiter_full', 'shared limiter backpressure');
mustInclude('bots/hub/package.json', '"typecheck:strict"', 'strict TS script');
mustInclude('bots/hub/package.json', '"load:k6"', 'load test script');
mustInclude('docs/hub/LOAD_TEST_GUIDE.md', 'tests/load/run-all.sh', 'load guide mapping');

const tsconfig = JSON.parse(read('bots/hub/tsconfig.json'));
assert.equal(tsconfig.compilerOptions?.strict, true, 'Hub strict TS island must be strict');

console.log(JSON.stringify({
  ok: true,
  gates: [
    'async_jobs',
    'shared_limiter',
    'provider_retry_after',
    'strict_ts_island',
    'load_test_mapping',
  ],
}));
