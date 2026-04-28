#!/usr/bin/env tsx
import assert from 'node:assert/strict';

const runtime = require('../../orchestrator/src/jay-runtime.ts');
const testOnly = runtime?._testOnly || {};

assert.equal(testOnly.isJayRuntimeCommand('/usr/bin/node /repo/bots/orchestrator/src/jay-runtime.ts'), true);
assert.equal(testOnly.isJayRuntimeCommand('/usr/bin/node /repo/bots/orchestrator/src/orchestrator.ts'), false);
assert.equal(testOnly.isJayRuntimeCommand('/usr/bin/node /repo/bots/hub/src/hub.ts'), false);
assert.equal(typeof testOnly.readProcessCommand, 'function');

console.log('jay_runtime_lock_smoke_ok');
