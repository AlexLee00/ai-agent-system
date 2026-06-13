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
  const alerts = [];
  const published = [];
  const cancelledKeys = new Set();
  let spawnCount = 0;

  const service = createNaverPickkoRunnerService({
    isCancelledKey: async (key) => cancelledKeys.has(key),
    getReservation: async () => null,
    markSeen: async () => {},
    resolveAlertsByBooking: async () => {},
    updateBookingState: async () => {},
    updateReservation: async () => {},
    addCancelledKey: async (key) => { cancelledKeys.add(key); },
    sendAlert: async (payload) => { alerts.push(payload); },
    ragSaveReservation: async () => {},
    publishReservationAlert: async (payload) => { published.push(payload); },
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

  const booking = {
    phone: '01012345678',
    date: '2026-06-21',
    start: '15:00',
    end: '18:00',
    room: 'A1',
  };
  const result = await service.runPickkoCancel({
    booking,
    scriptsDir: __dirname,
    manualCancelScriptPath: '/tmp/pickko-cancel.js',
  });
  const secondResult = await service.runPickkoCancel({
    booking,
    scriptsDir: __dirname,
    manualCancelScriptPath: '/tmp/pickko-cancel.js',
  });

  if (previous === undefined) delete process.env.PICKKO_CANCEL_MUTATION_ENABLE;
  else process.env.PICKKO_CANCEL_MUTATION_ENABLE = previous;

  assert.strictEqual(result, PICKKO_CANCEL_BLOCKED_CODE);
  assert.strictEqual(secondResult, PICKKO_CANCEL_BLOCKED_CODE);
  assert.strictEqual(spawnCount, 0);
  assert.ok(logs.some((line) => line.includes('픽코 취소 차단')));
  assert.ok(logs.some((line) => line.includes('취소 차단 알림 스킵')));
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(published.length, 1);
  assert.ok(cancelledKeys.has('cancel_blocked|01012345678|2026-06-21|15:00|18:00|A1'));
  assert.equal(cancelledKeys.has('cancel_done|01012345678|2026-06-21|15:00|18:00|A1'), false);

  console.log('✅ pickko cancel mutation guard smoke ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
