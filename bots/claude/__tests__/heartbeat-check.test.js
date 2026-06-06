'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../lib/checks/heartbeat-check.ts'),
  'utf8',
);

async function test_retired_luna_crypto_softening_exists() {
  assert.ok(
    SOURCE.includes('softenRetiredLunaCryptoHeartbeatIfReplacementHealthy'),
    'retired luna-crypto heartbeat softening helper exists',
  );
  assert.ok(
    SOURCE.includes("row.agent_name === 'luna-crypto'"),
    'luna-crypto heartbeat branch exists',
  );
  assert.ok(
    SOURCE.includes("getServiceOwnership('ai.investment.crypto')"),
    'retired crypto service ownership lookup exists',
  );
  console.log('✅ heartbeat-check: retired luna-crypto heartbeat softening present');
}

async function test_quiet_claude_agent_softening_exists() {
  assert.ok(
    SOURCE.includes('softenQuietClaudeHeartbeatIfLaunchdHealthy'),
    'quiet Claude heartbeat softening helper exists',
  );
  assert.ok(
    SOURCE.includes('OPERATIONALLY_QUIET_CLAUDE_AGENTS'),
    'quiet Claude heartbeat policy map exists',
  );
  for (const label of [
    'ai.claude.archer',
    'ai.claude.guardian',
    'ai.claude.reviewer',
    'ai.claude.refactor-cycle',
  ]) {
    assert.ok(SOURCE.includes(label), `quiet Claude launchd mapping exists: ${label}`);
  }
  assert.ok(
    SOURCE.includes('operationally quiet'),
    'quiet Claude heartbeat detail explains operationally quiet state',
  );
  console.log('✅ heartbeat-check: quiet Claude heartbeat softening present');
}

async function main() {
  const tests = [
    test_retired_luna_crypto_softening_exists,
    test_quiet_claude_agent_softening_exists,
  ];
  let passed = 0;

  for (const testFn of tests) {
    await testFn();
    passed += 1;
  }

  console.log(`결과: ${passed}/${tests.length} 통과`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
