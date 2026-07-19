// @ts-nocheck
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const {
  createPickkoOperationLockOwner,
  requirePickkoOperationLockRenewal,
  waitForPickkoChildProcess,
  waitForPickkoOperationLock,
} = require('../lib/pickko-operation-lock');
const {
  createKioskRuntimeService,
} = require('../lib/kiosk-runtime-service');
const {
  createKioskMainService,
} = require('../lib/kiosk-main-service');
const {
  buildPayScanLockDeferralFailures,
} = require('../lib/report-followup-helpers');

function testLockOwnerIsUniquePerAcquisition() {
  const firstOwner = createPickkoOperationLockOwner('jimmy');
  const secondOwner = createPickkoOperationLockOwner('jimmy');

  assert.match(firstOwner, /^jimmy:\d+:[a-f0-9-]+$/);
  assert.match(secondOwner, /^jimmy:\d+:[a-f0-9-]+$/);
  assert.notEqual(firstOwner, secondOwner, 'each lock acquisition must use a unique owner token');
}

async function testImmediateAcquire() {
  let attempts = 0;
  const result = await waitForPickkoOperationLock({
    owner: 'pay_scan',
    ttlMs: 30_000,
    waitMs: 10_000,
    pollMs: 1_000,
    acquireLock: async () => {
      attempts += 1;
      return true;
    },
    getLockState: async () => ({ locked: false, by: null }),
    delay: async () => assert.fail('immediate acquire must not wait'),
    now: () => 0,
  });

  assert.deepEqual(result, {
    acquired: true,
    attempts: 1,
    waitedMs: 0,
    blockedBy: null,
  });
  assert.equal(attempts, 1);
}

async function testWaitThenAcquire() {
  let nowMs = 0;
  let attempts = 0;
  const waits = [];
  const result = await waitForPickkoOperationLock({
    owner: 'pay_scan',
    ttlMs: 30_000,
    waitMs: 10_000,
    pollMs: 1_000,
    acquireLock: async () => {
      attempts += 1;
      return attempts >= 2;
    },
    getLockState: async () => ({ locked: true, by: 'jimmy' }),
    delay: async (ms) => {
      waits.push(ms);
      nowMs += ms;
    },
    now: () => nowMs,
  });

  assert.deepEqual(result, {
    acquired: true,
    attempts: 2,
    waitedMs: 1_000,
    blockedBy: 'jimmy',
  });
  assert.deepEqual(waits, [1_000]);
}

async function testTimeout() {
  let nowMs = 0;
  const result = await waitForPickkoOperationLock({
    owner: 'pay_scan',
    ttlMs: 30_000,
    waitMs: 2_500,
    pollMs: 1_000,
    acquireLock: async () => false,
    getLockState: async () => ({ locked: true, by: 'today_audit' }),
    delay: async (ms) => { nowMs += ms; },
    now: () => nowMs,
  });

  assert.deepEqual(result, {
    acquired: false,
    attempts: 4,
    waitedMs: 2_500,
    blockedBy: 'today_audit',
  });
}

function testPayScanLockTimeoutBecomesActionableFailure() {
  const targets = [
    { id: 'reservation-1', date: '2026-07-17', start: '09:00', end: '10:00', room: 'A' },
    { id: 'reservation-2', date: '2026-07-17', start: '10:00', end: '11:00', room: 'B' },
  ];
  const failures = buildPayScanLockDeferralFailures(targets, {
    blockedBy: 'jimmy:123:lock-owner',
    waitedMs: 1_200_000,
  });

  assert.equal(failures.length, 2);
  assert.deepEqual(failures.map(({ entry }) => entry.id), ['reservation-1', 'reservation-2']);
  for (const { result } of failures) {
    assert.equal(result.ok, false);
    assert.equal(result.lockDeferred, true);
    assert.match(result.message, /pickko_lock_wait_timeout/);
    assert.match(result.message, /jimmy:123:lock-owner/);
    assert.match(result.message, /1200000ms/);
  }

  const payScanSource = fs.readFileSync(
    path.resolve(__dirname, '../auto/scheduled/pickko-pay-scan.ts'),
    'utf8',
  );
  assert.match(payScanSource, /buildPayScanLockDeferralFailures\(targets, lockResult\)/);
  const branchStart = payScanSource.indexOf('if (!lockResult.acquired)');
  const branchEnd = payScanSource.indexOf('} else {', branchStart);
  assert.ok(branchStart >= 0 && branchEnd > branchStart, 'lock timeout branch must remain explicit');
  const timeoutBranch = payScanSource.slice(branchStart, branchEnd);
  assert.doesNotMatch(timeoutBranch, /\breturn\b/, 'lock timeout must continue into the alert pipeline');
  assert.match(timeoutBranch, /failures\.push\(\.\.\.lockFailures\)/);
}

