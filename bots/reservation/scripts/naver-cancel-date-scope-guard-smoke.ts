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

function createService({ cancelTabList = [], expandedList = [], tracked = true, cancelledKeys = [] }) {
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
    scrapeExpandedCancelled: async () => expandedList,
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
  });

  assert.equal(cancelTabResult.cycleNewCancelDetections, 0, 'future cancel-tab rows must not count as handled');
  assert.deepEqual(cancelTab.pickkoCancels, [], 'future cancel-tab rows must not call Pickko cancel');
  assert.deepEqual(cancelTab.addedKeys, [], 'future cancel-tab rows must not be recorded as cancelled');
  assert.ok(
    cancelTab.logs.some((line) => line.includes('[취소탭] 오늘자 외 취소 후보 자동 처리 차단')),
    'future cancel-tab rows should log the date scope guard',
  );

  const expanded = createService({ expandedList: [future] });
  const expandedResult = await expanded.service.processExpandedCancelled({
    page: createPage(),
    cancelledHref: 'https://example.test/cancelled',
    todaySeoul,
    naverUrl: 'https://example.test/naver',
    cycleNewCancelDetections: 0,
  });

  assert.equal(expandedResult, 1, 'tracked future expanded cancel rows should count as handled');
  assert.equal(expanded.pickkoCancels.length, 1, 'tracked future expanded cancel rows should call Pickko cancel');
  assert.deepEqual(expanded.addedKeys, ['cancelid|future-cancel']);
  assert.ok(
    expanded.logs.some((line) => line.includes('미래 직접 취소 예외 처리')),
    'tracked future expanded cancel rows should log the direct-detect exception',
  );

  const untrackedFuture = createService({ expandedList: [future], tracked: null });
  const untrackedFutureResult = await untrackedFuture.service.processExpandedCancelled({
    page: createPage(),
    cancelledHref: 'https://example.test/cancelled',
    todaySeoul,
    naverUrl: 'https://example.test/naver',
    cycleNewCancelDetections: 0,
  });

  assert.equal(untrackedFutureResult, 0, 'untracked future expanded cancel rows must not count as handled');
  assert.deepEqual(untrackedFuture.pickkoCancels, [], 'untracked future expanded cancel rows must not call Pickko cancel');
  assert.deepEqual(untrackedFuture.addedKeys, [], 'untracked future expanded cancel rows must not be recorded as cancelled');
  assert.ok(
    untrackedFuture.logs.some((line) => line.includes('[취소감지2E] 오늘자 외 취소 후보 자동 처리 차단')),
    'untracked future expanded cancel rows should remain blocked by the date scope guard',
  );

  const today = booking({ bookingId: 'today-cancel', date: todaySeoul });
  const sameDay = createService({ expandedList: [today] });
  const sameDayResult = await sameDay.service.processExpandedCancelled({
    page: createPage(),
    cancelledHref: 'https://example.test/cancelled',
    todaySeoul,
    naverUrl: 'https://example.test/naver',
    cycleNewCancelDetections: 0,
  });

  assert.equal(sameDayResult, 1, 'same-day expanded cancel rows should still be handled');
  assert.equal(sameDay.pickkoCancels.length, 1, 'same-day expanded cancel rows should call Pickko cancel');
  assert.deepEqual(sameDay.addedKeys, ['cancelid|today-cancel']);

  const staleKeyCandidate = booking({ bookingId: 'stale-key-active', date: todaySeoul });
  const staleKey = createService({
    expandedList: [staleKeyCandidate],
    cancelledKeys: ['cancelid|stale-key-active'],
    tracked: { id: 'stale-key-active', status: 'completed', pickkoStatus: 'manual_retry' },
  });
  const staleKeyResult = await staleKey.service.processExpandedCancelled({
    page: createPage(),
    cancelledHref: 'https://example.test/cancelled',
    todaySeoul,
    naverUrl: 'https://example.test/naver',
    cycleNewCancelDetections: 0,
  });

  assert.equal(staleKeyResult, 1, 'stale cancel keys on active DB rows should still be handled');
  assert.equal(staleKey.pickkoCancels.length, 1, 'stale cancel keys on active DB rows should call Pickko cancel');
  assert.ok(
    staleKey.logs.some((line) => line.includes('stale 취소키 감지')),
    'stale cancel-key rows should be logged',
  );

  const alreadyCancelled = createService({
    expandedList: [booking({ bookingId: 'already-cancelled', date: todaySeoul })],
    cancelledKeys: ['cancelid|already-cancelled'],
    tracked: { id: 'already-cancelled', status: 'cancelled', pickkoStatus: 'manual' },
  });
  const alreadyCancelledResult = await alreadyCancelled.service.processExpandedCancelled({
    page: createPage(),
    cancelledHref: 'https://example.test/cancelled',
    todaySeoul,
    naverUrl: 'https://example.test/naver',
    cycleNewCancelDetections: 0,
  });

  assert.equal(alreadyCancelledResult, 0, 'recorded keys on already-cancelled rows should remain skipped');
  assert.deepEqual(alreadyCancelled.pickkoCancels, [], 'already-cancelled rows should not call Pickko cancel again');

  const trackedBySlot = createService({
    expandedList: [booking({ bookingId: null, date: todaySeoul })],
    tracked: { id: 'tracked-by-slot', status: 'completed', pickkoStatus: 'manual_retry' },
  });
  await trackedBySlot.service.processExpandedCancelled({
    page: createPage(),
    cancelledHref: 'https://example.test/cancelled',
    todaySeoul,
    naverUrl: 'https://example.test/naver',
    cycleNewCancelDetections: 0,
  });

  assert.equal(
    trackedBySlot.pickkoCancels[0].booking.bookingId,
    'tracked-by-slot',
    'slot/composite matched rows should inject tracked bookingId before Pickko cancel',
  );

  console.log('✅ naver cancel date scope guard smoke ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
