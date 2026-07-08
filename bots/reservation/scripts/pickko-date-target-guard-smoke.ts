'use strict';

const assert = require('assert');
const { createPickkoDateService } = require('../lib/pickko-date-service.ts');

function createService(logs) {
  return createPickkoDateService({
    delay: async () => {},
    log: (message) => logs.push(String(message)),
    sendErrorNotification: async () => {},
    buildStageError: (code, message) => {
      const error = new Error(message);
      error.stageCode = code;
      return error;
    },
  });
}

async function main() {
  const logs = [];
  const service = createService(logs);
  const calls = [];
  const page = {
    evaluate: async (_fn, arg) => {
      calls.push(arg || null);
      if (calls.length === 1) return '2026-07-08';
      if (calls.length === 2) return '2026-07-08';
      if (calls.length === 3) return { ok: true, value: arg };
      if (calls.length === 4) return undefined;
      if (calls.length === 5) return true;
      if (calls.length === 6) return '2026-07-09';
      throw new Error(`unexpected evaluate call ${calls.length}`);
    },
  };

  await service.setAndVerifyDate(page, { date: '2026-07-09' });

  assert.ok(calls.length > 2, 'same current page date must not skip when target date differs');
  assert.ok(logs.some((line) => line.includes('날짜가 다릅니다')), 'date conversion should run');

  console.log('✅ pickko date target guard smoke ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
