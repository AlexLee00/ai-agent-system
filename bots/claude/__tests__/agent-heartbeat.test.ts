'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');

const HEARTBEAT_PATH = path.resolve(__dirname, '../lib/agent-heartbeat.ts');

async function withMocks(mocks, fn) {
  const original = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request in mocks) return mocks[request];
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[HEARTBEAT_PATH];
    return await fn(require(HEARTBEAT_PATH));
  } finally {
    Module._load = original;
    delete require.cache[HEARTBEAT_PATH];
  }
}

async function test_normalizes_agent_name() {
  await withMocks({}, async heartbeat => {
    assert.strictEqual(heartbeat.normalizeAgentName('dexter'), 'claude-dexter');
    assert.strictEqual(heartbeat.normalizeAgentName('claude-dexter'), 'claude-dexter');
  });
  console.log('✅ agent-heartbeat: normalizes claude agent names');
}

async function test_writes_best_effort_success() {
  const calls = [];
  await withMocks({
    '../../../packages/core/lib/agent-heartbeats': {
      writeHeartbeat: async (...args) => calls.push(args),
    },
  }, async heartbeat => {
    const result = await heartbeat.writeClaudeHeartbeat('reviewer', 'ok', {
      durationMs: 12,
      skipped: undefined,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0], ['claude-reviewer', 'ok', { durationMs: 12 }]);
  });
  console.log('✅ agent-heartbeat: writes heartbeat with compact meta');
}

async function test_swallows_write_failure() {
  await withMocks({
    '../../../packages/core/lib/agent-heartbeats': {
      writeHeartbeat: async () => { throw new Error('db unavailable'); },
    },
  }, async heartbeat => {
    const result = await heartbeat.writeClaudeHeartbeat('guardian', 'error', { message: 'boom' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.agentName, 'claude-guardian');
    assert.match(result.error, /db unavailable/);
  });
  console.log('✅ agent-heartbeat: swallows heartbeat write failures');
}

async function test_error_meta_masks_shape() {
  await withMocks({}, async heartbeat => {
    const meta = heartbeat.errorHeartbeatMeta(new Error('failure'), { cycle: 3, empty: undefined });
    assert.deepStrictEqual(meta, { cycle: 3, message: 'failure' });
  });
  console.log('✅ agent-heartbeat: builds compact error meta');
}

async function main() {
  console.log('=== Agent Heartbeat 테스트 시작 ===\n');
  const tests = [
    test_normalizes_agent_name,
    test_writes_best_effort_success,
    test_swallows_write_failure,
    test_error_meta_masks_shape,
  ];
  let passed = 0;
  let failed = 0;
  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (error) {
      console.error(`❌ ${test.name}: ${error.message}`);
      failed++;
    }
  }
  console.log(`\n결과: ${passed}/${tests.length} 통과`);
  if (failed > 0) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
