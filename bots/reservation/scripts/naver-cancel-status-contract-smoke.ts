// @ts-nocheck
'use strict';

const assert = require('assert');
const { createNaverCancelDetectionService } = require('../lib/naver-cancel-detection-service.ts');
const { buildBookingStatusListUrl } = require('../lib/naver-list-scrape-service.ts');

function booking(overrides = {}) {
  return {
    bookingId: overrides.bookingId || '1280000000',
    phoneRaw: overrides.phoneRaw || '01012345678',
    phone: overrides.phone || overrides.phoneRaw || '01012345678',
    date: overrides.date || '2099-01-02',
    start: overrides.start || '10:00',
    end: overrides.end || '11:00',
    room: overrides.room || 'A1',
    raw: overrides.raw || { name: overrides.name || '테스트' },
  };
}

function createPage() {
  return {
    goto: async () => {},
    waitForSelector: async () => {},
  };
}

function createService({
  cancelledRows = [],
  confirmedRows = [],
  tracked = { id: '1280000000', status: 'completed', pickkoStatus: 'paid' },
  cancelledKeys = [],
} = {}) {
  const logs = [];
  const addedKeys = [];
  const pickkoCancels = [];
  const cancelledKeySet = new Set(cancelledKeys);
  const service = createNaverCancelDetectionService({
    delay: async () => {},
    log: (message) => logs.push(String(message)),
    maskPhone: (phone) => String(phone || '').replace(/(\d{3})\d+(\d{4})/, '$1****$2'),
    buildCancelKey: (item) => `cancelid|${item.bookingId}`,
    isCancelledKey: async (key) => cancelledKeySet.has(key),
    addCancelledKey: async (key) => {
      cancelledKeySet.add(key);
      addedKeys.push(key);
    },
    shouldProcessCancelledBooking: async () => tracked,
    runPickkoCancel: async (item, key) => {
      pickkoCancels.push({ booking: item, key });
      return 0;
    },
    scrapeNewestBookingsFromList: async () => cancelledRows,
    scrapeCancelledStatusList: async () => cancelledRows,
    scrapeConfirmedStatusList: async () => confirmedRows,
  });
  return { service, logs, addedKeys, pickkoCancels };
}

async function main() {
  const statusUrl = buildBookingStatusListUrl(
    'https://partner.booking.naver.com/bizes/596871/booking-list-view?countFilter=CANCELLED',
    {
      statusCode: 'RC04',
      startDate: '2026-07-06',
      endDate: '2026-08-05',
      dateDropdownType: 'MONTH',
    },
  );
  assert.ok(statusUrl.includes('bookingStatusCodes=RC04'));
  assert.ok(statusUrl.includes('dateFilter=USEDATE'));
  assert.ok(!statusUrl.includes('countFilter=CANCELLED'));
  assert.ok(!statusUrl.includes('status=CANCELLED'));

  const calendarStatusUrl = buildBookingStatusListUrl(
    'https://partner.booking.naver.com/bizes/596871/booking-calendar-view',
    { statusCode: 'RC03', startDate: '2099-01-01', endDate: '2099-01-31' },
  );
  assert.equal(
    new URL(calendarStatusUrl).pathname,
    '/bizes/596871/booking-list-view',
    'calendar source URL must normalize to the list endpoint, not a nested calendar/list path',
  );

  const cancelled = booking({ bookingId: 'cancelled-but-alive' });
  const aliveGate = createService({
    cancelledRows: [cancelled],
    confirmedRows: [cancelled],
  });
  const aliveResult = await aliveGate.service.processStatusCancelledList({
    page: createPage(),
    cancelledHref: 'https://partner.booking.naver.com/bizes/596871/booking-list-view?countFilter=CANCELLED',
    todaySeoul: '2099-01-01',
    naverUrl: 'https://example.test/naver',
    cycleNewCancelDetections: 0,
  });
  assert.equal(aliveResult.cycleNewCancelDetections, 0, 'RC03 alive booking must not be cancelled');
  assert.deepEqual(aliveGate.pickkoCancels, []);
  assert.ok(aliveGate.logs.some((line) => line.includes('RC03 확정 생존')));

  const cancelledOnly = booking({ bookingId: 'cancelled-only' });
  const actionable = createService({
    cancelledRows: [cancelledOnly],
    confirmedRows: [],
    tracked: { id: 'cancelled-only', status: 'completed', pickkoStatus: 'paid' },
  });
  const actionableResult = await actionable.service.processStatusCancelledList({
    page: createPage(),
    cancelledHref: 'https://partner.booking.naver.com/bizes/596871/booking-list-view?countFilter=CANCELLED',
    todaySeoul: '2099-01-01',
    naverUrl: 'https://example.test/naver',
    cycleNewCancelDetections: 0,
  });
  assert.equal(actionableResult.cycleNewCancelDetections, 1, 'RC04-only tracked booking should be cancelled');
  assert.deepEqual(actionable.addedKeys, ['cancelid|cancelled-only']);
  assert.equal(actionable.pickkoCancels.length, 1);

  assert.deepEqual(Object.keys(actionable.service).sort(), [
    'processCancelTab',
    'processStatusCancelledList',
    'reconcileDroppedConfirmed',
  ].sort());

  const legacy = createService({ cancelledRows: [booking({ bookingId: 'legacy' })] });
  const dropped = await legacy.service.reconcileDroppedConfirmed({
    previousConfirmedList: [booking({ bookingId: 'dropped' })],
    currentConfirmedList: [],
    currentCancelledList: [booking({ bookingId: 'dropped' })],
    todaySeoul: '2099-01-01',
    confirmedCount: 1,
    pendingCancelMap: new Map(),
    cycleNewCancelDetections: 0,
  });
  assert.equal(dropped, 0, 'legacy confirmed-drop path must be disabled');
  assert.deepEqual(legacy.pickkoCancels, []);

  console.log('✅ naver cancel status contract smoke ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
