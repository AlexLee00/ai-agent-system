#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { createCompletedBarTracker } from '../services/tradingview-ws/src/completed-bar-tracker.js';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function bar(timestamp, close) {
  return {
    symbol: 'BINANCE:BTCUSDT',
    timeframe: '60',
    timestamp,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 10,
  };
}

export function runTradingViewBarPublishDedupeSmoke() {
  const tracker = createCompletedBarTracker();
  const key = 'BINANCE:BTCUSDT:60';

  const initialReplay = [bar(1_000, 10), bar(2_000, 20), bar(3_000, 30)];
  assert.deepEqual(tracker.observe(key, initialReplay), []);
  assert.deepEqual(tracker.observe(key, initialReplay), []);
  assert.deepEqual(tracker.observe(key, [bar(3_000, 31)]), []);

  const firstTransition = tracker.observe(key, [
    ...initialReplay.slice(0, 2),
    bar(3_000, 32),
    bar(4_000, 40),
  ]);
  assert.deepEqual(firstTransition, [bar(3_000, 32)]);
  assert.deepEqual(tracker.observe(key, [bar(4_000, 41)]), []);

  const skippedInterval = tracker.observe(key, [
    bar(4_000, 42),
    bar(5_000, 50),
    bar(6_000, 60),
  ]);
  assert.deepEqual(skippedInterval, [bar(4_000, 42), bar(5_000, 50)]);
  assert.deepEqual(tracker.observe(key, [bar(5_000, 999)]), []);

  const otherKey = 'BINANCE:ETHUSDT:60';
  assert.deepEqual(tracker.observe(otherKey, [bar(10_000, 100), bar(11_000, 110)]), []);
  assert.deepEqual(tracker.observe(otherKey, [bar(11_000, 111), bar(12_000, 120)]), [bar(11_000, 111)]);

  tracker.delete(key);
  assert.deepEqual(tracker.observe(key, initialReplay), []);

  return {
    ok: true,
    initialReplayPublished: 0,
    firstTransitionPublished: firstTransition.length,
    skippedIntervalPublished: skippedInterval.length,
  };
}

async function main() {
  const result = runTradingViewBarPublishDedupeSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('tradingview-ws bar publish dedupe smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'tradingview-ws bar publish dedupe smoke failed:' });
}
