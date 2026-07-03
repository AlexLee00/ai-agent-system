// @ts-nocheck
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { createNaverPickkoRunnerService } = require('../lib/naver-pickko-runner-service.ts');

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.pid = 999999;
    this.killSignals = [];
  }

  kill(signal) {
    this.killSignals.push(signal);
    if (signal === 'SIGTERM') {
      process.nextTick(() => this.emit('close', null));
    }
    return true;
  }
}

async function main() {
  const previousTimeout = process.env.PICKKO_ACCURATE_TIMEOUT_MS;
  process.env.PICKKO_ACCURATE_TIMEOUT_MS = '1';

  const logs = [];
  const states = [];
  const patches = [];
  const fakeChild = new FakeChild();

  const service = createNaverPickkoRunnerService({
    isCancelledKey: async () => false,
    getReservation: async () => ({ id: 'booking-timeout', status: 'pending', pickkoStatus: null, retries: 0 }),
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
    log: (message) => logs.push(String(message)),
    spawnImpl: () => fakeChild,
    setTimeoutImpl: (fn) => {
      process.nextTick(fn);
      return { fake: true };
    },
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
    bookingId: 'booking-timeout',
    scriptsDir: process.cwd(),
    accurateScriptPath: '/tmp/fake-pickko-accurate.cjs',
    maxRetries: 3,
  });

  if (previousTimeout == null) delete process.env.PICKKO_ACCURATE_TIMEOUT_MS;
  else process.env.PICKKO_ACCURATE_TIMEOUT_MS = previousTimeout;

  assert.equal(code, 1);
  assert.ok(fakeChild.killSignals.includes('SIGTERM'), 'timeout should terminate the child process');
  assert.ok(states.some((item) => item.state === 'processing'), 'booking should enter processing first');
  assert.ok(states.some((item) => item.state === 'failed'), 'timeout should mark booking failed');
  assert.ok(
    patches.some((item) => String(item.patch.errorReason || '').includes('[CHILD_TIMEOUT]')),
    'timeout failure should preserve CHILD_TIMEOUT error reason',
  );
  assert.ok(logs.some((line) => line.includes('[픽코 타임아웃]')), 'timeout should be logged');

  console.log('✅ pickko accurate child-timeout smoke ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
