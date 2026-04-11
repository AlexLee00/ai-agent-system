type Logger = (message: string) => void;

type ConnectBrowserFn = (options: { browserWSEndpoint: string }) => Promise<any>;
type LoginFn = (page: any) => Promise<boolean>;
type SelectBookingDateFn = (page: any, date: string) => Promise<boolean>;
type VerifyBlockFn = (page: any, room: string, start: string, end: string) => Promise<boolean>;
type RoundUpFn = (time: string) => string;
type DelayFn = (ms: number) => Promise<void>;

export type CreateKioskVerifyServiceDeps = {
  connectBrowser: ConnectBrowserFn;
  naverBookingLogin: LoginFn;
  selectBookingDate: SelectBookingDateFn;
  verifyBlockInGrid: VerifyBlockFn;
  roundUpToHalfHour: RoundUpFn;
  delay: DelayFn;
  bookingUrl: string;
  log: Logger;
};

export function createKioskVerifyService(deps: CreateKioskVerifyServiceDeps) {
  const {
    connectBrowser,
    naverBookingLogin,
    selectBookingDate,
    verifyBlockInGrid,
    roundUpToHalfHour,
    delay,
    bookingUrl,
    log,
  } = deps;

  async function verifyBlockStateInFreshPage(
    naverBrowser: any,
    entry: Record<string, any>,
    options: Record<string, any> = {},
  ): Promise<boolean> {
    const { date, start, end, room } = entry;
    const { capturePrefix = null } = options;
    const verifyPage = await naverBrowser.newPage();
    try {
      verifyPage.setDefaultTimeout(30000);
      await verifyPage.setViewport({ width: 1920, height: 1080 });

      const capture = async (stage: string) => {
        if (!capturePrefix) return null;
        const safeStage = String(stage || 'stage').replace(/[^a-z0-9_-]+/gi, '-');
        const ssPath = `/tmp/${capturePrefix}-${date}-${safeStage}.png`;
        await verifyPage.screenshot({ path: ssPath, fullPage: false }).catch(() => null);
        log(`📸 [${safeStage}] 스크린샷: ${ssPath}`);
        return ssPath;
      };

      const verifyLoggedIn = await naverBookingLogin(verifyPage);
      if (!verifyLoggedIn) {
        await capture('login-failed');
        return false;
      }

      await verifyPage.goto(bookingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
      await verifyPage.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => null);
      await delay(1200);
      await capture('calendar-open');
      const dateSelected = await selectBookingDate(verifyPage, date);
      if (!dateSelected) {
        log(`⚠️ 검증용 날짜 선택 실패: ${date}`);
        await capture('date-select-failed');
        return false;
      }
      await capture('date-selected');
      const verified = await verifyBlockInGrid(verifyPage, room, start, roundUpToHalfHour(end));
      await capture(verified ? 'verified' : 'verify-failed');
      return verified;
    } finally {
      try { await verifyPage.close(); } catch {}
    }
  }

  async function verifySlotOnly({
    entry,
    wsEndpoint,
  }: {
    entry: Record<string, any>;
    wsEndpoint?: string | null;
  }): Promise<number> {
    const { date, start, end, room, name = '고객' } = entry;
    log(`\n🔎 [verify-slot 모드] 네이버 상태 검증: ${name} ${date} ${start}~${end} ${room}`);

    if (!wsEndpoint) {
      log('⚠️ naver-monitor 미실행 (WS 파일 없음) — 검증 불가');
      return 1;
    }

    let naverBrowser: any = null;
    let exitCode = 1;
    try {
      naverBrowser = await connectBrowser({ browserWSEndpoint: wsEndpoint });
      log('✅ CDP 연결 성공');
      const verified = await verifyBlockStateInFreshPage(naverBrowser, entry, { capturePrefix: 'naver-verify' });
      log(`✅ [verify-slot 결과] ${verified ? '차단 확인됨' : '차단 확인 실패'}: ${date} ${start}~${end} ${room}`);
      exitCode = verified ? 0 : 1;
      return exitCode;
    } finally {
      if (naverBrowser) {
        try { naverBrowser.disconnect(); } catch {}
      }
    }
  }

  return {
    verifyBlockStateInFreshPage,
    verifySlotOnly,
  };
}
