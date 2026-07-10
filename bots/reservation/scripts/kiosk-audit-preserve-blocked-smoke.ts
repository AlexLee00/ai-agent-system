// @ts-nocheck
'use strict';

const assert = require('assert');
const { createKioskAuditService } = require('../lib/kiosk-audit-service.ts');

function createFakePage() {
  return {
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    setViewport: async () => {},
    goto: async () => {},
    waitForNetworkIdle: async () => {},
    close: async () => {},
  };
}

function createService({
  existingBlock,
  entries,
  fetchPickkoEntries,
  dbBlocks = [],
  unblocks = [],
  upserts,
  alerts,
  logs,
}) {
  const entry = {
    name: '테스트',
    phoneRaw: '01062290586',
    date: '2099-08-05',
    start: '10:30',
    end: '12:50',
    room: 'B',
    amount: 0,
    statusText: '결제완료',
  };
  const sourceEntries = entries || [entry];

  return createKioskAuditService({
    launchBrowser: async () => ({
      pages: async () => [createFakePage()],
      close: async () => {},
    }),
    connectBrowser: async () => ({
      newPage: async () => createFakePage(),
      disconnect: () => {},
    }),
    delay: async () => {},
    setupDialogHandler: () => {},
    loginToPickko: async () => {},
    fetchPickkoEntries: fetchPickkoEntries || (async () => ({ entries: sourceEntries })),
    attachNaverScheduleTrace: () => {},
    naverBookingLogin: async () => true,
    selectBookingDate: async () => true,
    verifyBlockInGrid: async () => false,
    blockNaverSlot: async () => false,
    unblockNaverSlot: async (_page, row) => {
      unblocks.push(row);
      return true;
    },
    publishReservationAlert: async (payload) => alerts.push(payload),
    getKioskBlock: async () => existingBlock,
    upsertKioskBlock: async (...args) => upserts.push(args),
    getKioskBlocksForDate: async () => dbBlocks,
    getReservationsBySlot: async () => [],
    maskName: (name) => name,
    getTodayKST: () => '2099-08-05',
    nowKST: () => '2099-08-05T10:00:00+09:00',
    getPickkoLaunchOptions: () => ({}),
    pickkoId: 'id',
    pickkoPw: 'pw',
    bookingUrl: 'https://partner.booking.naver.com/bizes/596871/booking-calendar-view',
    log: (line) => logs.push(String(line)),
  });
}

async function main() {
  const logs = [];
  const upserts = [];
  const alerts = [];
  const entry = {
    name: '테스트',
    phoneRaw: '01062290586',
    date: '2099-08-05',
    start: '10:30',
    end: '12:50',
    room: 'B',
    amount: 0,
    statusText: '결제완료',
  };

  const service = createService({
    existingBlock: { ...entry, naverBlocked: true, blockedAt: '2099-08-05T10:00:00+09:00' },
    upserts,
    alerts,
    logs,
  });

  await service.auditToday({ dateOverride: '2099-08-05', wsEndpoint: 'ws://example.test/devtools/browser/test' });

  assert.equal(upserts.length, 0, 'existing blocked rows must not be overwritten by a failed audit block attempt');
  assert.ok(
    logs.some((line) => line.includes('기존 차단 상태 보존')),
    'audit should log that the existing blocked state was preserved',
  );
  assert.ok(
    alerts.some((payload) => String(payload.message || '').includes('차단확인: 1건')),
    'preserved blocked entries should be reported as confirmed, not failed',
  );

  const repairLogs = [];
  const repairUpserts = [];
  const repairAlerts = [];
  const repairService = createService({
    existingBlock: {
      ...entry,
      naverBlocked: false,
      naverUnblockedAt: null,
      lastBlockResult: 'blocked',
      lastBlockReason: 'already_blocked',
      blockedAt: '2099-08-05T10:00:00+09:00',
    },
    upserts: repairUpserts,
    alerts: repairAlerts,
    logs: repairLogs,
  });

  await repairService.auditToday({ dateOverride: '2099-08-05', wsEndpoint: 'ws://example.test/devtools/browser/test' });

  assert.equal(
    repairUpserts[0]?.[3]?.naverBlocked,
    true,
    'already_blocked evidence with false state should be repaired to naverBlocked=true',
  );
  assert.ok(
    repairAlerts.some((payload) => String(payload.message || '').includes('차단확인: 1건')),
    'repaired blocked evidence should be reported as confirmed, not failed',
  );

  const todayOnlyLogs = [];
  const todayOnlyService = createService({
    existingBlock: { ...entry, naverBlocked: true, blockedAt: '2099-08-05T10:00:00+09:00' },
    entries: [
      entry,
      {
        ...entry,
        phoneRaw: '01099990000',
        date: '2099-08-06',
        start: '13:00',
        end: '13:50',
      },
    ],
    upserts: [],
    alerts: [],
    logs: todayOnlyLogs,
  });

  await todayOnlyService.auditToday({ dateOverride: '2099-08-05', wsEndpoint: 'ws://example.test/devtools/browser/test' });

  assert.ok(
    todayOnlyLogs.some((line) => line.includes('픽코 예약(오늘 감사 대상): 1건')),
    'today audit should only include same-day Pickko reservations',
  );
  assert.equal(
    todayOnlyLogs.filter((line) => line.includes('기존 차단 상태 보존')).length,
    1,
    'today audit must not validate future Pickko reservations',
  );

  const exactDateFetchCalls = [];
  const exactDateUnblocks = [];
  const exactDateService = createService({
    existingBlock: { ...entry, naverBlocked: true, blockedAt: '2099-08-05T10:00:00+09:00' },
    dbBlocks: [entry],
    fetchPickkoEntries: async (_page, date, options = {}) => {
      exactDateFetchCalls.push({ date, options });
      if (options.endDate === '2099-08-05') {
        return { entries: [entry], fetchOk: true };
      }
      return { entries: [], fetchOk: true };
    },
    unblocks: exactDateUnblocks,
    upserts: [],
    alerts: [],
    logs: [],
  });

  await exactDateService.auditToday({ dateOverride: '2099-08-05', wsEndpoint: 'ws://example.test/devtools/browser/test' });

  assert.ok(
    exactDateFetchCalls.filter((call) => call.options.endDate === '2099-08-05').length >= 2,
    'today audit Pickko reads must be exact-day reads before orphan unblock decisions',
  );
  assert.equal(
    exactDateUnblocks.length,
    0,
    'exact-day Pickko evidence must prevent false orphan unblocks',
  );

  console.log('kiosk_audit_preserve_blocked_smoke_ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
