// @ts-nocheck
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const {
  createNaverPickkoRunnerService,
  PICKKO_CANCEL_BLOCKED_CODE,
} = require('../lib/naver-pickko-runner-service.ts');

async function main() {
  const previousPickkoMutation = process.env.PICKKO_CANCEL_MUTATION_ENABLE;
  const previousSkaMutation = process.env.SKA_ENABLE_PICKKO_CANCEL_MUTATION;
  const restoreEnv = () => {
    if (previousPickkoMutation === undefined) delete process.env.PICKKO_CANCEL_MUTATION_ENABLE;
    else process.env.PICKKO_CANCEL_MUTATION_ENABLE = previousPickkoMutation;
    if (previousSkaMutation === undefined) delete process.env.SKA_ENABLE_PICKKO_CANCEL_MUTATION;
    else process.env.SKA_ENABLE_PICKKO_CANCEL_MUTATION = previousSkaMutation;
  };

  delete process.env.PICKKO_CANCEL_MUTATION_ENABLE;
  delete process.env.SKA_ENABLE_PICKKO_CANCEL_MUTATION;

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
      throw new Error('spawn must not run while mutation guard is disabled');
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

  assert.strictEqual(result, PICKKO_CANCEL_BLOCKED_CODE);
  assert.strictEqual(secondResult, PICKKO_CANCEL_BLOCKED_CODE);
  assert.strictEqual(spawnCount, 0);
  assert.ok(logs.some((line) => line.includes('픽코 취소 차단')));
  assert.ok(logs.some((line) => line.includes('취소 차단 알림 스킵')));
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(published.length, 1);
  assert.ok(cancelledKeys.has('cancel_blocked|01012345678|2026-06-21|15:00|18:00|A1'));
  assert.equal(cancelledKeys.has('cancel_done|01012345678|2026-06-21|15:00|18:00|A1'), false);

  process.env.PICKKO_CANCEL_MUTATION_ENABLE = '1';
  delete process.env.SKA_ENABLE_PICKKO_CANCEL_MUTATION;
  const staleBlockedKeys = new Set(['cancel_blocked|01012345678|2026-06-21|15:00|18:00|A1']);
  const staleBlockedLogs = [];
  let staleBlockedSpawnCount = 0;

  const enabledService = createNaverPickkoRunnerService({
    isCancelledKey: async (key) => staleBlockedKeys.has(key),
    getReservation: async () => null,
    markSeen: async () => {},
    resolveAlertsByBooking: async () => {},
    updateBookingState: async () => {},
    updateReservation: async () => {},
    addCancelledKey: async (key) => { staleBlockedKeys.add(key); },
    sendAlert: async () => {},
    ragSaveReservation: async () => {},
    publishReservationAlert: async () => {},
    autoBugReport: () => {},
    transformAndNormalizeData: (item) => item,
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
    log: (message) => staleBlockedLogs.push(String(message)),
    spawnImpl: () => {
      staleBlockedSpawnCount += 1;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => child.emit('close', 0));
      return child;
    },
  });

  const pickkoOnlyResult = await enabledService.runPickkoCancel({
    booking,
    scriptsDir: __dirname,
    manualCancelScriptPath: '/tmp/pickko-cancel.js',
  });

  assert.strictEqual(pickkoOnlyResult, PICKKO_CANCEL_BLOCKED_CODE);
  assert.strictEqual(staleBlockedSpawnCount, 0);

  process.env.SKA_ENABLE_PICKKO_CANCEL_MUTATION = '1';

  const enabledResult = await enabledService.runPickkoCancel({
    booking,
    scriptsDir: __dirname,
    manualCancelScriptPath: '/tmp/pickko-cancel.js',
  });

  assert.strictEqual(enabledResult, 0);
  assert.strictEqual(staleBlockedSpawnCount, 1);
  assert.ok(staleBlockedLogs.some((line) => line.includes('취소차단키 무시')));
  assert.ok(staleBlockedKeys.has('cancel_done|01012345678|2026-06-21|15:00|18:00|A1'));

  restoreEnv();
  console.log('✅ pickko cancel mutation guard smoke ok');
}

main().catch((error) => {
  delete process.env.PICKKO_CANCEL_MUTATION_ENABLE;
  delete process.env.SKA_ENABLE_PICKKO_CANCEL_MUTATION;
  console.error(error.stack || error.message || error);
  process.exit(1);
});
