// @ts-nocheck
'use strict';

const assert = require('assert');
const { createNaverCancelDetectionService } = require('../lib/naver-cancel-detection-service.ts');

function booking(overrides = {}) {
  return {
    bookingId: Object.prototype.hasOwnProperty.call(overrides, 'bookingId') ? overrides.bookingId : 'scope-guard-booking',
    phoneRaw: overrides.phoneRaw || '01012345678',
    phone: overrides.phone || overrides.phoneRaw || '01012345678',
    date: overrides.date || '2099-01-02',
    start: overrides.start || '10:00',
    end: overrides.end || '11:00',
    room: overrides.room || 'A1',
  };
}

function createService({ cancelTabList = [], tracked = true, cancelledKeys = [] }) {
  const logs = [];
  const addedKeys = [];
  const pickkoCancels = [];
  const cancelledKeySet = new Set(cancelledKeys);

  const service = createNaverCancelDetectionService({
    delay: async () => {},
    log: (message) => logs.push(String(message)),
    maskPhone: (phone) => String(phone || '').replace(/(\d{3})\d+(\d{4})/, '$1****$2'),
    buildCancelKey: (item) => `cancelid|${item.bookingId}`,
    buildConfirmedListKey: (item) => `${item.date}|${item.start}|${item.end}|${item.room}|${item.phoneRaw || item.phone}`,
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
    scrapeNewestBookingsFromList: async () => cancelTabList,
    scrapeExpandedCancelled: async () => {
      throw new Error('legacy_expanded_cancel_must_not_run');
    },
  });

  return { service, logs, addedKeys, pickkoCancels };
}

function createPage() {
  return {
    goto: async () => {},
    waitForSelector: async () => {},
  };
}

async function main() {
  const todaySeoul = '2099-01-01';
  const future = booking({ bookingId: 'future-cancel', date: '2099-01-02' });

  const cancelTab = createService({ cancelTabList: [future] });
  const cancelTabResult = await cancelTab.service.processCancelTab({
    page: createPage(),
    cancelledHref: 'https://example.test/cancelled',
    bizId: 'biz',
    todaySeoul,
    naverUrl: 'https://example.test/naver',
    cycleNewCancelDetections: 0,
    currentConfirmedList: [],
  });

  assert.equal(cancelTabResult.cycleNewCancelDetections, 0, 'future cancel-tab rows must not count as handled');
  assert.deepEqual(cancelTab.pickkoCancels, [], 'future cancel-tab rows must not call Pickko cancel');
  assert.deepEqual(cancelTab.addedKeys, [], 'future cancel-tab rows must not be recorded as cancelled');
  assert.ok(
    cancelTab.logs.some((line) => line.includes('[취소탭] 오늘자 외 취소 후보 자동 처리 차단')),
    'future cancel-tab rows should log the date scope guard',
  );

  const today = booking({ bookingId: 'today-cancel', date: todaySeoul });
  const sameDay = createService({ cancelTabList: [today] });
  const sameDayResult = await sameDay.service.processCancelTab({
    page: createPage(),
    cancelledHref: 'https://example.test/cancelled',
    bizId: 'biz',
    todaySeoul,
    naverUrl: 'https://example.test/naver',
    cycleNewCancelDetections: 0,
    currentConfirmedList: [],
  });

  assert.equal(sameDayResult.cycleNewCancelDetections, 1, 'same-day cancel tab rows should still be handled');
  assert.equal(sameDay.pickkoCancels.length, 1, 'same-day cancel tab rows should call Pickko cancel');
  assert.deepEqual(sameDay.addedKeys, ['cancelid|today-cancel']);

  const alive = createService({ cancelTabList: [today] });
  const aliveResult = await alive.service.processCancelTab({
    page: createPage(),
    cancelledHref: 'https://example.test/cancelled',
    bizId: 'biz',
    todaySeoul,
    naverUrl: 'https://example.test/naver',
    cycleNewCancelDetections: 0,
    currentConfirmedList: [today],
  });
  assert.equal(aliveResult.cycleNewCancelDetections, 0, 'same-day row still present in RC03 must not be cancelled');
  assert.deepEqual(alive.pickkoCancels, []);
  assert.ok(alive.logs.some((line) => line.includes('RC03 확정 생존')));

  const legacy = createService({ cancelTabList: [today] });
  const legacyResult = await legacy.service.processExpandedCancelled({
    page: createPage(),
    cancelledHref: 'https://example.test/cancelled',
    todaySeoul,
    naverUrl: 'https://example.test/naver',
    cycleNewCancelDetections: 0,
  });
  assert.equal(legacyResult, 0, 'legacy expanded cancel path must be disabled');
  assert.deepEqual(legacy.pickkoCancels, []);
  assert.ok(legacy.logs.some((line) => line.includes('legacy 확장 취소 경로 폐기')));

  console.log('✅ naver cancel date scope guard smoke ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
