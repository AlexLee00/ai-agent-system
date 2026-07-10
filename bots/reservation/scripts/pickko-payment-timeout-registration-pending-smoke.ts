// @ts-nocheck
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { createNaverPickkoRunnerService } = require('../lib/naver-pickko-runner-service.ts');

class PaymentTimeoutChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.pid = 999998;
    process.nextTick(() => {
      this.stdout.emit('data', Buffer.from('PICKKO_FAILURE_STAGE=PAYMENT\nError: Runtime.callFunctionOn timed out\n'));
      this.emit('close', 1);
    });
  }

  kill() {
    return true;
  }
}

async function main() {
  const previousTimeout = process.env.PICKKO_ACCURATE_TIMEOUT_MS;
  process.env.PICKKO_ACCURATE_TIMEOUT_MS = '0';

  const states = [];
  const patches = [];
  const alerts = [];
  const bugReports = [];

  const service = createNaverPickkoRunnerService({
    isCancelledKey: async () => false,
    getReservation: async () => ({ id: 'booking-payment-timeout', status: 'pending', pickkoStatus: null, retries: 0 }),
    markSeen: async () => {},
    resolveAlertsByBooking: async () => {},
    updateBookingState: async (bookingId, booking, state) => states.push({ bookingId, state }),
    updateReservation: async (bookingId, patch) => patches.push({ bookingId, patch }),
    addCancelledKey: async () => {},
    sendAlert: async (payload) => alerts.push(payload),
    ragSaveReservation: async () => {},
    publishReservationAlert: async () => {},
    autoBugReport: (payload) => bugReports.push(payload),
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
    spawnImpl: () => new PaymentTimeoutChild(),
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
    bookingId: 'booking-payment-timeout',
    scriptsDir: process.cwd(),
    accurateScriptPath: '/tmp/fake-pickko-accurate.cjs',
    maxRetries: 3,
  });

  if (previousTimeout == null) delete process.env.PICKKO_ACCURATE_TIMEOUT_MS;
  else process.env.PICKKO_ACCURATE_TIMEOUT_MS = previousTimeout;

  assert.equal(code, 1, 'payment follow-up remains an operational queue result');
  assert.ok(states.some((item) => item.state === 'completed'), 'payment failure after save must remain completed');
  assert.ok(!states.some((item) => item.state === 'failed'), 'persisted registration must not be marked failed');
  assert.ok(
    patches.some((item) => item.patch.pickkoStatus === 'manual_pending'
      && String(item.patch.errorReason).includes('[PAYMENT]')),
    'payment failure must enter the manual_pending follow-up queue',
  );
  assert.ok(alerts.some((item) => item.status === 'manual_pending'), 'manual_pending alert should be emitted');
  assert.equal(bugReports.length, 0, 'persisted payment timeout must not create an automatic failure report');

  console.log('✅ pickko payment-timeout registration-pending smoke ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
