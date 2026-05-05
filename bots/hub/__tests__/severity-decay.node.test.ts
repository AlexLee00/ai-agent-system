'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../lib/alarm/severity-decay.ts'),
  'utf8',
);

async function test_make_interval_guard_exists() {
  assert.ok(
    SOURCE.includes("make_interval(hours => $2::integer)"),
    'severity decay query uses make_interval with integer hours',
  );
  assert.ok(
    SOURCE.includes('const minAgeHours = Math.max(1, Math.trunc(Number(rule.minAgeHours) || 0));'),
    'severity decay normalizes minAgeHours before query execution',
  );
  console.log('✅ severity-decay: SQL interval typing guard present');
}

async function main() {
  const tests = [test_make_interval_guard_exists];
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
