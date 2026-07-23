// @ts-nocheck
'use strict';

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createNaverPickkoRunnerService } = require('../lib/naver-pickko-runner-service.ts');

async function main() {
  const previousTimeout = process.env.PICKKO_CANCEL_TIMEOUT_MS;
  const previousMutation = process.env.PICKKO_CANCEL_MUTATION_ENABLE;
  const previousSkaMutation = process.env.SKA_ENABLE_PICKKO_CANCEL_MUTATION;
  process.env.PICKKO_CANCEL_TIMEOUT_MS = '5';
  process.env.PICKKO_CANCEL_MUTATION_ENABLE = '1';
  process.env.SKA_ENABLE_PICKKO_CANCEL_MUTATION = '1';

  let spawnCount = 0;
  let firstClosed = false;
  let overlapDetected = false;
  const keepAlive = setInterval(() => {}, 50);
  const service = createNaverPickkoRunnerService({
    isCancelledKey: async () => false,
    getReservation: async () => null,
    markSeen: async () => {},
    resolveAlertsByBooking: async () => {},
    updateBookingState: async () => {},
    updateReservation: async () => {},
    addCancelledKey: async () => {},
    sendAlert: async () => {},
    ragSaveReservation: async () => {},
    publishReservationAlert: async () => {},
    autoBugReport: () => {},
    transformAndNormalizeData: (value) => value,
    verifyRecoverablePickkoFailure: async () => false,
    reconcileSlotDuplicatesAfterRecovery: async () => {},
    buildPickkoCancelArgs: () => ['cancel.js'],
    buildPickkoAccurateArgs: () => ['accurate.js'],
    buildPickkoCancelManualMessage: () => 'manual cancel',
    buildPickkoRetryExceededMessage: () => 'retry exceeded',
    buildPickkoTimeElapsedMessage: () => 'time elapsed',
    buildPickkoManualFailureMessage: () => 'manual failure',
    maskPhone: () => '010****0000',
    toKst: () => '2026-07-23',
    log: () => {},
    setTimeoutImpl: (callback) => {
      setImmediate(callback);
      return 1;
    },
    spawnImpl: () => {
      spawnCount += 1;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      if (spawnCount === 1) {
        child.kill = () => {
          setTimeout(() => {
            firstClosed = true;
            child.emit('close', 1);
          }, 10);
          return true;
        };
      } else {
        overlapDetected = !firstClosed;
        child.kill = () => true;
        setImmediate(() => child.emit('close', 1));
      }
      return child;
    },
  });

  try {
    const result = await service.runPickkoCancel({
      booking: {
        phone: '01000000000',
        date: '2026-07-24',
        start: '10:00',
        end: '11:00',
        room: 'A1',
      },
      scriptsDir: __dirname,
      manualCancelScriptPath: '/tmp/pickko-cancel.js',
    });
    assert.equal(result, 1);
    assert.equal(spawnCount, 2);
    assert.equal(overlapDetected, false, 'retry must wait for the timed-out child to close');
  } finally {
    clearInterval(keepAlive);
    if (previousTimeout === undefined) delete process.env.PICKKO_CANCEL_TIMEOUT_MS;
    else process.env.PICKKO_CANCEL_TIMEOUT_MS = previousTimeout;
    if (previousMutation === undefined) delete process.env.PICKKO_CANCEL_MUTATION_ENABLE;
    else process.env.PICKKO_CANCEL_MUTATION_ENABLE = previousMutation;
    if (previousSkaMutation === undefined) delete process.env.SKA_ENABLE_PICKKO_CANCEL_MUTATION;
    else process.env.SKA_ENABLE_PICKKO_CANCEL_MUTATION = previousSkaMutation;
  }

  console.log('pickko_cancel_timeout_serialization_smoke_ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
