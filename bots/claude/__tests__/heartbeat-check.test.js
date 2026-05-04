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

async function main() {
  const tests = [test_retired_luna_crypto_softening_exists];
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
