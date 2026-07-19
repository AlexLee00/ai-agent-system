// @ts-nocheck
'use strict';

const assert = require('assert');
const { createNaverCandidateService } = require('../lib/naver-candidate-service.ts');
const { createNaverBookingStateService } = require('../lib/naver-booking-state-service.ts');

function booking(overrides = {}) {
  return {
    bookingId: overrides.bookingId || '1280000000',
    phone: overrides.phone || 'test-phone',
    phoneRaw: overrides.phoneRaw || '0000000000',
    date: overrides.date || '2099-01-02',
    start: overrides.start || '10:00',
    end: overrides.end || '11:00',
    room: overrides.room || 'A1',
    raw: { name: overrides.name || '테스트' },
  };
}

function createHarness(existingRows = {}) {
  const logs = [];
  const updated = [];
  const alerts = [];
  const rag = [];
  const pickkoRuns = [];
  const seen = [];
  const removedCancelKeys = [];
  const rows = new Map(Object.entries(existingRows));

  const service = createNaverCandidateService({
    log: (message) => logs.push(String(message)),
    fillMissingBookingDate: (item) => item,
    buildMonitoringTrackingKey: (item) => item.bookingId || `${item.phoneRaw}-${item.date}-${item.start}`,
    buildSlotCompositeKey: (item) => `${item.date}|${item.start}|${item.end}|${item.room}|${item.phoneRaw}`,
    getReservation: async (id) => rows.get(id) || null,
    findReservationByCompositeKey: async () => null,
    findReservationBySlot: async () => null,
    isSeenId: async (id) => {
      const row = rows.get(id);
      return !!row && !!(row.markedSeen || row.seenOnly);
    },
    markSeen: async (id) => seen.push(id),
    resolveAlertsByBooking: async () => {},
    updateBookingState: async (id, item, state = 'pending') => {
      updated.push({ id, item, state });
      const existing = rows.get(id) || {};
      const next = { ...existing, ...item, id, status: state, markedSeen: false, seenOnly: false };
      rows.set(id, next);
      return next;
    },
    sendAlert: async (payload) => alerts.push(payload),
    ragSaveReservation: async (item, status) => rag.push({ item, status }),
    runPickko: async (item, id) => {
      pickkoRuns.push({ item, id });
      return 0;
    },
    buildReservationId: (phoneRaw, date, start) => `${phoneRaw}-${date}-${start}`,
    buildCancelKey: (item) => `cancel|${item.date}|${item.start}|${item.end}|${item.room}|${item.phoneRaw}`,
    removeCancelledKey: async (key) => removedCancelKeys.push(key),
    formatVipBadge: async () => '',
    maskPhone: (phone) => String(phone || '').replace(/(\d{3})\d+(\d{4})/, '$1****$2'),
    mode: 'ops',
    naverUrl: 'https://example.test/naver',
  });

  const page = {
    goto: async () => {},
    waitForNetworkIdle: async () => {},
  };

  return { service, page, logs, updated, alerts, rag, pickkoRuns, seen, removedCancelKeys };
}

async function verifyReactivationStateReset() {
  let current = {
    id: 'reactivated-state',
    status: 'cancelled',
    pickkoStatus: 'cancelled',
    errorReason: 'past cancellation',
    retries: 5,
    markedSeen: true,
    seenOnly: true,
  };
  const patches = [];
  const service = createNaverBookingStateService({
    log: () => {},
    maskPhone: (phone) => phone,
    toKst: () => '2099-01-01 00:00:00',
    getReservation: async () => current,
    addReservation: async () => {},
    updateReservation: async (_id, patch) => {
      patches.push(patch);
      current = { ...current, ...patch };
    },
    rollbackProcessing: async () => 0,
    buildReservationCompositeKey: () => 'composite',
    storeReservationEvent: async () => {},
    rag: null,
  });

  await service.updateBookingState(current.id, booking(), 'pending');
  assert.deepEqual(patches, [{
    status: 'pending',
    pickkoStatus: null,
    pickkoOrderId: null,
    errorReason: null,
    retries: 0,
    pickkoStartTime: null,
    pickkoCompleteTime: null,
    markedSeen: false,
    seenOnly: false,
  }], 'cancelled rows must clear stale terminal and retry markers when reactivated');

  current = { id: 'ordinary-retry', status: 'failed', retries: 2, markedSeen: false, seenOnly: false };
  patches.length = 0;
  await service.updateBookingState(current.id, booking(), 'pending');
  assert.deepEqual(patches, [{ status: 'pending' }], 'ordinary failed retries must preserve their retry history');
}

async function main() {
  await verifyReactivationStateReset();

  const restored = booking({ bookingId: 'restored-live-confirmed' });
  const restoredHarness = createHarness({
    [restored.bookingId]: {
      id: restored.bookingId,
      status: 'cancelled',
      pickkoStatus: 'manual',
      markedSeen: true,
      seenOnly: false,
      end: restored.end,
      room: restored.room,
    },
  });

  await restoredHarness.service.processConfirmedCandidates({
    newest: [restored],
    page: restoredHarness.page,
  });

  assert.equal(restoredHarness.updated.length, 1, 'cancelled live-confirmed row must be reactivated');
  assert.equal(restoredHarness.updated[0].state, 'pending');
  assert.equal(restoredHarness.pickkoRuns.length, 1, 'reactivated row must run Pickko registration');
  assert.deepEqual(restoredHarness.seen, [restored.bookingId], 'successful reactivation must mark seen after Pickko');
  assert.ok(
    restoredHarness.removedCancelKeys.some((key) => key.includes(restored.bookingId)),
    'reactivation must clear stale cancelid key',
  );

  const completed = booking({ bookingId: 'already-completed' });
  const completedHarness = createHarness({
    [completed.bookingId]: {
      id: completed.bookingId,
      status: 'completed',
      pickkoStatus: 'paid',
      markedSeen: true,
      seenOnly: false,
      end: completed.end,
      room: completed.room,
    },
  });

  await completedHarness.service.processConfirmedCandidates({
    newest: [completed],
    page: completedHarness.page,
  });

  assert.equal(completedHarness.updated.length, 0, 'completed seen row must stay skipped');
  assert.equal(completedHarness.pickkoRuns.length, 0, 'completed seen row must not rerun Pickko');

  const elapsed = booking({ bookingId: 'already-time-elapsed' });
  const elapsedHarness = createHarness({
    [elapsed.bookingId]: {
      id: elapsed.bookingId,
      status: 'completed',
      pickkoStatus: 'time_elapsed',
      markedSeen: true,
      seenOnly: false,
      end: elapsed.end,
      room: elapsed.room,
    },
  });

  await elapsedHarness.service.processConfirmedCandidates({
    newest: [elapsed],
    page: elapsedHarness.page,
  });

  assert.equal(elapsedHarness.updated.length, 0, 'time_elapsed seen row must stay terminal');
  assert.equal(elapsedHarness.pickkoRuns.length, 0, 'time_elapsed seen row must not rerun Pickko');

  console.log('naver_candidate_reactivation_smoke_ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
