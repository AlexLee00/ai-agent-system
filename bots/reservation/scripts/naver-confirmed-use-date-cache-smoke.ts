'use strict';

const assert = require('assert');
const { createNaverConfirmedCycleService } = require('../lib/naver-confirmed-cycle-service.ts');

async function main() {
  const gotoUrls = [];
  const saved = [];
  let processConfirmedCalled = false;
  let processedNewest = null;

  const page = {
    confirmedCount: 0,
    currentUrl: 'https://new.smartplace.naver.com/bizes/place/596871',
    async evaluate(fn) {
      return {
        confirmedHref: 'https://partner.booking.naver.com/bizes/596871/booking-list-view?dateFilter=REGDATE&bookingStatusCodes=RC03',
        cancelledHref: null,
        confirmedCount: this.confirmedCount,
        cancelledCount: 0,
      };
    },
    async goto(url) {
      this.currentUrl = url;
      gotoUrls.push(url);
    },
    async waitForNetworkIdle() {},
    async waitForSelector() {},
    async waitForFunction() {},
    url() {
      return this.currentUrl;
    },
  };

  const service = createNaverConfirmedCycleService({
    delay: async () => {},
    log: () => {},
    saveJson: (file, data) => saved.push({ file, data }),
    scrapeNewestBookingsFromList: async (pg) => (
      pg.currentUrl.includes('dateFilter=USEDATE')
        ? [{ bookingId: 'use-date-booking', phone: 'masked-phone', date: '2026-07-10', start: '09:00', end: '10:00', room: 'A1' }]
        : [{ bookingId: 'reg-date-booking' }]
    ),
    processConfirmedCandidates: async ({ newest }) => {
      processConfirmedCalled = true;
      processedNewest = newest;
    },
  });

  const result = await service.processConfirmedCycle({
    page,
    naverUrl: 'https://new.smartplace.naver.com/bizes/place/596871',
    workspace: '/tmp/reservation-smoke',
  });

  const useDateUrl = gotoUrls.find((url) => url.includes('dateFilter=USEDATE'));
  assert.ok(useDateUrl, 'today use-date confirmed list should be fetched even when today-confirmed counter is zero');
  assert.ok(useDateUrl.includes('bookingStatusCodes=RC03'));

  const useDateSave = saved.find((item) => item.file.endsWith('/naver-bookings-use-date-full.json'));
  assert.ok(useDateSave, 'today use-date snapshot should be saved separately from registration-date cache');
  assert.equal(useDateSave.data[0].bookingId, 'use-date-booking');

  assert.equal(processConfirmedCalled, false, 'zero today-confirmed counter should not trigger new booking processing');
  assert.deepStrictEqual(result.currentConfirmedList, []);

  page.confirmedCount = 1;
  const resultWithConfirmed = await service.processConfirmedCycle({
    page,
    naverUrl: 'https://new.smartplace.naver.com/bizes/place/596871',
    workspace: '/tmp/reservation-smoke',
  });

  assert.equal(processConfirmedCalled, true);
  assert.equal(processedNewest[0].bookingId, 'reg-date-booking');
  assert.equal(resultWithConfirmed.currentConfirmedList[0].bookingId, 'reg-date-booking');

  const deleted = [];
  const failingPage = {
    confirmedCount: 0,
    async evaluate() {
      return {
        confirmedHref: 'https://partner.booking.naver.com/bizes/596871/booking-list-view?dateFilter=REGDATE&bookingStatusCodes=RC03',
        cancelledHref: null,
        confirmedCount: this.confirmedCount,
        cancelledCount: 0,
      };
    },
    async goto(url) {
      if (url.includes('dateFilter=USEDATE')) throw new Error('naver use-date fetch failed');
    },
    async waitForNetworkIdle() {},
  };
  const failureService = createNaverConfirmedCycleService({
    delay: async () => {},
    log: () => {},
    saveJson: () => {
      throw new Error('stale cache must not be overwritten on fetch failure');
    },
    deleteFile: (file) => deleted.push(file),
    scrapeNewestBookingsFromList: async () => [{ bookingId: 'unexpected' }],
    processConfirmedCandidates: async () => {
      throw new Error('zero counter should not process confirmed candidates');
    },
  });

  const failureResult = await failureService.processConfirmedCycle({
    page: failingPage,
    naverUrl: 'https://new.smartplace.naver.com/bizes/place/596871',
    workspace: '/tmp/reservation-smoke',
  });
  assert.equal(deleted.length, 1, 'failed use-date refresh should invalidate stale same-day cache');
  assert.ok(deleted[0].endsWith('/naver-bookings-use-date-full.json'));
  assert.deepStrictEqual(failureResult.currentConfirmedList, []);

  console.log('✅ naver confirmed use-date cache smoke ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