function testManualPriorityClearRequiresMatchingOwner() {
  const stateBusSource = fs.readFileSync(path.resolve(__dirname, '../lib/state-bus.ts'), 'utf8');
  const payScanSource = fs.readFileSync(path.resolve(__dirname, '../auto/scheduled/pickko-pay-scan.ts'), 'utf8');
  assert.match(stateBusSource, /clearManualPickkoPriority\(expectedTask/);
  assert.match(stateBusSource, /WHERE agent = \$1 AND status = 'running' AND current_task = \$2/);
  assert.match(payScanSource, /clearManualPickkoPriority\('pickko_pay_scan'\)/);
}

async function testKioskUsesLongLivedLock() {
  let acquireArgs = null;
  const service = createKioskRuntimeService({
    log: () => {},
    pruneOldKioskBlocks: async () => 0,
    isManualPickkoPriorityActive: async () => ({ active: false }),
    isPickkoLocked: async () => ({ locked: false, by: null, expiresAt: null }),
    acquirePickkoLock: async (...args) => {
      acquireArgs = args;
      return false;
    },
    renewPickkoLock: async () => true,
    releasePickkoLock: async () => true,
    updateAgentState: async () => {},
    launchBrowser: async () => assert.fail('browser must not launch when lock acquisition fails'),
    getPickkoLaunchOptions: () => ({}),
    setupDialogHandler: () => {},
  });

  const result = await service.prepareRuntime({ today: '2026-07-16' });
  assert.equal(result.skipped, true);
  assert.match(acquireArgs[0], /^jimmy:\d+:[a-f0-9-]+$/);
  assert.equal(acquireArgs[1], 30 * 60 * 1000);
}

async function testKioskReleasesLockWhenBrowserLaunchFails() {
  let acquiredOwner = null;
  const releasedOwners = [];
  const service = createKioskRuntimeService({
    log: () => {},
    pruneOldKioskBlocks: async () => 0,
    isManualPickkoPriorityActive: async () => ({ active: false }),
    isPickkoLocked: async () => ({ locked: false, by: null, expiresAt: null }),
    acquirePickkoLock: async (owner) => {
      acquiredOwner = owner;
      return true;
    },
    renewPickkoLock: async () => true,
    releasePickkoLock: async (owner) => {
      releasedOwners.push(owner);
      return true;
    },
    updateAgentState: async () => {},
    launchBrowser: async () => { throw new Error('browser launch failed'); },
    getPickkoLaunchOptions: () => ({}),
    setupDialogHandler: () => {},
  });

  await assert.rejects(
    service.prepareRuntime({ today: '2026-07-16' }),
    /browser launch failed/,
  );
  assert.match(acquiredOwner, /^jimmy:\d+:[a-f0-9-]+$/);
  assert.deepEqual(releasedOwners, [acquiredOwner]);
}

async function testKioskHeartbeatFailureIsExposedToLeaseGuard() {
  let heartbeatTick = null;
  let heartbeatCleared = false;
  let acquiredOwner = null;
  let renewedOwner = null;
  let releasedOwner = null;
  const browser = {
    pages: async () => [{ setDefaultTimeout: () => {} }],
    close: async () => {},
  };
  const service = createKioskRuntimeService({
    log: () => {},
    pruneOldKioskBlocks: async () => 0,
    isManualPickkoPriorityActive: async () => ({ active: false }),
    isPickkoLocked: async () => ({ locked: false, by: null, expiresAt: null }),
    acquirePickkoLock: async (owner) => {
      acquiredOwner = owner;
      return true;
    },
    renewPickkoLock: async (owner) => {
      renewedOwner = owner;
      return false;
    },
    releasePickkoLock: async (owner) => {
      releasedOwner = owner;
      return true;
    },
    updateAgentState: async () => {},
    launchBrowser: async () => browser,
    getPickkoLaunchOptions: () => ({}),
    setupDialogHandler: () => {},
    setHeartbeatInterval: (callback) => {
      heartbeatTick = callback;
      return { unref: () => {} };
    },
    clearHeartbeatInterval: () => { heartbeatCleared = true; },
  });

  let runtime = null;
  try {
    runtime = await service.prepareRuntime({ today: '2026-07-16' });
    assert.equal(typeof heartbeatTick, 'function');
    heartbeatTick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.throws(() => runtime.assertLockLease(), /pickko_operation_lock_renew_failed/);
    assert.equal(heartbeatCleared, true);
    assert.match(acquiredOwner, /^jimmy:\d+:[a-f0-9-]+$/);
    assert.equal(renewedOwner, acquiredOwner);
  } finally {
    if (runtime) await service.cleanupRuntime(runtime);
  }
  assert.equal(releasedOwner, acquiredOwner);
}

async function testKioskRenewsLeaseBeforeEachLongPhase() {
  let renewalCount = 0;
  let leaseCheckCount = 0;
  const cleanupCalls = [];
  const assertLockLease = () => { leaseCheckCount += 1; };
  const service = createKioskMainService({
    getTodayKST: () => '2026-07-16',
    log: () => {},
    updateAgentState: async () => {},
    prepareRuntime: async () => ({
      skipped: false,
      browser: {},
      page: {},
      lockAcquired: true,
      lockOwner: 'jimmy:test-owner',
      renewLockLease: async () => { renewalCount += 1; },
      assertLockLease,
      stopLockHeartbeat: () => {},
    }),
    cleanupRuntime: async (args) => { cleanupCalls.push(args); },
    preparePickkoCycle: async () => ({
      toBlockEntries: [{ id: 'reservation-1' }],
      cancelledEntries: [],
    }),
    processNaverPhase: async (args) => {
      assert.equal(args.assertLockLease, assertLockLease);
      args.assertLockLease();
    },
    recordKioskBlockAttempt: async () => {},
    wsFile: '/tmp/naver-ws',
    pickkoId: 'id',
    pickkoPw: 'pw',
  });

  await service.runMainCycle();
  assert.equal(renewalCount, 2, 'lease must be renewed before Pickko read and Naver mutation phases');
  assert.equal(leaseCheckCount, 3, 'Pickko read, Naver mutation, and completion must check the live lease guard');
  assert.equal(cleanupCalls.length, 1);
  assert.equal(cleanupCalls[0].lockOwner, 'jimmy:test-owner');
  assert.equal(typeof cleanupCalls[0].stopLockHeartbeat, 'function');
}

function testNaverMutationsCheckLeaseGuard() {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../lib/kiosk-naver-phase-service.ts'),
    'utf8',
  );
  assert.match(source, /assertLockLease\(\);\s*try\s*{\s*const blockResult = await blockNaverSlot/);
  assert.match(source, /assertLockLease\(\);\s*try\s*{\s*unblocked = await unblockNaverSlot/);
}

function testCompletedNaverMutationsPersistBeforePostLeaseGuard() {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../lib/kiosk-naver-phase-service.ts'),
    'utf8',
  );

  const blockStart = source.indexOf('const blockResult = await blockNaverSlot');
  const blockEnd = source.indexOf('if (blocked) {', blockStart);
  const blockSection = source.slice(blockStart, blockEnd);
  assert.ok(blockStart >= 0 && blockEnd > blockStart, 'block mutation section must be present');
  assert.ok(
    blockSection.lastIndexOf('await upsertKioskBlock') < blockSection.lastIndexOf('assertLockLease();'),
    'completed block result must be persisted before the post-mutation lease guard aborts the cycle',
  );

  const unblockStart = source.indexOf('unblocked = await unblockNaverSlot');
  const unblockEnd = source.indexOf('publishKioskSuccessReport(', unblockStart);
  const unblockSection = source.slice(unblockStart, unblockEnd);
  assert.ok(unblockStart >= 0 && unblockEnd > unblockStart, 'unblock mutation section must be present');
  assert.ok(
    unblockSection.lastIndexOf('await upsertKioskBlock') < unblockSection.lastIndexOf('assertLockLease();'),
    'completed unblock result must be persisted before the post-mutation lease guard aborts the cycle',
  );
}

async function testRequiredRenewal() {
  let renewalArgs = null;
  await requirePickkoOperationLockRenewal({
    owner: 'pay_scan',
    ttlMs: 30_000,
    renewLock: async (...args) => {
      renewalArgs = args;
      return true;
    },
  });
  assert.deepEqual(renewalArgs, ['pay_scan', 30_000]);

  await assert.rejects(
    requirePickkoOperationLockRenewal({
      owner: 'pay_scan',
      ttlMs: 30_000,
      renewLock: async () => false,
    }),
    /pickko_operation_lock_renew_failed/,
  );
}

async function testChildTimeoutKillsProcess() {
  const child = new EventEmitter();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    setImmediate(() => child.emit('close', null, signal));
    return true;
  };

  const result = await waitForPickkoChildProcess(child, {
    timeoutMs: 5,
    killGraceMs: 20,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGTERM');
  assert.deepEqual(signals, ['SIGTERM']);
}

async function testForceKillWaitsForChildClose() {
  const child = new EventEmitter();
  const signals = [];
  const timers = [];
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };

  const outcomePromise = waitForPickkoChildProcess(child, {
    timeoutMs: 5,
    killGraceMs: 20,
    setTimer: (callback) => {
      timers.push(callback);
      return callback;
    },
    clearTimer: () => {},
  });

  timers.shift()();
  timers.shift()();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);

  let settled = false;
  outcomePromise.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, 'SIGKILL delivery alone must not complete the child wait');

  child.emit('close', null, 'SIGKILL');
  const result = await outcomePromise;
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGKILL');
}

