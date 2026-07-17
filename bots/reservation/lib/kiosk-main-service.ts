type Logger = (message: string) => void;

export type CreateKioskMainServiceDeps = {
  getTodayKST: () => string;
  log: Logger;
  updateAgentState: (agent: string, status: string, detail?: string) => Promise<any>;
  prepareRuntime: (args: { today: string }) => Promise<any>;
  cleanupRuntime: (args: {
    browser: any;
    lockAcquired: boolean;
    lockOwner?: string;
    stopLockHeartbeat?: () => void;
  }) => Promise<any>;
  preparePickkoCycle: (args: {
    page: any;
    today: string;
    pickkoId: string;
    pickkoPw: string;
  }) => Promise<any>;
  processNaverPhase: (args: {
    wsFile: string;
    toBlockEntries: any[];
    cancelledEntries: any[];
    recordKioskBlockAttempt: (...args: any[]) => any;
    assertLockLease: () => void;
  }) => Promise<any>;
  recordKioskBlockAttempt: (...args: any[]) => any;
  wsFile: string;
  pickkoId: string;
  pickkoPw: string;
};

export function createKioskMainService(deps: CreateKioskMainServiceDeps) {
  const {
    getTodayKST,
    log,
    updateAgentState,
    prepareRuntime,
    cleanupRuntime,
    preparePickkoCycle,
    processNaverPhase,
    recordKioskBlockAttempt,
    wsFile,
    pickkoId,
    pickkoPw,
  } = deps;

  async function runMainCycle() {
    const today = getTodayKST();
    log(`\n🔍 픽코 키오스크 모니터 시작: ${today}`);
    await updateAgentState('jimmy', 'running', `키오스크 모니터 ${today}`);

    let browser: any;
    let lockAcquired = false;
    let lockOwner: string | undefined;
    let stopLockHeartbeat: (() => void) | undefined;
    try {
      const runtime = await prepareRuntime({ today });
      if (runtime.skipped) {
        return;
      }
      browser = runtime.browser;
      const page = runtime.page;
      lockAcquired = runtime.lockAcquired;
      lockOwner = runtime.lockOwner;
      stopLockHeartbeat = runtime.stopLockHeartbeat;

      await runtime.renewLockLease();
      const {
        toBlockEntries,
        cancelledEntries,
      } = await preparePickkoCycle({
        page,
        today,
        pickkoId,
        pickkoPw,
      });
      runtime.assertLockLease();

      if (toBlockEntries.length === 0 && cancelledEntries.length === 0) {
        log('✅ 신규 예약 없음, 재시도 없음, 취소 없음. 종료');
        return;
      }

      log('\n[Phase 3] 네이버 booking calendar — CDP 연결');
      await runtime.renewLockLease();
      await processNaverPhase({
        wsFile,
        toBlockEntries,
        cancelledEntries,
        recordKioskBlockAttempt,
        assertLockLease: runtime.assertLockLease,
      });
      runtime.assertLockLease();

      log('\n✅ 픽코 키오스크 모니터 완료');
    } finally {
      await cleanupRuntime({ browser, lockAcquired, lockOwner, stopLockHeartbeat });
    }
  }

  return {
    runMainCycle,
  };
}
