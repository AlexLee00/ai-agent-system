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
      const mutationEnabled = process.env.PICKKO_CANCEL_MUTATION_ENABLE === '1'
        && process.env.SKA_ENABLE_PICKKO_CANCEL_MUTATION === '1';
      if (!mutationEnabled) {
        logs.push('자동 픽코 취소 실행 차단: PICKKO_CANCEL_MUTATION_ENABLE=1 및 SKA_ENABLE_PICKKO_CANCEL_MUTATION=1 필요');
        return 99;
      }
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
  const previousMutationFlag = process.env.SKA_ENABLE_PICKKO_CANCEL_MUTATION;
  const previousPickkoMutationFlag = process.env.PICKKO_CANCEL_MUTATION_ENABLE;
  delete process.env.SKA_ENABLE_PICKKO_CANCEL_MUTATION;
  delete process.env.PICKKO_CANCEL_MUTATION_ENABLE;

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

  const expandedBlocked = createService({ expandedList: [future] });
  const expandedBlockedResult = await expandedBlocked.service.processExpandedCancelled({
    page: createPage(),
    cancelledHref: 'https://example.test/cancelled',
    todaySeoul,
    naverUrl: 'https://example.test/naver',
    cycleNewCancelDetections: 0,
  });

  assert.equal(expandedBlockedResult, 0, 'tracked future expanded cancel rows must not count as handled by default');
  assert.deepEqual(expandedBlocked.pickkoCancels, [], 'tracked future expanded cancel rows must not call Pickko cancel by default');
  assert.deepEqual(expandedBlocked.addedKeys, [], 'tracked future expanded cancel rows must not be recorded by default');
  assert.ok(
    expandedBlocked.logs.some((line) => line.includes('자동 픽코 취소 실행 차단')),
    'tracked future expanded cancel rows should be blocked unless mutation is explicitly enabled',
  );

  process.env.SKA_ENABLE_PICKKO_CANCEL_MUTATION = '1';
  delete process.env.PICKKO_CANCEL_MUTATION_ENABLE;

  const expandedSkaOnly = createService({ expandedList: [future] });
  const expandedSkaOnlyResult = await expandedSkaOnly.service.processExpandedCancelled({
    page: createPage(),
    cancelledHref: 'https://example.test/cancelled',
    todaySeoul,
    naverUrl: 'https://example.test/naver',
    cycleNewCancelDetections: 0,
  });

  assert.equal(expandedSkaOnlyResult, 0, 'SKA-only approval must not run Pickko cancel');
  assert.deepEqual(expandedSkaOnly.pickkoCancels, [], 'SKA-only approval must remain blocked by the second gate');
  assert.ok(
    expandedSkaOnly.logs.some((line) => line.includes('PICKKO_CANCEL_MUTATION_ENABLE=1 및 SKA_ENABLE_PICKKO_CANCEL_MUTATION=1 필요')),
    'SKA-only approval should explain both required mutation flags',
  );

  process.env.SKA_ENABLE_PICKKO_CANCEL_MUTATION = '1';
  process.env.PICKKO_CANCEL_MUTATION_ENABLE = '1';

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

  if (previousMutationFlag === undefined) delete process.env.SKA_ENABLE_PICKKO_CANCEL_MUTATION;
  else process.env.SKA_ENABLE_PICKKO_CANCEL_MUTATION = previousMutationFlag;
  if (previousPickkoMutationFlag === undefined) delete process.env.PICKKO_CANCEL_MUTATION_ENABLE;
  else process.env.PICKKO_CANCEL_MUTATION_ENABLE = previousPickkoMutationFlag;
}

main().catch((error) => {
  delete process.env.SKA_ENABLE_PICKKO_CANCEL_MUTATION;
  delete process.env.PICKKO_CANCEL_MUTATION_ENABLE;
  console.error(error.stack || error.message || error);
  process.exit(1);
});