async function testKillErrorStillWaitsForChildClose() {
  const child = new EventEmitter();
  const timers = [];
  child.kill = () => { throw new Error('kill failed'); };

  const outcomePromise = waitForPickkoChildProcess(child, {
    timeoutMs: 5,
    killGraceMs: 20,
    setTimer: (callback) => {
      timers.push(callback);
      return callback;
    },
    clearTimer: () => {},
  });

  timers.shift()();
  timers.shift()();
  child.emit('error', new Error('kill event failed'));

  let settled = false;
  outcomePromise.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, 'kill errors must not bypass child close confirmation');

  child.emit('close', null, null);
  const result = await outcomePromise;
  assert.equal(result.timedOut, true);
  assert.match(result.error.message, /kill event failed/);
}

Promise.resolve()
  .then(testLockOwnerIsUniquePerAcquisition)
  .then(testImmediateAcquire)
  .then(testWaitThenAcquire)
  .then(testTimeout)
  .then(testPayScanLockTimeoutBecomesActionableFailure)
  .then(testKioskUsesLongLivedLock)
  .then(testKioskReleasesLockWhenBrowserLaunchFails)
  .then(testKioskHeartbeatFailureIsExposedToLeaseGuard)
  .then(testKioskRenewsLeaseBeforeEachLongPhase)
  .then(testNaverMutationsCheckLeaseGuard)
  .then(testCompletedNaverMutationsPersistBeforePostLeaseGuard)
  .then(testManualPriorityClearRequiresMatchingOwner)
  .then(testRequiredRenewal)
  .then(testChildTimeoutKillsProcess)
  .then(testForceKillWaitsForChildClose)
  .then(testKillErrorStillWaitsForChildClose)
  .then(() => console.log('✅ pickko operation lock smoke ok'))
  .catch((error) => {
    console.error(error?.stack || error);
    process.exit(1);
  });
