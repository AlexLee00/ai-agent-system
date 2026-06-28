import * as assert from 'assert';
import { createNaverFutureCancelService } from '../lib/naver-future-cancel-service';

async function runScenario(futureStaleCancelMutationEnabled: boolean, verifiedCancelled: boolean) {
  const logs: string[] = [];
  const gotos: string[] = [];
  const upserts: any[] = [];
  const cancels: any[] = [];
  const cancelledKeys: string[] = [];
  const pendingCancelMap = new Map<string, any>();
  const stale = {
    booking_key: '1270000000',
    phone_raw: '01012345678',
    date: '2099-01-02',
    start_time: '10:00',
    end_time: '11:00',
    room: 'A1',
  };
  const cancelKey = `cancelid|${stale.booking_key}`;

  pendingCancelMap.set(cancelKey, {
    source: 'future_stale',
    booking: {
      phoneRaw: stale.phone_raw,
      phone: stale.phone_raw,
      date: stale.date,
      start: stale.start_time,
      end: stale.end_time,
      room: stale.room,
      bookingId: stale.booking_key,
    },
    stale,
    firstDetectedAt: Date.now() - 20 * 60 * 1000,
    count: 4,
  });

  const service = createNaverFutureCancelService({
    delay: async () => {},
    log: (message) => logs.push(message),
    maskPhone: (phone) => `${phone.slice(0, 3)}****${phone.slice(-4)}`,
    isCancelledKey: async (key) => cancelledKeys.includes(key),
    addCancelledKey: async (key) => cancelledKeys.push(key),
    buildCancelKey: (booking) => `cancelid|${booking.bookingId || booking.booking_id}`,
    upsertFutureConfirmed: async (...args) => upserts.push(args),
    getStaleConfirmed: async () => [stale],
    deleteStaleConfirmed: async () => {},
    pruneOldFutureConfirmed: async () => {},
    runPickkoCancel: async (booking, key) => {
      cancels.push({ booking, key });
      return 0;
    },
    scrapeNewestBookingsFromList: async () => [
      {
        bookingId: '1279999999',
        phoneRaw: '01099999999',
        date: '2099-01-03',
        start: '12:00',
        end: '13:00',
        room: 'A2',
      },
    ],
    scrapeExpandedCancelled: async () => verifiedCancelled ? [
      {
        bookingId: stale.booking_key,
        phoneRaw: stale.phone_raw,
        date: stale.date,
        start: stale.start_time,
        end: stale.end_time,
        room: stale.room,
      },
    ] : [],
    runtimeConfig: {
      staleConfirmCount: 5,
      staleMinElapsedMs: 10 * 60 * 1000,
      staleExpireMs: 30 * 60 * 1000,
      futureStaleCancelMutationEnabled,
    },
  });

  await service.processFutureCancelSnapshot({
    checkCount: 5,
    cancelledHref: 'https://partner.booking.naver.com/bizes/596871/booking-list-view?countFilter=CANCELLED',
    page: {
      goto: async (url: string) => {
        gotos.push(url);
      },
    },
    todaySeoul: '2099-01-01',
    naverUrl: 'https://partner.booking.naver.com/bizes/596871/booking-list-view',
    pendingCancelMap,
    cycleNewCancelDetections: 0,
  });

  return { logs, gotos, upserts, cancels, cancelledKeys, pendingCancelMap };
}

async function main() {
  const guarded = await runScenario(false, true);
  assert.equal(guarded.cancels.length, 0, 'future stale guard must not call Pickko cancel by default');
  assert.equal(guarded.cancelledKeys.length, 0, 'guarded stale item must not be recorded as cancelled');
  assert.equal(guarded.pendingCancelMap.size, 0, 'guarded stale item should clear pending cancel state');
  assert.ok(
    guarded.logs.some((line) => line.includes('미래 stale만으로는 픽코 취소 실행 금지')),
    'guarded path should log the explicit stale cancel guard',
  );
  assert.ok(
    guarded.gotos.some((url) => url.includes('dateFilter=USEDATE')),
    'future snapshot must use usage-date filtering, not registration-date filtering',
  );
  assert.equal(
    guarded.gotos.some((url) => url.includes('dateFilter=REGDATE')),
    false,
    'future snapshot must not use registration-date filtering',
  );

  const unverified = await runScenario(true, false);
  assert.equal(unverified.cancels.length, 0, 'future stale must not cancel without expanded cancelled-tab verification');
  assert.equal(unverified.cancelledKeys.length, 0, 'unverified stale item must not be recorded as cancelled');
  assert.ok(
    unverified.logs.some((line) => line.includes('확장 취소 탭 미검증')),
    'unverified path should log cancelled-tab verification failure',
  );

  const verified = await runScenario(true, true);
  assert.equal(verified.cancels.length, 1, 'verified future stale should cancel only after expanded cancelled-tab match');
  assert.deepEqual(verified.cancelledKeys, ['cancelid|1270000000']);

  console.log('✅ naver-future-stale-cancel-guard-smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
