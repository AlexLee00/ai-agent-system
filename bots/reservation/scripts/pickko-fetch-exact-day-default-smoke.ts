#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { fetchPickkoEntries } = require('../lib/pickko.ts');

function createFakePage() {
  const filterCalls = [];
  let functionEvaluateCalls = 0;

  return {
    __filterCalls: filterCalls,
    evaluateOnNewDocument: async () => {},
    goto: async () => {},
    click: async () => {},
    waitForNavigation: async () => null,
    evaluate: async (fn, ...args) => {
      if (typeof fn === 'string') return null;
      if (args.length === 5 && typeof args[1] === 'string') {
        filterCalls.push({
          startDate: args[0],
          endDate: args[1],
          statusKeyword: args[2],
          minAmount: args[3],
          sortBy: args[4],
        });
        return null;
      }

      functionEvaluateCalls += 1;
      if (functionEvaluateCalls === 1) {
        return {
          name: 6,
          phone: 7,
          room: 2,
          startTime: 3,
          endTime: -1,
          amount: 8,
          status: 9,
          receiptTime: 11,
          isCombined: true,
          headers: ['NO', '상태', '스터디룸', '이용일시', '이용시간', '인원', '이름', '연락처', '이용금액', '상태', '메모', '접수일시', '관리'],
        };
      }
      return [];
    },
  };
}

async function main() {
  const useDatePage = createFakePage();
  await fetchPickkoEntries(useDatePage, '2099-08-05', {
    statusKeyword: '결제완료',
    minAmount: 0,
  });

  assert.equal(useDatePage.__filterCalls.length, 1);
  assert.deepEqual(useDatePage.__filterCalls[0], {
    startDate: '2099-08-05',
    endDate: '2099-08-05',
    statusKeyword: '결제완료',
    minAmount: 0,
    sortBy: 'sd_start',
  });

  const receiptDatePage = createFakePage();
  await fetchPickkoEntries(receiptDatePage, '2099-08-05', {
    sortBy: 'sd_regdate',
    receiptDate: '2099-08-05',
    statusKeyword: '',
  });

  assert.equal(receiptDatePage.__filterCalls.length, 1);
  assert.deepEqual(receiptDatePage.__filterCalls[0], {
    startDate: '2099-08-05',
    endDate: '',
    statusKeyword: '',
    minAmount: 0,
    sortBy: 'sd_regdate',
  });

  console.log('pickko_fetch_exact_day_default_smoke_ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
