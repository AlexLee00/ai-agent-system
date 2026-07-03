// @ts-nocheck
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { createNaverPickkoRunnerService } = require('../lib/naver-pickko-runner-service.ts');

async function main() {
  const previous = process.env.PICKKO_CANCEL_MUTATION_ENABLE;
  process.env.PICKKO_CANCEL_MUTATION_ENABLE = '1';

  const doneKey = 'cancel_done|01071848299|2026-07-03|14:00|15:00|A2';
  const cancelledKeys = new Set([doneKey]);
  const logs = [];
  let spawnCount = 0;
  let updatedState = null;

  const service = createNaverPickkoRunnerService({
    isCancelledKey: async (key) => cancelledKeys.has(key),
    getReservation: async () => ({
      id: '1275815826',
      status: 'completed',
      pickkoStatus: 'manual_retry',
    }),
    markSeen: async () => {},
    resolveAlertsByBooking: async () => {},
    updateBookingState: async (id, booking, state) => { updatedState = { id, state }; },
    updateReservation: async () => {},
    addCancelledKey: async (key) => { cancelledKeys.add(key); },
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
    toKst: () => '2026-07-03',
    log: (message) => logs.push(String(message)),
    spawnImpl: () => {
      spawnCount += 1;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => child.emit('close', 0));
      return child;
    },
  });

  const result = await service.runPickkoCancel({
    booking: {
      bookingId: '1275815826',
      phone: '01071848299',
      phoneRaw: '01071848299',
      date: '2026-07-03',
      start: '14:00',
      end: '15:00',
      room: 'A2',
    },
    scriptsDir: __dirname,
    manualCancelScriptPath: '/tmp/pickko-cancel.js',
  });

  if (previous === undefined) delete process.env.PICKKO_CANCEL_MUTATION_ENABLE;
  else process.env.PICKKO_CANCEL_MUTATION_ENABLE = previous;

  assert.strictEqual(result, 0);
  assert.strictEqual(spawnCount, 1);
  assert.deepStrictEqual(updatedState, { id: '1275815826', state: 'cancelled' });
  assert.ok(logs.some((line) => line.includes('stale doneKey')));
  assert.ok(logs.some((line) => line.includes('픽코 취소 실행')));
  assert.ok(cancelledKeys.has(doneKey));

  console.log('✅ pickko cancel stale done-key smoke ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
