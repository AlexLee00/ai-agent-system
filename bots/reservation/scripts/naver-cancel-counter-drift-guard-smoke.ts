// @ts-nocheck
'use strict';

const assert = require('assert');
const { createNaverMonitorCycleService } = require('../lib/naver-monitor-cycle-service.ts');

process.env.PICKKO_CANCEL_ENABLE = '1';

function createPage() {
  return {
    goto: async () => {},
    waitForNetworkIdle: async () => {},
    evaluate: async () => true,
  };
}

function createService({ currentCancelledList }) {
  const logs = [];
  const alerts = [];
  const resolved = [];
  const service = createNaverMonitorCycleService({
    log: (message) => logs.push(String(message)),
    ensureHomeFromCalendar: async () => {},
    naverLogin: async () => true,
    closePopupsIfPresent: async () => {},
    confirmedCycleService: {
      processConfirmedCycle: async () => ({
        confirmedCount: 0,
        cancelledCount: 1,
        cancelledHref: 'https://example.test/cancelled',
        currentConfirmedList: [],
      }),
    },
    cancelDetectionService: {
      processCancelTab: async ({ cycleNewCancelDetections }) => ({
        currentCancelledList,
        cycleNewCancelDetections,
      }),
      processExpandedCancelled: async ({ cycleNewCancelDetections }) => cycleNewCancelDetections,
      reconcileDroppedConfirmed: async ({ cycleNewCancelDetections }) => cycleNewCancelDetections,
    },
    futureCancelService: {
      processFutureCancelSnapshot: async ({ cycleNewCancelDetections }) => cycleNewCancelDetections,
    },
    cycleReportService: {
      handlePeriodicReports: async (args) => ({
        lastHeartbeatTime: args.lastHeartbeatTime,
        lastDailyReportDate: args.lastDailyReportDate,
        dailyStats: args.dailyStats,
      }),
      markCycleIdle: async () => {},
    },
    sendAlert: async (payload) => alerts.push(payload),
    resolveSystemAlertByTitle: async (title, reason) => resolved.push({ title, reason }),
    publishReservationAlert: async () => {},
    pathJoin: (...parts) => parts.join('/'),
    getModeSuffix: () => '',
    delay: async () => {},
  });
  return { service, logs, alerts, resolved };
}

async function runCycle(service) {
  return service.executeCycle({
    page: createPage(),
    checkCount: 3,
    startTime: Date.now(),
    monitorInterval: 1,
    monitorDuration: 1000,
    naverUrl: 'https://example.test/naver',
    workspace: '/tmp',
    naverUserDataDir: '/tmp/naver-profile',
    headedFlagPath: '/tmp/naver-headed',
    previousConfirmedList: [],
    previousCancelledCount: 0,
    pendingCancelMap: new Map(),
    lastHeartbeatTime: Date.now(),
    heartbeatIntervalMs: 60_000,
    lastDailyReportDate: null,
    dailyStats: {},
  });
}

async function main() {
  const handled = createService({ currentCancelledList: [{ bookingId: 'known-cancel' }] });
  await runCycle(handled.service);
  assert.strictEqual(handled.alerts.length, 0, 'known cancelled tab entries should not emit drift alert');
  assert.strictEqual(handled.resolved.length, 1, 'known cancelled tab entries should resolve stale drift alerts');
  assert.ok(handled.logs.some((line) => line.includes('기존 처리 이력으로 확인')));

  const missing = createService({ currentCancelledList: [] });
  await runCycle(missing.service);
  assert.strictEqual(missing.alerts.length, 1, 'missing cancel tab evidence should still emit drift alert');
  assert.strictEqual(missing.resolved.length, 0, 'missing cancel tab evidence should not resolve drift alert');

  console.log('✅ naver cancel counter drift guard smoke ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
