// @ts-nocheck
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createNaverPickkoRunnerService } = require('../lib/naver-pickko-runner-service.ts');
const { buildPickkoBookingIncidentKey } = require('../lib/naver-pickko-runner-helpers.ts');

function booking(overrides = {}) {
  return {
    phone: overrides.phone || 'test-phone',
    phoneRaw: overrides.phoneRaw || '0000000000',
    date: overrides.date || '2099-01-02',
    start: overrides.start || '10:00',
    end: overrides.end || '11:00',
    room: overrides.room || 'A1',
    raw: { name: overrides.name || '테스트' },
  };
}

function createChild(exitCode = 0) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 999999;
  child.kill = () => {};
  process.nextTick(() => child.emit('close', exitCode));
  return child;
}

function createHarness(currentEntry) {
  const logs = [];
  const updates = [];
  const patches = [];
  const seen = [];
  const spawns = [];
  const publishedAlerts = [];
  const service = createNaverPickkoRunnerService({
    isCancelledKey: async () => false,
    getReservation: async () => currentEntry,
    markSeen: async (id) => seen.push(id),
    resolveAlertsByBooking: async () => {},
    updateBookingState: async (id, item, state) => {
      updates.push({ id, state, item });
      currentEntry = { ...currentEntry, id, status: state };
      return currentEntry;
    },
    updateReservation: async (id, patch) => {
      patches.push({ id, patch });
      currentEntry = { ...currentEntry, ...patch };
    },
    addCancelledKey: async () => {},
    sendAlert: async () => {},
    ragSaveReservation: async () => {},
    publishReservationAlert: async (payload) => { publishedAlerts.push(payload); },
    autoBugReport: () => {},
    transformAndNormalizeData: (item) => item,
    verifyRecoverablePickkoFailure: async () => false,
    reconcileSlotDuplicatesAfterRecovery: async () => {},
    buildPickkoCancelArgs: () => [],
    buildPickkoAccurateArgs: () => ['fake-accurate.js'],
    buildPickkoCancelManualMessage: () => '',
    buildPickkoRetryExceededMessage: () => '',
    buildPickkoTimeElapsedMessage: () => '',
    buildPickkoManualFailureMessage: () => '',
    maskPhone: (phone) => String(phone || '').replace(/(\d{3})\d+(\d{4})/, '$1****$2'),
    toKst: () => '2099-01-01 00:00:00',
    log: (message) => logs.push(String(message)),
    spawnImpl: (command, args) => {
      spawns.push({ command, args });
      return createChild(0);
    },
  });
  return { service, logs, updates, patches, seen, spawns, publishedAlerts };
}

async function main() {
  const restored = createHarness({
    id: 'restored-live-confirmed',
    status: 'pending',
    pickkoStatus: 'manual',
    retries: 0,
  });
  const restoredCode = await restored.service.runPickko({
    booking: booking(),
    bookingId: 'restored-live-confirmed',
    scriptsDir: '/tmp',
    accurateScriptPath: '/tmp/fake-accurate.js',
    maxRetries: 3,
  });
  assert.equal(restoredCode, 0);
  assert.equal(restored.spawns.length, 1, 'pending/manual reactivation must verify through Pickko instead of skipping');
  assert.ok(restored.updates.some((entry) => entry.state === 'processing'));
  assert.ok(restored.updates.some((entry) => entry.state === 'completed'));

  const completed = createHarness({
    id: 'already-completed',
    status: 'completed',
    pickkoStatus: 'manual',
    retries: 0,
  });
  const completedCode = await completed.service.runPickko({
    booking: booking(),
    bookingId: 'already-completed',
    scriptsDir: '/tmp',
    accurateScriptPath: '/tmp/fake-accurate.js',
    maxRetries: 3,
  });
  assert.equal(completedCode, 0);
  assert.equal(completed.spawns.length, 0, 'completed/manual row must remain skipped');
  assert.deepEqual(completed.seen, ['already-completed']);

  const retryExceeded = createHarness({
    id: 'retry-exceeded-booking',
    status: 'failed',
    pickkoStatus: null,
    retries: 5,
  });
  const retryBooking = booking({
    date: '2099-07-22',
    start: '15:00',
    end: '16:30',
    room: 'A1',
  });
  const retryCode = await retryExceeded.service.runPickko({
    booking: retryBooking,
    bookingId: 'retry-exceeded-booking',
    scriptsDir: '/tmp',
    accurateScriptPath: '/tmp/fake-accurate.js',
    maxRetries: 5,
  });
  assert.equal(retryCode, 99);
  assert.equal(retryExceeded.spawns.length, 0, 'retry-exceeded booking must not spawn another registration');
  assert.equal(retryExceeded.publishedAlerts.length, 1);
  assert.equal(
    retryExceeded.publishedAlerts[0].incident_key,
    buildPickkoBookingIncidentKey('pickko_retry_exceeded', retryBooking, 'retry-exceeded-booking'),
    'retry-exceeded alarm must use a booking-specific incident key',
  );
  assert.equal(retryExceeded.publishedAlerts[0].dedupe_minutes, 1440);
  assert.notEqual(
    buildPickkoBookingIncidentKey('pickko_retry_exceeded', retryBooking, 'retry-exceeded-booking'),
    buildPickkoBookingIncidentKey('pickko_retry_exceeded', { ...retryBooking, date: '2099-07-23' }, 'another-booking'),
    'different bookings must not collapse into one incident lifecycle',
  );

  console.log('naver_pickko_runner_reactivation_smoke_ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
