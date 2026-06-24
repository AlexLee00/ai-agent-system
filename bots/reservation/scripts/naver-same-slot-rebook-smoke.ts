// @ts-nocheck
'use strict';

const assert = require('assert');
const { createNaverBookingStateService } = require('../lib/naver-booking-state-service.ts');
const { createNaverCandidateService } = require('../lib/naver-candidate-service.ts');

async function main() {
  const logs = [];
  const removedKeys = [];
  const alerts = [];
  const stateUpdates = [];
  const pickkoRuns = [];
  const seen = new Set();

  const existingId = 'naver-booking-id-1';
  const rebookId = `${existingId}:rebook:${existingId}`;
  const existing = {
    id: existingId,
    phone: '999-0000-0001',
    phoneRaw: '99900000001',
    date: '2026-06-24',
    start: '10:00',
    end: '11:30',
    room: 'A2',
    status: 'cancelled',
    pickkoStatus: 'cancelled',
    markedSeen: true,
    seenOnly: false,
  };
  const rows = new Map([[existing.id, existing]]);

  const booking = {
    raw: { name: '오정은' },
    phone: '999-0000-0001',
    phoneRaw: '99900000001',
    date: '2026-06-24',
    start: '10:00',
    end: '11:30',
    room: 'A2',
  };

  const service = createNaverCandidateService({
    log: (message) => logs.push(String(message)),
    fillMissingBookingDate: (item) => item,
    buildMonitoringTrackingKey: () => existing.id,
    buildSlotCompositeKey: () => '99900000001|2026-06-24|10:00|11:30|A2',
    getReservation: async (id) => rows.get(id) || null,
    findReservationByCompositeKey: async () => null,
    findReservationBySlot: async () => null,
    isSeenId: async () => true,
    markSeen: async (id) => { seen.add(id); },
    resolveAlertsByBooking: async () => {},
    updateBookingState: async (bookingId, payload, state) => {
      stateUpdates.push({ bookingId, state, payload });
      const next = {
        ...(rows.get(bookingId) || {}),
        id: bookingId,
        phone: payload.phone,
        phoneRaw: payload.phoneRaw,
        date: payload.date,
        start: payload.start,
        end: payload.end,
        room: payload.room,
        status: state,
        pickkoStatus: null,
        markedSeen: false,
        seenOnly: false,
      };
      rows.set(bookingId, next);
      return next;
    },
    sendAlert: async (payload) => { alerts.push(payload); },
    ragSaveReservation: async () => {},
    runPickko: async (payload, bookingId) => {
      pickkoRuns.push({ payload, bookingId });
      return 0;
    },
    buildReservationId: (phoneRaw, date, start) => `${phoneRaw}-${date}-${start}`,
    buildCancelKey: (payload) => {
      const phoneRaw = String(payload.phoneRaw || payload.phone || '').replace(/\D/g, '');
      return `cancel_blocked|${phoneRaw}|${payload.date}|${payload.start}|${payload.end || ''}|${payload.room || ''}`;
    },
    removeCancelledKey: async (key) => { removedKeys.push(key); },
    formatVipBadge: async () => '',
    maskPhone: (phone) => String(phone || '').replace(/(\d{3})\d+(\d{4})/, '$1****$2'),
    mode: 'ops',
    naverUrl: 'https://example.invalid/naver',
  });

  const page = {
    goto: async () => {},
    waitForNetworkIdle: async () => {},
  };

  await service.processConfirmedCandidates({ newest: [booking], page });

  assert.strictEqual(stateUpdates.length, 1, 'same-slot rebook should create a new row even when old cancelled row is marked seen');
  assert.strictEqual(stateUpdates[0].bookingId, rebookId);
  assert.strictEqual(stateUpdates[0].state, 'pending');
  assert.strictEqual(pickkoRuns.length, 1, 'same-slot rebook must be sent to Pickko again');
  assert.strictEqual(pickkoRuns[0].bookingId, rebookId);
  assert.ok(seen.has(rebookId), 'successful same-slot rebook registration should mark only the new row seen');
  assert.ok(removedKeys.includes('cancel_blocked|99900000001|2026-06-24|10:00|11:30|A2'));
  assert.ok(removedKeys.includes('cancel_done|99900000001|2026-06-24|10:00|11:30|A2'));
  assert.ok(removedKeys.includes(`cancelid|${existing.id}`));
  assert.ok(removedKeys.includes(`cancelid|${rebookId}`));
  assert.ok(alerts.some((alert) => String(alert.title).includes('동일 슬롯 신규 예약')));
  assert.ok(logs.some((line) => line.includes('동일슬롯 재예약')));

  rows.set(rebookId, {
    ...rows.get(rebookId),
    status: 'completed',
    pickkoStatus: 'paid',
    markedSeen: true,
    seenOnly: false,
  });
  const pickkoRunsAfterFirstScan = pickkoRuns.length;
  await service.processConfirmedCandidates({ newest: [booking], page });
  assert.strictEqual(
    pickkoRuns.length,
    pickkoRunsAfterFirstScan,
    'completed same-slot rebook row must suppress repeated Pickko registration on later scans',
  );

  const updatePatches = [];
  const stateService = createNaverBookingStateService({
    log: () => {},
    maskPhone: (phone) => String(phone || ''),
    toKst: () => '2026-06-24 11:00:00',
    getReservation: async () => ({
      id: existing.id,
      status: 'cancelled',
      pickkoStatus: 'cancelled',
      markedSeen: true,
      seenOnly: false,
      retries: 0,
    }),
    addReservation: async () => {},
    updateReservation: async (id, patch) => { updatePatches.push({ id, patch }); },
    rollbackProcessing: async () => 0,
    buildReservationCompositeKey: () => 'composite',
    storeReservationEvent: async () => {},
    rag: {},
  });

  await stateService.updateBookingState(existing.id, booking, 'pending');
  assert.strictEqual(updatePatches.length, 1);
  assert.deepStrictEqual(updatePatches[0].patch, {
    status: 'pending',
    pickkoStatus: null,
    errorReason: null,
    markedSeen: 0,
    seenOnly: 0,
  });

  console.log('✅ naver same-slot rebook smoke ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
