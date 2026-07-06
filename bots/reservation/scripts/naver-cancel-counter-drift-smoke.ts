// @ts-nocheck
'use strict';

const assert = require('assert');
const { createNaverCancelDetectionService } = require('../lib/naver-cancel-detection-service.ts');

async function main() {
  const logs = [];
  const addedKeys = [];
  const pickkoCancels = [];

  const service = createNaverCancelDetectionService({
    delay: async () => {},
    log: (message) => logs.push(String(message)),
    maskPhone: (phone) => String(phone || '').replace(/(\d{3})\d+(\d{4})/, '$1****$2'),
    buildCancelKey: (booking) => booking.bookingId ? `cancelid|${booking.bookingId}` : `cancel|${booking.date}|${booking.start}`,
    isCancelledKey: async () => false,
    addCancelledKey: async (key) => addedKeys.push(key),
    shouldProcessCancelledBooking: async () => false,
    runPickkoCancel: async (booking, key) => pickkoCancels.push({ booking, key }),
    scrapeNewestBookingsFromList: async () => [{
      bookingId: '1242881854',
      phoneRaw: '01000000000',
      date: '2026-05-22',
      start: '10:00',
      end: '11:00',
      room: 'A1',
    }],
  });

  const page = {
    goto: async () => {},
    waitForSelector: async () => {},
  };

  const result = await service.processCancelTab({
    page,
    cancelledHref: 'https://example.test/cancelled',
    bizId: 'biz',
    todaySeoul: '2026-05-22',
    naverUrl: 'https://example.test/naver',
    cycleNewCancelDetections: 0,
  });

  assert.strictEqual(result.cycleNewCancelDetections, 1);
  assert.deepStrictEqual(addedKeys, ['cancelid|1242881854']);
  assert.deepStrictEqual(pickkoCancels, []);
  assert.ok(logs.some((line) => line.includes('미추적 취소건 키 등록 후 픽코 취소 스킵')));

  console.log('✅ naver cancel counter drift smoke ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
