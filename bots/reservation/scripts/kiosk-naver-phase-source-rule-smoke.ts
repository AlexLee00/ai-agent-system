// @ts-nocheck
'use strict';

const assert = require('assert');
const { createKioskNaverPhaseService } = require('../lib/kiosk-naver-phase-service.ts');

function entry(overrides = {}) {
  return {
    name: overrides.name || '테스트',
    phoneRaw: overrides.phoneRaw || '01011112222',
    date: overrides.date || '2099-01-02',
    start: overrides.start || '10:00',
    end: overrides.end || '10:50',
    room: overrides.room || '스터디룸A1',
    amount: Object.prototype.hasOwnProperty.call(overrides, 'amount') ? overrides.amount : 0,
    statusText: overrides.statusText || '결제완료',
  };
}

function createFakePage() {
  return {
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    setViewport: async () => {},
    evaluateOnNewDocument: async () => {},
    evaluate: async () => {},
    goto: async () => {},
    close: async () => {},
    screenshot: async () => {},
  };
}

async function main() {
  const logs = [];
  const blockedPhones = [];
  const unblockedPhones = [];
  const getKioskBlockCalls = [];
  const upserts = [];

  const naverConfirmed = [
    {
      phoneRaw: '01011112222',
      date: '2099-01-02',
      start: '10:00',
      end: '11:00',
      room: 'A1',
    },
  ];

  const service = createKioskNaverPhaseService({
    log: (message) => logs.push(String(message)),
    readWsFile: () => 'ws://example.test/devtools/browser/test',
    connectBrowser: async () => ({
      newPage: async () => createFakePage(),
      disconnect: () => {},
    }),
    attachNaverScheduleTrace: () => {},
    naverBookingLogin: async () => true,
    upsertKioskBlock: async (phoneRaw, date, start, patch) => {
      upserts.push({ phoneRaw, date, start, patch });
    },
    journalBlockAttempt: async () => {},
    publishRetryableBlockAlert: () => {},
    publishReservationAlert: () => {},
    buildOpsAlertMessage: () => 'message',
    fmtPhone: (phone) => phone,
    nowKST: () => '2099-01-01T00:00:00+09:00',
    waitForCustomerCooldown: async () => {},
    markCustomerCooldown: () => {},
    runtimeConfig: { customerOperationCooldownMs: 0 },
    delay: async () => {},
    blockNaverSlot: async (_page, item) => {
      blockedPhones.push(item.phoneRaw);
      return { ok: true, reason: 'verified' };
    },
    unblockNaverSlot: async (_page, item) => {
      unblockedPhones.push(item.phoneRaw);
      return true;
    },
    publishKioskSuccessReport: () => {},
    getKioskBlock: async (phoneRaw, date, start, end, room) => {
      getKioskBlockCalls.push({ phoneRaw, date, start, end, room });
      if (phoneRaw === '01055556666') {
        return { naverBlocked: true, naverUnblockedAt: null };
      }
      return null;
    },
    bookingUrl: 'https://partner.booking.naver.com/bizes/596871/booking-calendar-view',
    scrapeNewestBookingsFromList: async () => naverConfirmed,
  });

  await service.processNaverPhase({
    wsFile: '/tmp/ws-file-not-read',
    toBlockEntries: [
      entry({ name: '네이버매칭', phoneRaw: '01011112222', amount: 0 }),
      entry({ name: '키오스크', phoneRaw: '01033334444', room: '스터디룸B', start: '12:00', end: '12:50', amount: 0 }),
    ],
    cancelledEntries: [
      entry({ name: '네이버매칭취소', phoneRaw: '01011112222', amount: 0, statusText: '취소' }),
      entry({ name: '키오스크취소', phoneRaw: '01055556666', room: '스터디룸B', start: '13:00', end: '13:50', amount: 0, statusText: '취소' }),
    ],
    recordKioskBlockAttempt: async () => {},
  });

  assert.deepEqual(
    blockedPhones,
    ['01033334444'],
    'Naver-matched Pickko rows must be excluded before blocking',
  );
  assert.deepEqual(
    unblockedPhones,
    ['01055556666'],
    'Only unmatched Pickko cancellations with blocked history should be unblocked',
  );
  assert.ok(
    getKioskBlockCalls.every((call) => call.phoneRaw !== '01011112222'),
    'kiosk_blocks must not be consulted for Naver-matched rows',
  );
  assert.ok(
    logs.some((line) => line.includes('네이버 매칭 제외')),
    'source classification summary should be logged',
  );

  const zeroSnapshotBlockedPhones = [];
  const zeroSnapshotAlerts = [];
  const zeroSnapshotService = createKioskNaverPhaseService({
    log: () => {},
    readWsFile: () => 'ws://example.test/devtools/browser/test',
    connectBrowser: async () => ({
      newPage: async () => createFakePage(),
      disconnect: () => {},
    }),
    attachNaverScheduleTrace: () => {},
    naverBookingLogin: async () => true,
    upsertKioskBlock: async () => {},
    journalBlockAttempt: async () => {},
    publishRetryableBlockAlert: () => {},
    publishReservationAlert: (payload) => zeroSnapshotAlerts.push(payload),
    buildOpsAlertMessage: (options) => `${options.title} ${options.reason}`,
    fmtPhone: (phone) => phone,
    nowKST: () => '2099-01-01T00:00:00+09:00',
    waitForCustomerCooldown: async () => {},
    markCustomerCooldown: () => {},
    runtimeConfig: { customerOperationCooldownMs: 0 },
    delay: async () => {},
    blockNaverSlot: async (_page, item) => {
      zeroSnapshotBlockedPhones.push(item.phoneRaw);
      return { ok: true, reason: 'verified' };
    },
    unblockNaverSlot: async () => true,
    publishKioskSuccessReport: () => {},
    getKioskBlock: async () => null,
    bookingUrl: 'https://partner.booking.naver.com/bizes/596871/booking-calendar-view',
    scrapeNewestBookingsFromList: async () => [],
  });

  await zeroSnapshotService.processNaverPhase({
    wsFile: '/tmp/ws-file-not-read',
    toBlockEntries: [entry({ phoneRaw: '01077778888', amount: 0 })],
    cancelledEntries: [],
    recordKioskBlockAttempt: async () => {},
  });

  assert.deepEqual(
    zeroSnapshotBlockedPhones,
    [],
    'zero-row Naver snapshot with Pickko candidates must fail closed',
  );
  assert.ok(
    zeroSnapshotAlerts.length > 0,
    'zero-row Naver snapshot should publish an operator alert',
  );

  const invalidSnapshotBlockedPhones = [];
  const invalidSnapshotAlerts = [];
  const invalidSnapshotService = createKioskNaverPhaseService({
    log: () => {},
    readWsFile: () => 'ws://example.test/devtools/browser/test',
    connectBrowser: async () => ({
      newPage: async () => createFakePage(),
      disconnect: () => {},
    }),
    attachNaverScheduleTrace: () => {},
    naverBookingLogin: async () => true,
    upsertKioskBlock: async () => {},
    journalBlockAttempt: async () => {},
    publishRetryableBlockAlert: () => {},
    publishReservationAlert: (payload) => invalidSnapshotAlerts.push(payload),
    buildOpsAlertMessage: (options) => `${options.title} ${options.reason}`,
    fmtPhone: (phone) => phone,
    nowKST: () => '2099-01-01T00:00:00+09:00',
    waitForCustomerCooldown: async () => {},
    markCustomerCooldown: () => {},
    runtimeConfig: { customerOperationCooldownMs: 0 },
    delay: async () => {},
    blockNaverSlot: async (_page, item) => {
      invalidSnapshotBlockedPhones.push(item.phoneRaw);
      return { ok: true, reason: 'verified' };
    },
    unblockNaverSlot: async () => true,
    publishKioskSuccessReport: () => {},
    getKioskBlock: async () => null,
    bookingUrl: 'https://partner.booking.naver.com/bizes/596871/booking-calendar-view',
    scrapeNewestBookingsFromList: async () => [{
      phoneRaw: '01077778888',
      date: '2099-01-02',
      start: '10:00',
      end: '11:00',
      room: null,
    }],
  });

  await invalidSnapshotService.processNaverPhase({
    wsFile: '/tmp/ws-file-not-read',
    toBlockEntries: [entry({ phoneRaw: '01077778888', amount: 0 })],
    cancelledEntries: [],
    recordKioskBlockAttempt: async () => {},
  });

  assert.deepEqual(
    invalidSnapshotBlockedPhones,
    [],
    'invalid Naver snapshot rows must fail closed before source classification',
  );
  assert.ok(
    invalidSnapshotAlerts.length > 0,
    'invalid Naver snapshot rows should publish an operator alert',
  );

  console.log('kiosk_naver_phase_source_rule_smoke_ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
