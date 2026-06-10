#!/usr/bin/env tsx
import assert from 'node:assert/strict';

const runtime = require('../src/jay-runtime.ts');
const {
  isTransientDbStartupError,
  retryStartupInit,
} = runtime._testOnly;

async function main() {
  assert.equal(isTransientDbStartupError({ code: '57P03', message: 'the database system is starting up' }), true);
  assert.equal(isTransientDbStartupError(new Error('database system is in recovery mode')), true);
  assert.equal(isTransientDbStartupError(new Error('permission denied')), false);

  let attempts = 0;
  const slept: number[] = [];
  const result = await retryStartupInit('smoke_init', async () => {
    attempts += 1;
    if (attempts < 3) {
      const error: any = new Error('the database system is starting up');
      error.code = '57P03';
      throw error;
    }
    return 'ok';
  }, {
    maxAttempts: 4,
    delayMs: 7,
    sleep: async (ms: number) => { slept.push(ms); },
  });
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
  assert.deepEqual(slept, [7, 7]);

  attempts = 0;
  await assert.rejects(
    () => retryStartupInit('non_retryable', async () => {
      attempts += 1;
      throw new Error('permission denied');
    }, { maxAttempts: 4, delayMs: 0, sleep: async () => {} }),
    /permission denied/,
  );
  assert.equal(attempts, 1);

  attempts = 0;
  await assert.rejects(
    () => retryStartupInit('exhausted', async () => {
      attempts += 1;
      const error: any = new Error('the database system is starting up');
      error.code = '57P03';
      throw error;
    }, { maxAttempts: 2, delayMs: 0, sleep: async () => {} }),
    /database system is starting up/,
  );
  assert.equal(attempts, 2);

  console.log('jay_runtime_db_startup_retry_smoke_ok');
}

main().catch((error) => {
  console.error(`jay_runtime_db_startup_retry_smoke_failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
