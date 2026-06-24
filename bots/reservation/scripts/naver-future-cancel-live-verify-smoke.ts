// @ts-nocheck
'use strict';

const assert = require('assert');
const { createNaverFutureCancelService } = require('../lib/naver-future-cancel-service.ts');

const STALE = {
  booking_key: '1261342670',
  phone_raw: '99900000001',
  date: '2026-07-24',
  start_time: '10:00',
  end_time: '11:30',
  room: 'A2',
};

const MATCHING_BOOKING = {
  bookingId: '1261342670',
  phoneRaw: '99900000001',
  date: '2026-07-24',
  start: '10:00',
  end: '11:30',
  room: 'A2',
};

function createHarness({ confirmedLiveList, cancelledLiveList }) {
  const logs = [];
  const gotos = [];
  const pickkoCancels = [];
  const futureUpserts = [];
  const cancelledKeys = [];
  const scrapeResponses = [
    [
      {
        bookingId: 'future-still-confirmed-other',
        phoneRaw: '99900000002',
      date: '2026-07-25',
        start: '10:00',
        end: '11:00',
        room: 'A1',
      },
    ],
    confirmedLiveList,
    cancelledLiveList,
  ];

  const page = {
    goto: async (url) => {
      gotos.push(String(url));
    },
  };

  const pendingCancelMap = new Map([
    [
      'cancelid|1261342670',
      {
        source: 'future_stale',
        booking: MATCHING_BOOKING,
        stale: STALE,
        firstDetectedAt: Date.now() - 11 * 60 * 1000,
        count: 4,
      },
    ],
  ]);

  const service = createNaverFutureCancelService({
    delay: async () => {},
    log: (message) => logs.push(String(message)),
    maskPhone: (phone) => String(phone || '').replace(/(\d{3})\d+(\d{4})/, '$1****$2'),
    isCancelledKey: async () => false,
    addCancelledKey: async (key) => {
      cancelledKeys.push(key);
    },
    upsertFutureConfirmed: async (...args) => {
      futureUpserts.push(args);
    },
    getStaleConfirmed: async () => [STALE],
    deleteStaleConfirmed: async () => {},
    pruneOldFutureConfirmed: async () => {},
    runPickkoCancel: async (booking, key) => {
      pickkoCancels.push({ booking, key });
      return 0;
    },
    scrapeNewestBookingsFromList: async () => {
      assert.ok(scrapeResponses.length > 0, 'unexpected extra scrape call');
      return scrapeResponses.shift();
    },
    runtimeConfig: {
      staleConfirmCount: 5,
      staleMinElapsedMs: 10 * 60 * 1000,
      staleExpireMs: 30 * 60 * 1000,
    },
  });

  return {
    logs,
    gotos,
    pickkoCancels,
    futureUpserts,
    cancelledKeys,
    pendingCancelMap,
    service,
    page,
  };
}

async function runFutureSnapshot(harness) {
  return harness.service.processFutureCancelSnapshot({
    checkCount: 10,
    cancelledHref: 'https://example.test/booking-list-view?status=CANCELLED&date=2026-06-24',
    page: harness.page,
    todaySeoul: '2026-06-24',
    naverUrl: 'https://example.test/naver-home',
    pendingCancelMap: harness.pendingCancelMap,
    cycleNewCancelDetections: 0,
  });
}

async function main() {
  const stillConfirmed = createHarness({
    confirmedLiveList: [MATCHING_BOOKING],
    cancelledLiveList: [],
  });
  const stillConfirmedCount = await runFutureSnapshot(stillConfirmed);

  assert.strictEqual(stillConfirmedCount, 0);
  assert.strictEqual(stillConfirmed.pickkoCancels.length, 0, 'stale future cancel must not cancel Pickko while Naver still confirms it');
  assert.ok(stillConfirmed.gotos.some((url) => url.includes('status=CONFIRMED') && url.includes('date=2026-07-24')));
  assert.ok(stillConfirmed.gotos.some((url) => url.includes('naver-home')));
  assert.ok(stillConfirmed.logs.some((line) => line.includes('live 검증 차단(still_confirmed)')));
  assert.ok(stillConfirmed.futureUpserts.some((args) => args[0] === STALE.booking_key));
  assert.strictEqual(stillConfirmed.cancelledKeys.length, 0);

  const cancelledInNaver = createHarness({
    confirmedLiveList: [],
    cancelledLiveList: [MATCHING_BOOKING],
  });
  const cancelledCount = await runFutureSnapshot(cancelledInNaver);

  assert.strictEqual(cancelledCount, 1);
  assert.strictEqual(cancelledInNaver.pickkoCancels.length, 1, 'Pickko cancel should run only after Naver cancel tab live match');
  assert.ok(cancelledInNaver.gotos.some((url) => url.includes('status=CONFIRMED') && url.includes('date=2026-07-24')));
  assert.ok(cancelledInNaver.gotos.some((url) => url.includes('status=CANCELLED') && url.includes('date=2026-07-24')));
  assert.ok(cancelledInNaver.logs.some((line) => line.includes('네이버 취소 탭 live 검증 통과')));
  assert.deepStrictEqual(cancelledInNaver.cancelledKeys, ['cancelid|1261342670']);

  console.log('✅ naver future cancel live verify smoke ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
