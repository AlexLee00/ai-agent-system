#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const commander = require('../luna-commander.cjs');
const {
  isTransientDbStartupError,
  retryTransientDbStartup,
} = commander._testOnly;

async function main() {
  assert.equal(isTransientDbStartupError({ code: '57P03', message: 'the database system is starting up' }), true);
  assert.equal(isTransientDbStartupError(new Error('database system is in recovery mode')), true);
  assert.equal(isTransientDbStartupError(new Error('relation does not exist')), false);

  let attempts = 0;
  const sleeps: number[] = [];
  const result = await retryTransientDbStartup('commander_smoke', async () => {
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
    sleep: async (ms: number) => { sleeps.push(ms); },
  });
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [7, 7]);

  attempts = 0;
  await assert.rejects(
    () => retryTransientDbStartup('commander_non_retryable', async () => {
      attempts += 1;
      throw new Error('relation does not exist');
    }, { maxAttempts: 4, delayMs: 0, sleep: async () => {} }),
    /relation does not exist/,
  );
  assert.equal(attempts, 1);

  console.log('luna_commander_db_startup_retry_smoke_ok');
}

main().catch((error) => {
  console.error(`luna_commander_db_startup_retry_smoke_failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
