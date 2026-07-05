// @ts-nocheck
'use strict';

const assert = require('assert');
const { createKioskPickkoCycleService } = require('../lib/kiosk-pickko-cycle-service.ts');

async function main() {
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

  console.log('kiosk_pickko_cycle_source_rule_smoke_ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
