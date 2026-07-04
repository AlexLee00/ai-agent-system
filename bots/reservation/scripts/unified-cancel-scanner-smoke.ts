// @ts-nocheck
'use strict';

const assert = require('assert');
const {
  buildCancelledRangeUrl,
  dedupeCancelEvidence,
  compareCancelShadow,
  inspectCancelListSoft200,
} = require('../lib/unified-cancel-scanner.ts');

function createPage({ body = '', rows = 0, noData = false }) {
  return {
    evaluate: async (fn) => {
      const previous = global.document;
      const fakeRows = Array.from({ length: rows }, () => ({}));
      global.document = {
        body: { innerText: body, textContent: body },
        querySelectorAll: (selector) => selector.includes('contents-user') ? fakeRows : [],
        querySelector: (selector) => {
          if (selector.includes('nodata') && noData) return { offsetParent: {} };
          return null;
        },
      };
      try {
        return fn();
      } finally {
        global.document = previous;
      }
    },
  };
}

async function main() {
  const url = buildCancelledRangeUrl('https://new.smartplace.naver.com/bizes/place/3990161/booking-list-view?status=CANCELLED&date=2026-07-03', {
    startDate: '2026-07-03',
    endDate: '2026-09-01',
  });
  assert.ok(url.includes('status=CANCELLED'));
  assert.ok(!url.includes('bookingStatusCodes=RC03'));
  assert.ok(url.includes('dateDropdownType=RANGE'));
  assert.ok(url.includes('dateFilter=USEDATE'));
  assert.ok(url.includes('startDateTime=2026-07-03'));
  assert.ok(url.includes('endDateTime=2026-09-01'));

  const countFilterUrl = buildCancelledRangeUrl('https://partner.booking.naver.com/bizes/596871/booking-list-view?countFilter=CANCELLED', {
    startDate: '2026-07-03',
    endDate: '2026-09-01',
  });
  assert.ok(countFilterUrl.includes('countFilter=CANCELLED'));
  assert.ok(!countFilterUrl.includes('bookingStatusCodes=RC03'));

  assert.deepStrictEqual(
    await inspectCancelListSoft200(createPage({ rows: 2 })),
    { ok: true, rows: 2, noData: false },
  );
  assert.equal((await inspectCancelListSoft200(createPage({ body: '로그인 후 이용하세요' }))).reason, 'login_required');
  assert.equal((await inspectCancelListSoft200(createPage({ noData: true }))).ok, true);

  const rows = [
    { bookingId: '1', phone: '01012345678', date: '2026-07-03', start: '10:00', end: '11:00', room: 'A1' },
    { bookingId: '1', phone: '01012345678', date: '2026-07-03', start: '10:00', end: '11:00', room: 'A1' },
    { bookingId: '2', phone: '01022223333', date: '2026-07-10', start: '12:00', end: '13:00', room: 'B' },
  ];
  const evidence = await dedupeCancelEvidence(rows, {
    buildCancelKey: (booking) => `cancelid|${booking.bookingId}`,
    todaySeoul: '2026-07-03',
    findTrackedReservation: async (booking) => booking.bookingId === '1' ? { id: '1' } : null,
  });
  assert.equal(evidence.length, 2);
  assert.equal(evidence[0].tracked, true);
  assert.equal(evidence[1].tracked, false);

  const diff = compareCancelShadow({
    today: '2026-07-03',
    unified: evidence,
    legacy: [evidence[0]],
  });
  assert.equal(diff.ok, true, 'future-only discovery must not fail today shadow');
  assert.equal(diff.counts.futureUnifiedOnly, 1);
  assert.equal(diff.futureUnifiedOnly[0].cancelKey, 'cancelid|2');

  const badDiff = compareCancelShadow({
    today: '2026-07-03',
    unified: [evidence[0]],
    legacy: [{ ...evidence[0], cancelKey: 'cancelid|legacy-only' }],
  });
  assert.equal(badDiff.ok, false);
  assert.equal(badDiff.counts.todayMissingInLegacy, 1);
  assert.equal(badDiff.counts.todayMissingInUnified, 1);

  console.log(JSON.stringify({ ok: true, tests: ['url', 'soft200', 'dedupe', 'shadow-diff'] }));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
