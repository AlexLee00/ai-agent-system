import { getReservationBrowserConfig } from './runtime-config';

type Logger = (message: string) => void;

export type CreateNaverMonitorCycleServiceDeps = {
  log: Logger;
  ensureHomeFromCalendar: (page: any) => Promise<any>;
  naverLogin: (page: any) => Promise<boolean>;
  closePopupsIfPresent: (page: any) => Promise<any>;
  confirmedCycleService: {
    processConfirmedCycle: (args: {
      page: any;
      naverUrl: string;
      workspace: string;
    }) => Promise<{
      confirmedCount: number;
      cancelledCount: number;
      cancelledHref: string | null;
      currentConfirmedList: Record<string, any>[];
    }>;
  };
  cancelDetectionService: {
    processCancelTab: (args: any) => Promise<{ currentCancelledList: Record<string, any>[]; cycleNewCancelDetections: number }>;
    processExpandedCancelled: (args: any) => Promise<number>;
    reconcileDroppedConfirmed: (args: any) => Promise<number>;
  };
  futureCancelService: {
    processFutureCancelSnapshot: (args: any) => Promise<number>;
  };
  cycleReportService: {
    handlePeriodicReports: (args: any) => Promise<{
      lastHeartbeatTime: number;
      lastDailyReportDate: string | null;
      dailyStats: Record<string, any>;
    }>;
    markCycleIdle: (checkCount: number) => Promise<any>;
  };
  sendAlert: (options: Record<string, any>) => Promise<any>;
  resolveSystemAlertByTitle: (title: string, reason?: string) => Promise<any>;
  publishReservationAlert: (payload: Record<string, any>) => Promise<any> | any;
  pathJoin: (...parts: string[]) => string;
  getModeSuffix: () => string;
  delay: (ms: number) => Promise<void>;
};

