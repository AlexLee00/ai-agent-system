'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');

const HEARTBEAT_PATH = path.resolve(__dirname, '../lib/agent-heartbeat.ts');
const HEARTBEAT_CHECK_PATH = path.resolve(__dirname, '../lib/checks/heartbeat-check.ts');

async function withMocks(mocks, fn, targetPath = HEARTBEAT_PATH) {
  const original = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request in mocks) return mocks[request];
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[targetPath];
    return await fn(require(targetPath));
  } finally {
    Module._load = original;
    delete require.cache[targetPath];
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

async function test_archer_calendar_job_idle_is_softened() {
  await withMocks({
    '../../../../packages/core/lib/agent-heartbeats': {
      listHeartbeats: async () => [{
        agent_name: 'claude-archer',
        last_heartbeat: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        status: 'ok',
      }],
    },
    '../../../../packages/core/lib/pg-pool': {},
    'child_process': {
      execSync: () => 'state = not running\nlast exit code = (never exited)\n',
    },
    '../../../../packages/core/lib/env': { LAUNCHD_AVAILABLE: true },
    '../../../../packages/core/lib/service-ownership.js': { getServiceOwnership: () => null },
  }, async heartbeatCheck => {
    const result = await heartbeatCheck.run();
    assert.strictEqual(result.status, 'ok');
    assert.match(result.items[0].detail, /operationally quiet/);
    assert.match(result.items[0].detail, /ai\.claude\.archer not running/);
  }, HEARTBEAT_CHECK_PATH);
  console.log('✅ heartbeat-check: softens idle archer calendar job');
}

async function main() {
  console.log('=== Agent Heartbeat 테스트 시작 ===\n');
  const tests = [
    test_normalizes_agent_name,
    test_writes_best_effort_success,
    test_swallows_write_failure,
    test_error_meta_masks_shape,
    test_archer_calendar_job_idle_is_softened,
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
