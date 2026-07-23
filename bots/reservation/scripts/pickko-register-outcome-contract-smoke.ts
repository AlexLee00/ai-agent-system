// @ts-nocheck
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  PICKKO_REGISTER_FOLLOWUP_REQUIRED_CODE,
  classifyBatchRegisterExitCode,
  resolvePickkoRegisterOutcome,
} = require('../lib/pickko-register-contract.ts');
const { loadBookings } = require('./manual-batch-reserve.ts');

function main() {
  assert.deepStrictEqual(resolvePickkoRegisterOutcome({
    pickkoExitCode: 0,
    naverBlockExitCode: 0,
  }), {
    success: true,
    pickkoRegistered: true,
    status: 'complete',
    exitCode: 0,
  });

  const followup = resolvePickkoRegisterOutcome({
    pickkoExitCode: 0,
    naverBlockExitCode: 1,
  });
  assert.equal(followup.pickkoRegistered, true);
  assert.equal(followup.status, 'naver_block_pending');
  assert.equal(followup.exitCode, PICKKO_REGISTER_FOLLOWUP_REQUIRED_CODE);
  assert.equal(classifyBatchRegisterExitCode(followup.exitCode), 'registered_followup');
  assert.equal(classifyBatchRegisterExitCode(1), 'retry_room');
  assert.equal(classifyBatchRegisterExitCode(2), 'terminal_failure');

  const elapsed = resolvePickkoRegisterOutcome({ pickkoExitCode: 2 });
  assert.equal(elapsed.success, false);
  assert.equal(elapsed.pickkoRegistered, false);
  assert.equal(elapsed.exitCode, 2);

  assert.deepStrictEqual(loadBookings(['node', 'script']), []);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ska-batch-contract-'));
  const inputPath = path.join(tempDir, 'bookings.json');
  fs.writeFileSync(inputPath, JSON.stringify([{
    name: '테스트',
    phone: '01000000000',
    date: '2026-07-24',
    start: '10:00',
    end: '11:00',
    room: 'A1',
  }]));
  assert.equal(loadBookings(['node', 'script', `--input=${inputPath}`]).length, 1);
  fs.rmSync(tempDir, { recursive: true, force: true });

  const batchSource = fs.readFileSync(path.join(__dirname, 'manual-batch-reserve.ts'), 'utf8');
  assert.doesNotMatch(batchSource, /releasePickkoLock/);
  assert.doesNotMatch(batchSource, /010\d{8}/, 'customer phone numbers must not be committed in the batch runner');
  console.log('pickko_register_outcome_contract_smoke_ok');
}

main();
