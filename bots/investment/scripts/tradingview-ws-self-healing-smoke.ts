#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  DEFAULT_LONG_RETRY_GIVEUP_MS,
  DEFAULT_LONG_RETRY_INTERVAL_MS,
  buildReconnectPlan,
  createLongRetryState,
  positiveInt,
  resetLongRetryState,
} from '../services/tradingview-ws/src/reconnect-self-healing.js';

export function runTradingViewWsSelfHealingSmoke() {
  const scheduled = buildReconnectPlan({
    reconnectAttempts: 3,
    maxReconnectAttempts: 10,
    baseDelayMs: 2000,
    longRetryState: createLongRetryState(),
    nowMs: 1_000,
  });
  assert.equal(scheduled.mode, 'scheduled');
  assert.equal(scheduled.delayMs, 16_000);
  assert.equal(scheduled.nextReconnectAttempts, 4);
  assert.equal(scheduled.metricType, 'scheduled');

  const firstLongRetry = buildReconnectPlan({
    reconnectAttempts: 10,
    maxReconnectAttempts: 10,
    longRetryState: createLongRetryState(),
    nowMs: 10_000,
  });
  assert.equal(firstLongRetry.mode, 'long_retry');
  assert.equal(firstLongRetry.delayMs, DEFAULT_LONG_RETRY_INTERVAL_MS);
  assert.equal(firstLongRetry.metricType, 'long_retry');
  assert.deepEqual(firstLongRetry.longRetryState, { startedAt: 10_000, attempts: 1 });

  const nextLongRetry = buildReconnectPlan({
    reconnectAttempts: 10,
    maxReconnectAttempts: 10,
    longRetryState: firstLongRetry.longRetryState,
    nowMs: 10_000 + DEFAULT_LONG_RETRY_INTERVAL_MS,
  });
  assert.equal(nextLongRetry.mode, 'long_retry');
  assert.equal(nextLongRetry.longRetryState.startedAt, 10_000);
  assert.equal(nextLongRetry.longRetryState.attempts, 2);

  const giveup = buildReconnectPlan({
    reconnectAttempts: 10,
    maxReconnectAttempts: 10,
    longRetryState: firstLongRetry.longRetryState,
    nowMs: 10_000 + DEFAULT_LONG_RETRY_GIVEUP_MS + 1,
  });
  assert.equal(giveup.mode, 'exit');
  assert.equal(giveup.metricType, 'failed');

  const mutableState = { startedAt: 123, attempts: 7 };
  resetLongRetryState(mutableState);
  assert.deepEqual(mutableState, { startedAt: null, attempts: 0 });

  const forceResetState = createLongRetryState(1_000);
  forceResetState.attempts = 5;
  resetLongRetryState(forceResetState);
  const afterForceReset = buildReconnectPlan({
    reconnectAttempts: 0,
    maxReconnectAttempts: 10,
    baseDelayMs: 2000,
    longRetryState: forceResetState,
    nowMs: 2_000,
  });
  assert.equal(afterForceReset.mode, 'scheduled');
  assert.equal(afterForceReset.delayMs, 2_000);
  assert.equal(afterForceReset.nextReconnectAttempts, 1);

  assert.equal(positiveInt('2500', 100), 2500);
  assert.equal(positiveInt('0', 100), 100);
  assert.equal(positiveInt('bad', 100), 100);

  return {
    ok: true,
    scheduledDelayMs: scheduled.delayMs,
    longRetryDelayMs: firstLongRetry.delayMs,
    giveupMode: giveup.mode,
  };
}

async function main() {
  const result = runTradingViewWsSelfHealingSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('tradingview-ws-self-healing smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'tradingview-ws-self-healing smoke failed:' });
}
