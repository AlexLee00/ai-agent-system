'use strict';

const assert = require('assert');
const { createPickkoSavePrecheckService } = require('../lib/pickko-save-precheck-service.ts');

async function main() {
  const previous = process.env.PICKKO_SAVE_PRECHECK_STEP_TIMEOUT_MS;

  const service = createPickkoSavePrecheckService({
    log: () => {},
    buildStageError: (code, message) => Object.assign(new Error(message), { stageCode: code }),
  });

  let fieldLookupCount = 0;
  const alignedPage = {
    evaluate: async () => ({
      startDate: '2026-07-09',
      startTime: '11:00',
      endDate: '2026-07-09',
      endTime: '11:55',
    }),
    $: async () => {
      fieldLookupCount += 1;
      return null;
    },
  };

  const alignedResult = await service.alignExpectedTimes(alignedPage, {
    startDate: '2026-07-09',
    startTime: '11:00',
    endDate: '2026-07-09',
    endTime: '12:00',
  });
  assert.equal(fieldLookupCount, 0, 'already aligned fields should not be retyped through the browser');
  assert.equal(alignedResult.skipped, true);
  assert.equal(alignedResult.endTime, '11:55');

  process.env.PICKKO_SAVE_PRECHECK_STEP_TIMEOUT_MS = '1';

  const page = {
    evaluate: async () => new Promise(() => {}),
    $: async () => new Promise(() => {}),
  };

  let caught = null;
  try {
    await service.alignExpectedTimes(page, {
      startDate: '2026-07-09',
      startTime: '11:00',
      endDate: '2026-07-09',
      endTime: '12:00',
    });
  } catch (error) {
    caught = error;
  } finally {
    if (previous == null) delete process.env.PICKKO_SAVE_PRECHECK_STEP_TIMEOUT_MS;
    else process.env.PICKKO_SAVE_PRECHECK_STEP_TIMEOUT_MS = previous;
  }

  assert.ok(caught, 'hanging save precheck operation should fail fast');
  assert.equal(caught.stageCode, 'SAVE_PRECHECK_TIMEOUT');

  console.log('✅ pickko save-precheck timeout smoke ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
