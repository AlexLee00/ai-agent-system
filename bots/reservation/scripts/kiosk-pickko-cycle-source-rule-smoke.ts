// @ts-nocheck
'use strict';

const assert = require('assert');
const { createKioskPickkoCycleService } = require('../lib/kiosk-pickko-cycle-service.ts');

async function runSourceClassificationKeepsZeroAmount() {
  const fetchCalls = [];
  const logs = [];
  const service = createKioskPickkoCycleService({
    log: (message) => logs.push(String(message)),
    delay: async () => {},
    loginToPickko: async () => {},
    fetchPickkoEntries: async (_page, date, options = {}) => {
      fetchCalls.push({ date, options });
      if (options.statusKeyword === '취소' || options.statusKeyword === '환불') {
        return { entries: [], fetchOk: true };
      }
      return {
        entries: [
          {
            name: '0원 결제완료',
            phoneRaw: '01011112222',
            date: '2026-07-10',
            start: '10:00',
            end: '10:50',
            room: '스터디룸A1',
            amount: 0,
            statusText: '결제완료',
          },
        ],
        fetchOk: true,
      };
    },
    getKioskBlock: async () => {
      throw new Error('kiosk_blocks must not be used before Naver source classification');
    },
    compareEntrySequence: () => 0,
    maskName: (value) => value,
    maskPhone: (value) => value,
  });

  const result = await service.preparePickkoCycle({
    page: { url: () => 'https://pickkoadmin.test/study/index.html' },
    today: '2026-07-05',
    pickkoId: 'id',
    pickkoPw: 'pw',
  });

  assert.equal(result.toBlockEntries.length, 1, 'amount=0 paid Pickko candidate must remain eligible until Naver classification');
  assert.equal(result.toBlockEntries[0].amount, 0);
  assert.ok(
    fetchCalls.length >= 3,
    'paid, cancelled, and refunded Pickko queries should be executed',
  );
  assert.ok(
    fetchCalls.every((call) => call.options.minAmount !== 1),
    'Pickko source collection must not use minAmount=1',
  );

  return { fetchCalls, logs, result };
}

async function runReceiptFastScanSkipsPaidDateFallback() {
  const fetchCalls = [];
  const logs = [];
  const service = createKioskPickkoCycleService({
    log: (message) => logs.push(String(message)),
    delay: async () => {},
    loginToPickko: async () => {},
    fetchPickkoEntries: async (_page, date, options = {}) => {
      fetchCalls.push({ date, options });
      if (options.sortBy === 'sd_regdate') {
        return {
          entries: [
            {
              name: '최신접수',
              phoneRaw: '01080055830',
              date: '2026-07-06',
              start: '16:00',
              end: '17:50',
              room: '스터디룸A2',
              amount: 14000,
              statusText: '결제완료',
              receiptText: '2026-07-06 15:56:00',
            },
          ],
          fetchOk: true,
        };
      }
      if (options.statusKeyword === '취소' || options.statusKeyword === '환불') {
        return { entries: [], fetchOk: true };
      }
      if (options.statusKeyword === '결제완료' && options.endDate === date) {
        return {
          entries: [
            {
              name: '오늘이용',
              phoneRaw: '01062290586',
              date: '2026-07-06',
              start: '18:30',
              end: '20:50',
              room: '스터디룸B',
              amount: 0,
              statusText: '결제완료',
            },
            {
              name: '범위밖',
              phoneRaw: '01058948656',
              date: '2026-07-05',
              start: '22:00',
              end: '23:20',
              room: '스터디룸A2',
              amount: 10500,
              statusText: '결제완료',
            },
          ],
          fetchOk: true,
        };
      }
      return {
        entries: Array.from({ length: 20 }, (_unused, index) => ({
          name: `범위${index}`,
          phoneRaw: `0101111${String(index).padStart(4, '0')}`,
          date: '2026-08-05',
          start: '10:00',
          end: '10:50',
          room: '스터디룸A1',
          amount: 0,
          statusText: '결제완료',
        })),
        fetchOk: true,
      };
    },
    getKioskBlock: async () => {
      throw new Error('kiosk_blocks must not be used before Naver source classification');
    },
    compareEntrySequence: () => 0,
    maskName: (value) => value,
    maskPhone: (value) => value,
  });

  const result = await service.preparePickkoCycle({
    page: { url: () => 'https://pickkoadmin.test/study/index.html' },
    today: '2026-07-06',
    pickkoId: 'id',
    pickkoPw: 'pw',
  });

  assert.ok(
    result.toBlockEntries.some((entry) => entry.phoneRaw === '01080055830' && entry.date === '2026-07-06'),
    'receipt fast-scan entry must be merged into block candidates',
  );
  assert.ok(
    result.toBlockEntries.some((entry) => entry.phoneRaw === '01062290586' && entry.date === '2026-07-06'),
    'same-day paid scan must catch today-use entries missed by the range first page',
  );
  assert.ok(
    !result.toBlockEntries.some((entry) => entry.phoneRaw === '01058948656' && entry.date === '2026-07-05'),
    'same-day paid scan must ignore rows outside the requested use date',
  );
  assert.ok(
    fetchCalls.some((call) => call.options.sortBy === 'sd_regdate' && call.options.receiptDate === '2026-07-06'),
    'receipt fast-scan should run before the long paid range fallback',
  );
  assert.ok(
    fetchCalls.some((call) => (
      call.options.statusKeyword === '결제완료'
        && call.options.endDate === '2026-07-06'
        && call.date === '2026-07-06'
    )),
    'same-day paid scan should run before deciding whether to skip the long date fallback',
  );
  assert.equal(
    fetchCalls.filter((call) => (
      call.options.statusKeyword === '결제완료'
        && call.options.endDate === call.date
        && call.date !== '2026-07-06'
    )).length,
    0,
    'paid date-by-date fallback should be skipped when receipt fast-scan is enabled',
  );
  assert.ok(
    logs.some((line) => line.includes('접수일시 최신순 fast-scan')),
    'fast-scan log should be visible for operation review',
  );

  return { fetchCalls, logs, result };
}

