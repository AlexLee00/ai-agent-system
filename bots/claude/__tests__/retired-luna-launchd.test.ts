// @ts-nocheck
'use strict';

/**
 * Regression smoke: retired Luna launchd labels must not be probed or restarted.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const doctorSrc = fs.readFileSync(path.join(ROOT, 'lib/doctor.ts'), 'utf8');
const errorLogsSrc = fs.readFileSync(path.join(ROOT, 'lib/checks/error-logs.ts'), 'utf8');

function test_doctor_blocks_retired_restarts() {
  assert.ok(
    doctorSrc.includes('if (isRetiredService(label)) throw new Error(retiredServiceMessage(label));'),
    'doctor restart action must reject retired launchd labels before kickstart',
  );
  assert.ok(
    doctorSrc.includes('RECOVERY_BLACKLIST.has(label) || isRetiredService(label)'),
    'doctor launchd discovery must classify retired labels as non-recoverable',
  );
  assert.ok(
    doctorSrc.includes('if (isRetiredService(label)) continue;'),
    'doctor autoscan must skip retired mapped labels',
  );
}

function test_error_logs_do_not_probe_retired_launchd() {
  assert.ok(
    errorLogsSrc.includes('const retired = isRetiredService(launchdLabel);'),
    'error-log check must compute retired status before launchctl probing',
  );
  assert.ok(
    errorLogsSrc.includes('const launchdStatus = retired ? null : getLaunchdStatus(launchdLabel);'),
    'error-log check must not call launchctl for retired labels',
  );
  assert.ok(
    errorLogsSrc.includes('launchctl 조회/재시작 제외'),
    'retired detail should explain that old labels are excluded from launchctl probing',
  );
}

async function main() {
  const tests = [
    test_doctor_blocks_retired_restarts,
    test_error_logs_do_not_probe_retired_launchd,
  ];

  let passed = 0;
  for (const test of tests) {
    await test();
    passed += 1;
  }

  console.log(`retired-luna-launchd smoke ok (${passed}/${tests.length})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
