type Logger = (message: string) => void;

export type CreateKioskRuntimeServiceDeps = {
  log: Logger;
  pruneOldKioskBlocks: (cutoffDate: string) => Promise<number>;
  isManualPickkoPriorityActive: () => Promise<any>;
  isPickkoLocked: () => Promise<any>;
  acquirePickkoLock: (owner: string) => Promise<boolean>;
  releasePickkoLock: (owner: string) => Promise<any>;
  updateAgentState: (agent: string, status: string, detail?: string) => Promise<any>;
  launchBrowser: (options?: any) => Promise<any>;
  getPickkoLaunchOptions: () => any;
  setupDialogHandler: (page: any, log: Logger) => void;
};

export function createKioskRuntimeService(deps: CreateKioskRuntimeServiceDeps) {
  const {
    log,
    pruneOldKioskBlocks,
    isManualPickkoPriorityActive,
    isPickkoLocked,
    acquirePickkoLock,
    releasePickkoLock,
    updateAgentState,
    launchBrowser,
    getPickkoLaunchOptions,
    setupDialogHandler,
  } = deps;

  async function prepareRuntime({ today }: { today: string }) {
    const todayParts = today.split('-').map(Number);
    const pruneDt = new Date(todayParts[0], todayParts[1] - 1, todayParts[2]);
    pruneDt.setDate(pruneDt.getDate() - 1);
    const pruneDate = `${pruneDt.getFullYear()}-${String(pruneDt.getMonth() + 1).padStart(2, '0')}-${String(pruneDt.getDate()).padStart(2, '0')}`;
    const pruned = await pruneOldKioskBlocks(pruneDate);
    if (pruned > 0) {
      log(`🧹 만료 항목 삭제: ${pruned}건 (${pruneDate} 이전)`);
    }

    const manualPriority = await isManualPickkoPriorityActive();
    if (manualPriority.active) {
      const updatedAt = manualPriority.updatedAt instanceof Date
        ? manualPriority.updatedAt.toISOString()
        : manualPriority.updatedAt || null;
      log(`⏸️ manual 픽코 우선 신호 감지 — kiosk-monitor 이번 사이클 스킵 (task=${manualPriority.task || 'manual_reservation'}, updatedAt=${updatedAt || 'unknown'})`);
      await updateAgentState('jimmy', 'idle', 'manual_priority_signal');
      return { skipped: true, browser: null, page: null, lockAcquired: false };
    }

    const existingLock = await isPickkoLocked();
    if (existingLock.locked && existingLock.by === 'manual') {
      const expiresAt = existingLock.expiresAt instanceof Date
        ? existingLock.expiresAt.toISOString()
        : existingLock.expiresAt || null;
      log(`⏸️ manual 픽코 작업이 진행 중이므로 kiosk-monitor 이번 사이클 스킵 (expiresAt=${expiresAt || 'unknown'})`);
      await updateAgentState('jimmy', 'idle', 'manual_priority_lock');
      return { skipped: true, browser: null, page: null, lockAcquired: false };
    }

    const lockAcquired = await acquirePickkoLock('jimmy');
    if (!lockAcquired) {
      log('⚠️ 픽코 락 획득 실패 — 다른 에이전트가 사용 중. 이번 사이클 스킵');
      await updateAgentState('jimmy', 'idle');
      return { skipped: true, browser: null, page: null, lockAcquired: false };
    }
    log('🔒 픽코 락 획득 (jimmy)');

    const browser = await launchBrowser(getPickkoLaunchOptions());
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    page.setDefaultTimeout(30000);
    setupDialogHandler(page, log);

    return { skipped: false, browser, page, lockAcquired };
  }

  async function cleanupRuntime({
    browser,
    lockAcquired,
  }: {
    browser: any;
    lockAcquired: boolean;
  }) {
    await updateAgentState('jimmy', 'idle');
    if (lockAcquired) {
      await releasePickkoLock('jimmy');
      log('🔓 픽코 락 해제 (jimmy)');
    }
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }

  return {
    prepareRuntime,
    cleanupRuntime,
  };
}
