// @ts-nocheck
'use strict';

const assert = require('assert');
const { createNaverMonitorService } = require('../lib/naver-monitor-service.ts');

function createService(unresolved) {
  const resolvedTitles = [];
  const reports = [];
  const service = createNaverMonitorService({
    workspace: '/tmp',
    log: () => {},
    publishReservationAlert: async (payload) => reports.push(payload),
    findReservationByBooking: async () => null,
    resolveAlert: async () => 0,
    resolveAlertsByTitle: async (title) => {
      resolvedTitles.push(title);
      return 1;
    },
    getUnresolvedAlerts: async () => unresolved,
    addAlert: async () => 1,
    updateAlertSent: async () => {},
    pruneOldAlerts: async () => 0,
    cleanupExpiredSeen: async () => {},
    isTerminalReservationLike: () => false,
    getAlertLevelByType: () => 2,
    maskPhone: (phone) => phone,
    toKst: () => '',
    buildMonitorAlertMessage: () => '',
    buildUnresolvedAlertsSummary: () => 'UNRESOLVED',
  });
  return { service, resolvedTitles, reports };
}

async function main() {
  const currentTitle = 'ℹ️ 픽코 예약 등록됨, 결제 대기 운영 큐';
  const legacyTitle = 'ℹ️ 픽코 예약 등록됨, 결제 확인 필요';

  for (const title of [currentTitle, legacyTitle]) {
    for (const message of ['상태: manual_pending', 'status: manual_pending']) {
      const result = createService([{ title, message }]);
      await result.service.reportUnresolvedAlerts();
      assert.deepEqual(result.resolvedTitles, [title], `${title} / ${message} must resolve as an operational queue`);
      assert.deepEqual(result.reports, [], `${title} / ${message} must not be reported as unresolved`);
    }
  }

  const unrelated = createService([
    { title: currentTitle, message: '상태: failed' },
  ]);
  await unrelated.service.reportUnresolvedAlerts();
  assert.deepEqual(unrelated.resolvedTitles, [], 'non-manual-pending alert must remain actionable');
  assert.equal(unrelated.reports.length, 1, 'non-manual-pending alert must be reported');

  console.log('✅ naver monitor manual-pending resolution smoke ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
