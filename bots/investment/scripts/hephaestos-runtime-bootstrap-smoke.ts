#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { createHephaestosRuntimeBootstrap } from '../team/hephaestos/runtime-bootstrap.ts';

let nowMs = 1_000;
let calls = 0;
const bootstrap = createHephaestosRuntimeBootstrap({
  now: () => nowMs,
  successTtlMs: 1_000,
  failureRetryMs: 500,
  initHubSecrets: async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return true;
  },
});

const [first, second, third] = await Promise.all([
  bootstrap.ensureHubSecrets(),
  bootstrap.ensureHubSecrets(),
  bootstrap.ensureHubSecrets(),
]);
assert.equal(first, true);
assert.equal(second, true);
assert.equal(third, true);
assert.equal(calls, 1);
assert.equal(bootstrap.getState().initialized, true);
assert.equal(bootstrap.getState().calls, 1);

assert.equal(await bootstrap.ensureHubSecrets(), true);
assert.equal(calls, 1);

nowMs += 1_100;
assert.equal(await bootstrap.ensureHubSecrets(), true);
assert.equal(calls, 2);

let failedCalls = 0;
const failingBootstrap = createHephaestosRuntimeBootstrap({
  now: () => nowMs,
  successTtlMs: 1_000,
  failureRetryMs: 500,
  initHubSecrets: async () => {
    failedCalls += 1;
    return false;
  },
});

assert.equal(await failingBootstrap.ensureHubSecrets(), false);
assert.equal(await failingBootstrap.ensureHubSecrets(), false);
assert.equal(failedCalls, 1);

nowMs += 501;
assert.equal(await failingBootstrap.ensureHubSecrets(), false);
assert.equal(failedCalls, 2);

const payload = {
  ok: true,
  smoke: 'hephaestos-runtime-bootstrap',
  successCalls: calls,
  failedCalls,
  state: bootstrap.getState(),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('✅ hephaestos runtime bootstrap smoke passed');
}
