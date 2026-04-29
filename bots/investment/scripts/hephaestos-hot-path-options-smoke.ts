#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  createPendingSignalProcessing,
  getPendingSignalConcurrency,
} from '../team/hephaestos/pending-signal-processing.ts';
import { isHephaestosHotPathPrefetchEnabled } from '../team/hephaestos/signal-executor.ts';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function observeMaxConcurrency(concurrency) {
  let running = 0;
  let maxRunning = 0;
  const processor = createPendingSignalProcessing({
    executeSignal: async (signal) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await sleep(10);
      running -= 1;
      return { id: signal.id };
    },
    delay: async () => {},
  });

  const results = await processor.runPendingSignalBatch([
    { id: 'a' },
    { id: 'b' },
    { id: 'c' },
    { id: 'd' },
  ], {
    tradeMode: 'validation',
    delayMs: 0,
    concurrency,
  });

  return {
    maxRunning,
    resultIds: results.map((result) => result.id),
  };
}

assert.equal(getPendingSignalConcurrency({}), 1);
assert.equal(getPendingSignalConcurrency({ HEPHAESTOS_PENDING_SIGNAL_CONCURRENCY: '2' }), 2);
assert.equal(getPendingSignalConcurrency({ HEPHAESTOS_PENDING_SIGNAL_CONCURRENCY: '99' }), 4);
assert.equal(getPendingSignalConcurrency({ HEPHAESTOS_PENDING_SIGNAL_CONCURRENCY: 'bad' }), 1);
assert.equal(getPendingSignalConcurrency({ LUNA_PENDING_SIGNAL_CONCURRENCY: '3' }), 3);

assert.equal(isHephaestosHotPathPrefetchEnabled({}), false);
assert.equal(isHephaestosHotPathPrefetchEnabled({ HEPHAESTOS_HOT_PATH_PREFETCH_ENABLED: '1' }), true);
assert.equal(isHephaestosHotPathPrefetchEnabled({ HEPHAESTOS_HOT_PATH_PREFETCH_ENABLED: 'true' }), false);

const sequential = await observeMaxConcurrency(1);
assert.equal(sequential.maxRunning, 1);
assert.deepEqual(sequential.resultIds, ['a', 'b', 'c', 'd']);

const parallel = await observeMaxConcurrency(2);
assert.equal(parallel.maxRunning, 2);
assert.deepEqual(parallel.resultIds, ['a', 'b', 'c', 'd']);

const payload = {
  ok: true,
  smoke: 'hephaestos-hot-path-options',
  sequential,
  parallel,
  maxConfiguredConcurrency: getPendingSignalConcurrency({ HEPHAESTOS_PENDING_SIGNAL_CONCURRENCY: '99' }),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('✅ hephaestos hot path options smoke passed');
}
