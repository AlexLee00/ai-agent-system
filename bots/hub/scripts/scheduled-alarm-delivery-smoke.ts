#!/usr/bin/env tsx
'use strict';

const assert = require('node:assert/strict');
const { deliverScheduledAlarm } = require('../lib/alarm/scheduled-delivery.ts');

async function assertRetryThenDeliver() {
  const sleeps = [];
  const calls = [];
  const results = [
    { ok: false, status: 429, retryable: true, retryAfterMs: 2500, error: 'rate limit exceeded (200/min)' },
    { ok: true, status: 200 },
  ];
  const delivery = await deliverScheduledAlarm({ message: 'smoke' }, {
    maxAttempts: 2,
    maxDelayMs: 1000,
    postAlarm: async (payload) => {
      calls.push(payload);
      const result = results.shift();
      assert(result, 'expected queued postAlarm result');
      return result;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    logger: { warn: () => undefined },
  });

  assert.equal(delivery.ok, true);
  assert.equal(delivery.delivered, true);
  assert.equal(delivery.deferred, false);
  assert.equal(delivery.status, 'delivered');
  assert.equal(delivery.attempts, 2);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(calls.length, 2);
}

async function assertRetryableExhaustionDefers() {
  const delivery = await deliverScheduledAlarm({ message: 'smoke' }, {
    maxAttempts: 2,
    maxDelayMs: 1000,
    postAlarm: async () => ({
      ok: false,
      status: 429,
      retryable: true,
      retryAfterMs: 2000,
      error: 'rate limit exceeded (200/min)',
    }),
    sleep: async () => undefined,
    logger: { warn: () => undefined },
  });

  assert.equal(delivery.ok, true);
  assert.equal(delivery.delivered, false);
  assert.equal(delivery.deferred, true);
  assert.equal(delivery.status, 'deferred_retryable_failure');
  assert.equal(delivery.attempts, 2);
  assert.equal(delivery.retryable, true);
  assert.equal(delivery.retryAfterMs, 1000);
}

async function assertNonRetryableFailureFails() {
  const delivery = await deliverScheduledAlarm({ message: 'smoke' }, {
    maxAttempts: 3,
    postAlarm: async () => ({
      ok: false,
      status: 401,
      error: 'hub_alarm_auth_missing',
    }),
    sleep: async () => {
      throw new Error('sleep should not run for non-retryable failures');
    },
    logger: { warn: () => undefined },
  });

  assert.equal(delivery.ok, false);
  assert.equal(delivery.delivered, false);
  assert.equal(delivery.deferred, false);
  assert.equal(delivery.status, 'failed');
  assert.equal(delivery.attempts, 1);
  assert.equal(delivery.retryable, false);
  assert.equal(delivery.error, 'hub_alarm_auth_missing');
}

async function assertStrictRetryableFailureFails() {
  const delivery = await deliverScheduledAlarm({ message: 'smoke' }, {
    maxAttempts: 1,
    deferRetryableFailure: false,
    postAlarm: async () => ({
      ok: false,
      status: 429,
      retryable: true,
      retryAfterMs: 500,
      error: 'rate limit exceeded (200/min)',
    }),
    logger: { warn: () => undefined },
  });

  assert.equal(delivery.ok, false);
  assert.equal(delivery.deferred, false);
  assert.equal(delivery.status, 'failed');
  assert.equal(delivery.retryable, true);
}

async function main() {
  await assertRetryThenDeliver();
  await assertRetryableExhaustionDefers();
  await assertNonRetryableFailureFails();
  await assertStrictRetryableFailureFails();
  console.log('[scheduled-alarm-delivery-smoke] ok');
}

main().catch((error) => {
  console.error('[scheduled-alarm-delivery-smoke] failed:', error.message);
  process.exit(1);
});