export function createNaverMonitorCycleService(deps: CreateNaverMonitorCycleServiceDeps) {
  const {
    log,
    ensureHomeFromCalendar,
    naverLogin,
    closePopupsIfPresent,
    confirmedCycleService,
    cancelDetectionService,
    futureCancelService,
    cycleReportService,
    sendAlert,
    resolveSystemAlertByTitle,
    publishReservationAlert,
    pathJoin,
    getModeSuffix,
  } = deps;
  const browserConfig = getReservationBrowserConfig();
  const navigationTimeoutMs = Math.max(15000, browserConfig.navigationTimeoutMs || 30000);
  const networkIdleTimeoutMs = Math.min(5000, navigationTimeoutMs);

  async function safeGotoNaverHome(page: any, naverUrl: string, reason: string, maxAttempts = 2): Promise<void> {
    let lastError: any = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await page.goto(naverUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
        await page.waitForNetworkIdle({ idleTime: 800, timeout: networkIdleTimeoutMs }).catch(() => null);
        return;
      } catch (error: any) {
        lastError = error;
        log(`⚠️ 네이버 홈 복귀 실패(${reason}) ${attempt}/${maxAttempts}: ${error?.message || error}`);
        if (attempt < maxAttempts) {
          await deps.delay(1200);
        }
      }
    }
    throw lastError;
  }

  async function executeCycle({
    page,
    checkCount,
    startTime,
    monitorInterval,
    monitorDuration,
    naverUrl,
    workspace,
    naverUserDataDir,
    headedFlagPath,
    previousConfirmedList,
    previousCancelledCount,
    pendingCancelMap,
    lastHeartbeatTime,
    heartbeatIntervalMs,
    lastDailyReportDate,
    dailyStats,
  }: {
    page: any;
    checkCount: number;
    startTime: number;
    monitorInterval: number;
    monitorDuration: number;
    naverUrl: string;
    workspace: string;
    naverUserDataDir: string;
    headedFlagPath: string;
    previousConfirmedList: Record<string, any>[];
    previousCancelledCount: number | null;
    pendingCancelMap: Map<string, any>;
    lastHeartbeatTime: number;
    heartbeatIntervalMs: number;
    lastDailyReportDate: string | null;
    dailyStats: Record<string, any>;
  }) {
    const cycleStart = Date.now();

    await safeGotoNaverHome(page, naverUrl, 'cycle-entry');
    await ensureHomeFromCalendar(page);

    const sessionOk = await page.evaluate(() => {
      const t = document.body?.innerText || document.body?.textContent || '';
      return t.includes('오늘 확정') || t.includes('예약 현황');
    }).catch(() => false);

    if (!sessionOk) {
      log('⚠️ 세션 만료 감지 → 자동 재로그인 시도');
      const recovered = await naverLogin(page);
      if (recovered) {
        log('✅ 세션 자동 복구 완료');
      } else {
        log('❌ 세션 자동 복구 실패');
        publishReservationAlert({
          from_bot: 'andy',
          event_type: 'alert',
          alert_level: 3,
          message:
            '🚨 네이버 로그인 세션 만료 또는 자동 재로그인 실패\n' +
            '현재 스카 모니터는 headless 운영 중입니다.\n\n' +
            '조치:\n' +
            '1. headed 모드 전환: touch bots/reservation/.playwright-headed\n' +
            '2. 모니터 재시작: bash bots/reservation/scripts/reload-monitor.sh\n' +
            '3. 네이버 수동 로그인 완료 후 상태 확인\n' +
            '4. 운영 복귀: rm bots/reservation/.playwright-headed 후 재시작\n\n' +
            `프로필: ${naverUserDataDir}\n` +
            `플래그 파일: ${headedFlagPath}`,
        });
      }
    }

    log(`\n📍 확인 #${checkCount}`);

    try {
      const clicked = await page.evaluate(() => {
        const btn = document.querySelector('button[class*="btn_refresh"]') as HTMLButtonElement | null;
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
      if (clicked) {
        const ms = parseInt(process.env.NAVER_REFRESH_DELAY_MS || '1200', 10);
        log(`🖱️ 예약현황 새로고침 버튼 클릭 (${ms}ms 대기)`);
        await deps.delay(ms);
      }
    } catch (err: any) {
      log(`⚠️ 새로고침 클릭 실패(무시): ${err.message}`);
    }

    await closePopupsIfPresent(page);

    const todaySeoul = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    const bizId = naverUrl.match(/\/place\/(\d+)/)?.[1] || '';
    let currentConfirmedList: Record<string, any>[] = [];
    let cancelledHref: string | null = null;
    let cancelledCount = 0;
    let confirmedCount = 0;
    let cycleNewCancelDetections = 0;

    try {
      ({
        confirmedCount,
        cancelledCount,
        cancelledHref,
        currentConfirmedList,
      } = await confirmedCycleService.processConfirmedCycle({
        page,
        naverUrl,
        workspace,
      }));
    } catch (err: any) {
      log(`⚠️ (상시) 오늘 확정 처리 실패: ${err.message}`);
      if (err?.stack) {
        const stackPreview = String(err.stack)
          .split('\n')
          .slice(0, 6)
          .join(' | ');
        log(`🧵 오늘 확정 처리 실패 stack: ${stackPreview}`);
      }
      try { await safeGotoNaverHome(page, naverUrl, 'confirmed-cycle-recovery'); } catch (_) {}
    }

    let currentCancelledList: Record<string, any>[] = [];
    if (process.env.PICKKO_CANCEL_ENABLE === '1') {
      try {
        ({ currentCancelledList, cycleNewCancelDetections } = await cancelDetectionService.processCancelTab({
          page,
          cancelledHref,
          bizId,
          todaySeoul,
          naverUrl,
          cycleNewCancelDetections,
        }));
      } catch (err: any) {
        log(`⚠️ 취소 탭 처리 중 오류: ${err.message}`);
        try { await safeGotoNaverHome(page, naverUrl, 'cancel-tab-recovery'); } catch (_) {}
      }
    }

    if (checkCount % 3 === 2 && process.env.PICKKO_CANCEL_ENABLE === '1' && cancelledHref) {
      try {
        cycleNewCancelDetections = await cancelDetectionService.processExpandedCancelled({
          page,
          cancelledHref,
          todaySeoul,
          naverUrl,
          cycleNewCancelDetections,
        });
      } catch (err: any) {
        log(`⚠️ [취소감지2E] 오류: ${err.message}`);
        try { await safeGotoNaverHome(page, naverUrl, 'expanded-cancel-recovery'); } catch (_) {}
      }
    }

    if (previousConfirmedList.length > 0 && process.env.PICKKO_CANCEL_ENABLE === '1') {
      try {
        cycleNewCancelDetections = await cancelDetectionService.reconcileDroppedConfirmed({
          previousConfirmedList,
          currentConfirmedList,
          currentCancelledList,
          todaySeoul,
          confirmedCount,
          pendingCancelMap,
          cycleNewCancelDetections,
        });
      } catch (err: any) {
        log(`⚠️ 확정→취소 감지 중 오류: ${err.message}`);
      }
    }

    const nextPreviousConfirmedList = currentConfirmedList;
    if (
      previousCancelledCount !== null &&
      cancelledCount > previousCancelledCount &&
      cycleNewCancelDetections === 0
    ) {
      const delta = cancelledCount - previousCancelledCount;
      log(`🚨 취소 카운터 증가 이상 감지: 오늘 취소 ${previousCancelledCount}→${cancelledCount} (+${delta}), 이번 사이클 신규 취소 처리 0건`);
      await sendAlert({
        type: 'error',
        title: '🚨 네이버 취소 카운터 증가 이상',
        date: todaySeoul,
        status: `오늘 취소 ${previousCancelledCount}→${cancelledCount}`,
        reason: `카운터는 ${delta}건 증가했지만 이번 사이클 신규 취소 처리 0건`,
        action: '취소 탭 / cancelled_keys / naver-monitor 로그를 즉시 확인하세요.',
      });
    } else if (
      previousCancelledCount !== null &&
      cancelledCount === previousCancelledCount &&
      cancelledCount > 0 &&
      cycleNewCancelDetections === 0
    ) {
      await resolveSystemAlertByTitle(
        '🚨 네이버 취소 카운터 증가 이상',
        `오늘 취소 ${cancelledCount}건으로 추가 증가 없이 안정화 확인`,
      );
    } else if (cancelledCount === 0) {
      await resolveSystemAlertByTitle(
        '🚨 네이버 취소 카운터 증가 이상',
        '오늘 취소=0, 취소 탭=0건 안정화 확인',
      );
    }

    const nextPreviousCancelledCount = cancelledCount;

    if (checkCount % 3 === 1) {
      try {
        cycleNewCancelDetections = await futureCancelService.processFutureCancelSnapshot({
          checkCount,
          cancelledHref,
          page,
          todaySeoul,
          naverUrl,
          pendingCancelMap,
          cycleNewCancelDetections,
        });
      } catch (err: any) {
        if (err.message !== 'cancelledHref 없음') {
          try { await safeGotoNaverHome(page, naverUrl, 'future-cancel-recovery'); } catch (_) {}
        }
        log(`⚠️ [취소감지4] 오류 — 스킵: ${err.message}`);
      }
    }

    const periodic = await cycleReportService.handlePeriodicReports({
      startTime,
      checkCount,
      currentConfirmedCount: currentConfirmedList.length,
      cancelledCount,
      lastHeartbeatTime,
      heartbeatIntervalMs,
      lastDailyReportDate,
      dailyStats,
    });
    await cycleReportService.markCycleIdle(checkCount);

    const cycleElapsed = Date.now() - cycleStart;
    const sleepMs = Math.max(0, monitorInterval - cycleElapsed);
    const remainingTime = Math.max(0, monitorDuration - (Date.now() - startTime));
    const remainingMinutes = Math.floor(remainingTime / 60000);
    const nextSec = Math.floor(sleepMs / 1000);
    log(`⏳ 다음 확인: ${nextSec}초 후 (사이클 소요: ${Math.floor(cycleElapsed / 1000)}초, 남은 시간: ${remainingMinutes}분)`);

    return {
      sleepMs,
      previousConfirmedList: nextPreviousConfirmedList,
      previousCancelledCount: nextPreviousCancelledCount,
      lastHeartbeatTime: periodic.lastHeartbeatTime,
      lastDailyReportDate: periodic.lastDailyReportDate,
      dailyStats: periodic.dailyStats,
      currentConfirmedCount: currentConfirmedList.length,
      cancelledCount,
    };
  }

  return {
    executeCycle,
  };
}
