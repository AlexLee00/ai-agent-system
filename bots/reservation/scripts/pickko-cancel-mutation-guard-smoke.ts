// @ts-nocheck
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const {
  createNaverPickkoRunnerService,
  PICKKO_CANCEL_BLOCKED_CODE,
} = require('../lib/naver-pickko-runner-service.ts');

async function main() {
  const previous = process.env.PICKKO_CANCEL_MUTATION_ENABLE;
  delete process.env.PICKKO_CANCEL_MUTATION_ENABLE;

  const logs = [];
  const alerts = [];
  const published = [];
  const cancelledKeys = new Set();
  let spawnCount = 0;

  const service = createNaverPickkoRunnerService({
    isCancelledKey: async (key) => cancelledKeys.has(key),
    getReservation: async () => null,
    markSeen: async () => {},
    resolveAlertsByBooking: async () => {},
    updateBookingState: async () => {},
    updateReservation: async () => {},
    addCancelledKey: async (key) => { cancelledKeys.add(key); },
    sendAlert: async (payload) => { alerts.push(payload); },
    ragSaveReservation: async () => {},
    publishReservationAlert: async (payload) => { published.push(payload); },
    autoBugReport: () => {},
    transformAndNormalizeData: (booking) => booking,
    verifyRecoverablePickkoFailure: async () => false,
    reconcileSlotDuplicatesAfterRecovery: async () => {},
    buildPickkoCancelArgs: () => ['cancel.js'],
    buildPickkoAccurateArgs: () => ['accurate.js'],
    buildPickkoCancelManualMessage: () => 'manual cancel',
    buildPickkoRetryExceededMessage: () => 'retry exceeded',
    buildPickkoTimeElapsedMessage: () => 'time elapsed',
    buildPickkoManualFailureMessage: () => 'manual failure',
    maskPhone: (phone) => String(phone || '').replace(/(\d{3})\d+(\d{4})/, '$1****$2'),
    toKst: () => '2026-06-07',
    log: (message) => logs.push(String(message)),
    spawnImpl: () => {
      spawnCount += 1;
      if (process.env.PICKKO_CANCEL_MUTATION_ENABLE !== '1') {
        throw new Error('spawn must not run while mutation guard is disabled');
      }
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      process.nextTick(() => child.emit('close', 0));
      return child;
    },
  });

  const booking = {
    phone: '01012345678',
    date: '2026-06-21',
    start: '15:00',
    end: '18:00',
    room: 'A1',
  };
  const result = await service.runPickkoCancel({
    booking,
    scriptsDir: __dirname,
    manualCancelScriptPath: '/tmp/pickko-cancel.js',
  });
  const secondResult = await service.runPickkoCancel({
    booking,
    scriptsDir: __dirname,
    manualCancelScriptPath: '/tmp/pickko-cancel.js',
  });
  process.env.PICKKO_CANCEL_MUTATION_ENABLE = '1';
  const thirdResult = await service.runPickkoCancel({
    booking,
    scriptsDir: __dirname,
    manualCancelScriptPath: '/tmp/pickko-cancel.js',
  });

  if (previous === undefined) delete process.env.PICKKO_CANCEL_MUTATION_ENABLE;
  else process.env.PICKKO_CANCEL_MUTATION_ENABLE = previous;

  assert.strictEqual(result, PICKKO_CANCEL_BLOCKED_CODE);
  assert.strictEqual(secondResult, PICKKO_CANCEL_BLOCKED_CODE);
  assert.strictEqual(thirdResult, 0);
  assert.strictEqual(spawnCount, 1);
  assert.ok(logs.some((line) => line.includes('픽코 취소 차단')));
  assert.ok(logs.some((line) => line.includes('취소 차단 알림 스킵')));
  assert.ok(logs.some((line) => line.includes('취소 차단 해제 재시도')));
  assert.strictEqual(alerts.length, 2);
  assert.strictEqual(alerts.filter((alert) => alert.title === '🛡️ 픽코 자동 취소 차단').length, 1);
  assert.strictEqual(alerts.filter((alert) => alert.title === '🗑️ 픽코 예약 취소 완료!').length, 1);
  assert.strictEqual(published.length, 1);
  assert.ok(cancelledKeys.has('cancel_blocked|01012345678|2026-06-21|15:00|18:00|A1'));
  assert.ok(cancelledKeys.has('cancel_done|01012345678|2026-06-21|15:00|18:00|A1'));

  console.log('✅ pickko cancel mutation guard smoke ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
