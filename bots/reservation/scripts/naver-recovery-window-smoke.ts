// @ts-nocheck
'use strict';

const assert = require('assert');
const { createNaverPickkoRecoveryService } = require('../lib/naver-pickko-recovery-service.ts');

function createService(slotRows) {
  const calls = { updated: [], seen: [], alerts: [] };
  const service = createNaverPickkoRecoveryService({
    getReservation: async () => null,
    findReservationByCompositeKey: async () => null,
    findReservationBySlot: async () => null,
    getReservationsBySlot: async (_phone, _date, _start, _room, end) =>
      slotRows.filter((row) => !end || row.end === end || row.end_time === end),
    hideDuplicateReservationsForSlot: async () => 0,
    updateReservation: async (id, patch) => calls.updated.push({ id, patch }),
    markSeen: async (id) => calls.seen.push(id),
    buildReservationCompositeKey: (phone, date, start, end, room) => `${date}|${start}|${end}|${room}|${phone}`,
    chooseCanonicalReservationIdForSlot: (rows, fallbackId) => rows[0]?.id || fallbackId,
    resolveAlertsByBooking: async () => {},
    sendAlert: async (payload) => calls.alerts.push(payload),
    ragSaveReservation: async () => {},
    maskPhone: (phone) => String(phone).replace(/(\\d{3})\\d+(\\d{4})/, '$1****$2'),
    toKst: () => '2026-06-04 00:00:00',
    log: () => {},
  });
  return { service, calls };
}

async function main() {
  const booking = {
    phone: ['010', '0000', '0000'].join('-'),
    phoneRaw: ['010', '0000', '0000'].join(''),
    date: '2026-06-06',
    start: '16:00',
    end: '18:00',
    room: 'A2',
  };

  const differentWindow = createService([
    { id: 'old-1h', status: 'completed', pickkoStatus: 'manual', end: '17:00', room: 'A2' },
  ]);
  const recoveredFromDifferentWindow = await differentWindow.service.verifyRecoverablePickkoFailure(
    'new-2h',
    booking,
    'ALREADY_REGISTERED',
    'PICKKO_FAILURE_STAGE=ALREADY_REGISTERED',
  );
  assert.strictEqual(recoveredFromDifferentWindow, false, 'different end_time must not recover as same slot');
  assert.strictEqual(differentWindow.calls.updated.length, 0, 'different window must not mark completed');

  const sameWindow = createService([
    { id: 'peer-2h', status: 'completed', pickkoStatus: 'manual', end: '18:00', room: 'A2' },
  ]);
  const recoveredFromSameWindow = await sameWindow.service.verifyRecoverablePickkoFailure(
    'new-2h',
    booking,
    'ALREADY_REGISTERED',
    'PICKKO_FAILURE_STAGE=ALREADY_REGISTERED',
  );
  assert.strictEqual(recoveredFromSameWindow, true, 'same end_time may recover as same slot');
  assert.strictEqual(sameWindow.calls.updated.length, 1, 'same window should mark completed');

  console.log('✅ naver recovery window smoke ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
