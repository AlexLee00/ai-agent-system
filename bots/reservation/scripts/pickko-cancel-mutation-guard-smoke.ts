// @ts-nocheck
'use strict';

const assert = require('assert');
const {
  createNaverPickkoRunnerService,
  PICKKO_CANCEL_BLOCKED_CODE,
} = require('../lib/naver-pickko-runner-service.ts');

async function main() {
  const previous = process.env.PICKKO_CANCEL_MUTATION_ENABLE;
  delete process.env.PICKKO_CANCEL_MUTATION_ENABLE;

  const logs = [];
  let spawnCount = 0;

  const service = createNaverPickkoRunnerService({
    isCancelledKey: async () => false,
    getReservation: async () => null,
    markSeen: async () => {},
    resolveAlertsByBooking: async () => {},
    updateBookingState: async () => {},
    updateReservation: async () => {},
    addCancelledKey: async () => {},
    sendAlert: async () => {},
    ragSaveReservation: async () => {},
    publishReservationAlert: async () => {},
    autoBugReport: () => {},
    transformAndNormalizeData: (booking) => booking,
    verifyRecoverablePickkoFailure: async () => false,
    reconcileSlotDuplicatesAfterRecovery: async () => {},
    buildPickkoCancelArgs: () => ['cancel.js'],
    buildPickkoAccurateArgs: () => ['accurate.js'],
    buildPickkoCancelManualMessage: () => 'manual cancel',
    buildPickkoRetryExceededMessage: () => 'retry exceeded',
    buildPickkoTimeElapsedMessage: () => 'time elapsed',
    buildPickkoManualFailureMessage: () => 'manual failure',
    maskPhone: (phone) => String(phone || '').replace(/(\d{3})\d+(\d{4})/, '$1****$2'),
    toKst: () => '2026-06-07',
    log: (message) => logs.push(String(message)),
    spawnImpl: () => {
      spawnCount += 1;
      throw new Error('spawn must not run while mutation guard is disabled');
    },
  });

  const result = await service.runPickkoCancel({
    booking: {
      phone: '01012345678',
      date: '2026-06-21',
      start: '15:00',
      end: '18:00',
      room: 'A1',
    },
    scriptsDir: __dirname,
    manualCancelScriptPath: '/tmp/pickko-cancel.js',
  });

  if (previous === undefined) delete process.env.PICKKO_CANCEL_MUTATION_ENABLE;
  else process.env.PICKKO_CANCEL_MUTATION_ENABLE = previous;

  assert.strictEqual(result, PICKKO_CANCEL_BLOCKED_CODE);
  assert.strictEqual(spawnCount, 0);
  assert.ok(logs.some((line) => line.includes('픽코 취소 차단')));

  console.log('✅ pickko cancel mutation guard smoke ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