async function runDisabledReceiptFastScanPreservesPaidDateFallback() {
  const previous = process.env.KIOSK_PICKKO_RECEIPT_FAST_SCAN_ENABLED;
  process.env.KIOSK_PICKKO_RECEIPT_FAST_SCAN_ENABLED = '0';
  const fetchCalls = [];
  try {
    const service = createKioskPickkoCycleService({
      log: () => {},
      delay: async () => {},
      loginToPickko: async () => {},
      fetchPickkoEntries: async (_page, date, options = {}) => {
        fetchCalls.push({ date, options });
        if (options.statusKeyword === '취소' || options.statusKeyword === '환불') {
          return { entries: [], fetchOk: true };
        }
        return {
          entries: Array.from({ length: 20 }, (_unused, index) => ({
            name: `범위${index}`,
            phoneRaw: `0102222${String(index).padStart(4, '0')}`,
            date,
            start: '10:00',
            end: '10:50',
            room: '스터디룸A1',
            amount: 0,
            statusText: '결제완료',
          })),
          fetchOk: true,
        };
      },
      getKioskBlock: async () => null,
      compareEntrySequence: () => 0,
      maskName: (value) => value,
      maskPhone: (value) => value,
    });

    await service.preparePickkoCycle({
      page: { url: () => 'https://pickkoadmin.test/study/index.html' },
      today: '2026-07-06',
      pickkoId: 'id',
      pickkoPw: 'pw',
    });

    assert.ok(
      fetchCalls.some((call) => (
        call.options.statusKeyword === '결제완료'
          && call.options.endDate === call.date
          && call.date !== '2026-07-06'
      )),
      'disabling receipt fast-scan must preserve the previous paid date fallback behavior',
    );
  } finally {
    if (previous == null) delete process.env.KIOSK_PICKKO_RECEIPT_FAST_SCAN_ENABLED;
    else process.env.KIOSK_PICKKO_RECEIPT_FAST_SCAN_ENABLED = previous;
  }
}

async function runReceiptFastScanFailureFallsBack() {
  const fetchCalls = [];
  const logs = [];
  const service = createKioskPickkoCycleService({
    log: (message) => logs.push(String(message)),
    delay: async () => {},
    loginToPickko: async () => {},
    fetchPickkoEntries: async (_page, date, options = {}) => {
      fetchCalls.push({ date, options });
      if (options.sortBy === 'sd_regdate') {
        throw new Error('receipt scan timeout');
      }
      if (options.statusKeyword === '취소' || options.statusKeyword === '환불') {
        return { entries: [], fetchOk: true };
      }
      return {
        entries: Array.from({ length: 20 }, (_unused, index) => ({
          name: `범위${index}`,
          phoneRaw: `0103333${String(index).padStart(4, '0')}`,
          date,
          start: '10:00',
          end: '10:50',
          room: '스터디룸A1',
          amount: 0,
          statusText: '결제완료',
        })),
        fetchOk: true,
      };
    },
    getKioskBlock: async () => null,
    compareEntrySequence: () => 0,
    maskName: (value) => value,
    maskPhone: (value) => value,
  });

  await service.preparePickkoCycle({
    page: { url: () => 'https://pickkoadmin.test/study/index.html' },
    today: '2026-07-06',
    pickkoId: 'id',
    pickkoPw: 'pw',
  });

  assert.ok(
    logs.some((line) => line.includes('기존 결제완료 날짜별 fallback으로 전환')),
    'receipt fast-scan failures should be visible in logs',
  );
  assert.ok(
    fetchCalls.some((call) => (
      call.options.statusKeyword === '결제완료'
        && call.options.endDate === call.date
        && call.date !== '2026-07-06'
    )),
    'receipt fast-scan failure must fall back to the previous paid date fallback',
  );
}

async function main() {
  const sourceRule = await runSourceClassificationKeepsZeroAmount();
  assert.equal(sourceRule.result.toBlockEntries.length, 1, 'baseline source rule scenario should still pass');

  await runReceiptFastScanSkipsPaidDateFallback();
  await runDisabledReceiptFastScanPreservesPaidDateFallback();
  await runReceiptFastScanFailureFallsBack();

  console.log('kiosk_pickko_cycle_source_rule_smoke_ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
