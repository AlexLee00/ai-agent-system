// @ts-nocheck
'use strict';

const assert = require('assert');
const {
  createNaverListScrapeService,
  parseNaverDateTimeText,
} = require('../lib/naver-list-scrape-service.ts');

function fakeText(text) {
  return { textContent: text };
}

function fakeRow({ malformed = false } = {}) {
  return {
    href: 'https://partner.booking.naver.com/bizes/596871/booking-list-view/bookings/1280609777',
    textContent: '확정이도원000-0000-00001280609777오전 9:00~10:30A1룸',
    querySelector(selector) {
      if (malformed) return null;
      if (selector.includes('name__')) return fakeText('이도원');
      if (selector.includes('phone__')) return fakeText('000-0000-0000');
      if (selector.includes('book-date__')) return fakeText('오전 9:00~10:30');
      if (selector.includes('host__')) return fakeText('A1룸 (2인 최적, 최대 4인)');
      if (selector.includes('book-number__')) return fakeText('1280609777');
      return null;
    },
  };
}

function createFakePage({ dateFilter = 'USEDATE', delayedRows = false, emptyState = false, reloadNeverReady = false, malformedRows = false } = {}) {
  let ready = !delayedRows;
  return {
    goto: async () => { ready = !delayedRows; },
    reload: async () => { if (!reloadNeverReady) ready = true; },
    waitForFunction: async () => {},
    evaluate: async (fn, arg) => {
      const previousDocument = global.document;
      const previousLocation = global.location;
      global.location = {
        href: `https://partner.booking.naver.com/bizes/596871/booking-list-view?countFilter=CONFIRMED&bookingStatusCodes=RC03&dateDropdownType=TODAY&startDateTime=2026-07-04&endDateTime=2026-07-04&dateFilter=${dateFilter}`,
      };
      global.document = {
        querySelector(selector) {
          if (selector.includes('nodata')) return emptyState ? { offsetParent: {} } : null;
          return null;
        },
        querySelectorAll(selector) {
          if (selector.includes('contents-user')) return ready && !emptyState ? [fakeRow({ malformed: malformedRows })] : [];
          return [];
        },
      };
      try {
        return fn(arg);
      } finally {
        global.document = previousDocument;
        global.location = previousLocation;
      }
    },
  };
}

async function main() {
  assert.deepStrictEqual(
    parseNaverDateTimeText('오전 9:00~10:30', '2026-07-04'),
    { date: '2026-07-04', start: '09:00', end: '10:30' },
  );

  const service = createNaverListScrapeService({ delay: async () => {}, log: () => {} });
  const rows = await service.scrapeNewestBookingsFromList(createFakePage(), 10);

  assert.equal(rows.length, 1);
  assert.deepStrictEqual(rows[0], {
    bookingId: '1280609777',
    phone: '000-0000-0000',
    phoneRaw: '00000000000',
    date: '2026-07-04',
    start: '09:00',
    end: '10:30',
    room: 'A1',
    raw: {
      name: '이도원',
      dateTimeText: '오전 9:00~10:30',
      hostText: 'A1룸 (2인 최적, 최대 4인)',
      phoneText: '000-0000-0000',
    },
  });

  const cancelDateRows = await service.scrapeNewestBookingsFromList(createFakePage({ dateFilter: 'CANCELDATE' }), 10);
  assert.equal(
    cancelDateRows.length,
    0,
    'CANCELDATE pages must not use the cancel date as the reservation date when row text omits the use date',
  );

  const delayedRows = await service.scrapeConfirmedStatusList(
    createFakePage({ delayedRows: true }),
    'https://partner.booking.naver.com/bizes/596871/booking-calendar-view',
    { startDate: '2026-07-04', endDate: '2026-07-04', limit: 10 },
  );
  assert.equal(delayedRows.length, 1, 'a transient zero-row page should be retried before parsing');

  const emptyRows = await service.scrapeConfirmedStatusList(
    createFakePage({ emptyState: true }),
    'https://partner.booking.naver.com/bizes/596871/booking-calendar-view',
    { startDate: '2026-07-04', endDate: '2026-07-04', limit: 10 },
  );
  assert.deepStrictEqual(emptyRows, [], 'an explicit empty state is a valid zero-row result');

  await assert.rejects(
    service.scrapeConfirmedStatusList(
      createFakePage({ delayedRows: true, emptyState: false, reloadNeverReady: true }),
      'https://partner.booking.naver.com/bizes/596871/booking-calendar-view',
      { startDate: '2026-07-04', endDate: '2026-07-04', limit: 10 },
    ),
    /NAVER_LIST_NOT_READY/,
    'an empty DOM without explicit nodata must fail closed',
  );

  await assert.rejects(
    service.scrapeNewestBookingsFromList(createFakePage({ malformedRows: true }), 10),
    /NAVER_LIST_PARSE_EMPTY/,
    'raw rows with no parseable fields must fail closed',
  );

  console.log('✅ naver list scrape DOM smoke ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
