type Logger = (message: string) => void;
const { normalizeKioskSlotEndTime } = require('./kiosk-monitor-helpers');

type ConnectBrowserFn = (options: { browserWSEndpoint: string }) => Promise<any>;
type LoginFn = (page: any) => Promise<boolean>;
type SelectBookingDateFn = (page: any, date: string) => Promise<boolean>;
type VerifyBlockFn = (page: any, room: string, start: string, end: string) => Promise<boolean>;
type RoundUpFn = (time: string) => string;
type DelayFn = (ms: number) => Promise<void>;

const VERIFY_BLOCK_STATE_TIMEOUT_MS = 90_000;
const VERIFY_SCREENSHOT_TIMEOUT_MS = 5_000;

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
    delay,
    bookingUrl,
    log,
  } = deps;

  async function withVerifyTimeout<T>(work: Promise<T>, label: string): Promise<T> {
    work.catch(() => null);
    return Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`${label}_timeout:${VERIFY_BLOCK_STATE_TIMEOUT_MS}`)), VERIFY_BLOCK_STATE_TIMEOUT_MS).unref();
      }),
    ]);
  }

  async function screenshotWithTimeout(page: any, options: Record<string, any>) {
    const screenshot = page.screenshot(options);
    screenshot.catch(() => null);
    return Promise.race([
      screenshot,
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error(`verify_screenshot_timeout:${VERIFY_SCREENSHOT_TIMEOUT_MS}`)), VERIFY_SCREENSHOT_TIMEOUT_MS).unref();
      }),
    ]);
  }

  async function verifyBlockStateInFreshPage(
    naverBrowser: any,
    entry: Record<string, any>,
    options: Record<string, any> = {},
  ): Promise<boolean> {
    try {
      return await withVerifyTimeout(verifyBlockStateInFreshPageInner(naverBrowser, entry, options), 'verify_block_state');
    } catch (error: any) {
      log(`⚠️ 검증용 페이지 확인 타임아웃/오류: ${entry?.date || '-'} ${entry?.start || '-'}~${entry?.end || '-'} (${error?.message || String(error)})`);
      return false;
    }
  }

  async function verifyBlockStateInFreshPageInner(
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
        await screenshotWithTimeout(verifyPage, { path: ssPath, fullPage: false }).catch(() => null);
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
      const verified = await verifyBlockInGrid(verifyPage, room, start, normalizeKioskSlotEndTime(end));
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
