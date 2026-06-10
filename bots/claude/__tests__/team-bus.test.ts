'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const TEAM_BUS_PATH = path.resolve(__dirname, '../lib/team-bus.ts');

async function withPgPoolMock(pgPool, fn) {
  const original = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../../../packages/core/lib/pg-pool') return pgPool;
    return original.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[TEAM_BUS_PATH];
    return await fn(require(TEAM_BUS_PATH));
  } finally {
    Module._load = original;
    delete require.cache[TEAM_BUS_PATH];
  }
}

async function test_mark_done_clears_active_error() {
  const calls = [];
  const pgPool = {
    run: async (...args) => calls.push(args),
    closeAll: async () => {},
  };

  await withPgPoolMock(pgPool, async (teamBus) => {
    await teamBus.markDone('dexter');
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'claude');
  assert.match(calls[0][1], /last_error\s*=\s*NULL/);
  assert.deepEqual(calls[0][2], ['dexter']);
}

async function main() {
  console.log('=== Team Bus 테스트 시작 ===\n');
  await test_mark_done_clears_active_error();
  console.log('✅ team-bus: markDone clears stale active error');
  console.log('\n결과: 1/1 통과');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
