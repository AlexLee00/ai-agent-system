'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { createNaverPickkoRunnerService } = require('../lib/naver-pickko-runner-service.ts');

class SuccessChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.pid = 123456;
    process.nextTick(() => this.emit('close', 0));
  }

  kill() {
    return true;
  }
}

async function main() {
  const patches = [];
  const states = [];

  const service = createNaverPickkoRunnerService({
    isCancelledKey: async () => false,
    getReservation: async () => ({ id: 'booking-success', status: 'processing', pickkoStatus: null, retries: 1 }),
    markSeen: async () => {},
    resolveAlertsByBooking: async () => {},
    updateBookingState: async (bookingId, booking, state) => states.push({ bookingId, state }),
    updateReservation: async (bookingId, patch) => patches.push({ bookingId, patch }),
    addCancelledKey: async () => {},
    sendAlert: async () => {},
    ragSaveReservation: async () => {},
    publishReservationAlert: async () => {},
    autoBugReport: () => {},
    transformAndNormalizeData: (booking) => booking,
    verifyRecoverablePickkoFailure: async () => false,
    reconcileSlotDuplicatesAfterRecovery: async () => ({}),
    buildPickkoCancelArgs: () => [],
    buildPickkoAccurateArgs: () => ['fake-pickko-accurate.cjs'],
    buildPickkoCancelManualMessage: () => '',
    buildPickkoRetryExceededMessage: () => '',
    buildPickkoTimeElapsedMessage: () => '',
    buildPickkoManualFailureMessage: () => '',
    maskPhone: (phone) => String(phone || '').replace(/(\d{3})\d+(\d{4})/, '$1****$2'),
    toKst: () => '2099-01-01 00:00:00',
    log: () => {},
    spawnImpl: () => new SuccessChild(),
  });

  const code = await service.runPickko({
    booking: {
      phone: '01012345678',
      phoneRaw: '01012345678',
      date: '2099-01-01',
      start: '10:00',
      end: '11:00',
      room: 'A1',
      raw: { name: '테스트' },
    },
    bookingId: 'booking-success',
    scriptsDir: process.cwd(),
    accurateScriptPath: '/tmp/fake-pickko-accurate.cjs',
    maxRetries: 3,
  });

  assert.equal(code, 0);
  assert.ok(states.some((item) => item.state === 'completed'), 'success should mark booking completed');
  assert.ok(
    patches.some((item) => item.patch && Object.prototype.hasOwnProperty.call(item.patch, 'errorReason') && item.patch.errorReason === null),
    'success should clear stale errorReason',
  );

  console.log('✅ pickko success clears error smoke ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
