type Logger = (message: string) => void;

export type CreateNaverBrowserSessionServiceDeps = {
  log: Logger;
  launchPuppeteer: (args: Record<string, any>) => Promise<any>;
  getNaverLaunchOptions: (args: Record<string, any>) => Record<string, any>;
  waitForWsEndpointFromActivePort: (userDataDir: string, delay: (ms: number) => Promise<void>, timeoutMs?: number) => Promise<string | null>;
  waitForDevtoolsEndpoint: (wsEndpoint: string, delay: (ms: number) => Promise<void>, timeoutMs?: number) => Promise<boolean>;
  delay: (ms: number) => Promise<void>;
  writeFileSync: (path: string, contents: string, encoding?: BufferEncoding) => void;
  unlinkSync: (path: string) => void;
  pathJoin: (...parts: string[]) => string;
  isHeadedMode: (scope?: string) => boolean;
  naverLogin: (page: any) => Promise<boolean>;
};

export function createNaverBrowserSessionService(deps: CreateNaverBrowserSessionServiceDeps) {
  const {
    log,
    launchPuppeteer,
    getNaverLaunchOptions,
    waitForWsEndpointFromActivePort,
    waitForDevtoolsEndpoint,
    delay,
    writeFileSync,
    unlinkSync,
    pathJoin,
    isHeadedMode,
    naverLogin,
  } = deps;

  async function startBrowserSession({
    workspace,
    modeSuffix,
    naverUrl,
    naverWsFile,
    naverUserDataDir,
  }: {
    workspace: string;
    modeSuffix: string;
    naverUrl: string;
    naverWsFile: string;
    naverUserDataDir?: string;
  }) {
    const resolvedNaverUserDataDir =
      naverUserDataDir || pathJoin(workspace, `naver-profile${modeSuffix}`);
    try { unlinkSync(pathJoin(resolvedNaverUserDataDir, 'DevToolsActivePort')); } catch (_) {}

    const browser = await launchPuppeteer(getNaverLaunchOptions({
      protocolTimeout: 30000,
      userDataDir: resolvedNaverUserDataDir,
    }));

    const wsEndpoint =
      (await waitForWsEndpointFromActivePort(resolvedNaverUserDataDir, delay, 10000)) ||
      browser.wsEndpoint();
    const devtoolsReady = await waitForDevtoolsEndpoint(wsEndpoint, delay, 3000);
    if (!devtoolsReady) {
      throw new Error(`DevTools endpoint unavailable: ${wsEndpoint}`);
    }

    try { writeFileSync(naverWsFile, wsEndpoint, 'utf8'); } catch (_) {}
    log('📡 CDP 엔드포인트 저장됨 (kiosk-monitor 연결용)');

    const isHeadless = !isHeadedMode('naver');
    let pageMain = null;
    let page = null;

    if (!isHeadless) {
      pageMain = await browser.newPage();
      page = await browser.newPage();

      await pageMain.setViewport({ width: 1920, height: 1080 });
      await page.setViewport({ width: 1920, height: 1080 });

      await pageMain.goto(naverUrl, { waitUntil: 'domcontentloaded' }).catch(() => null);
      log('🧷 메인 탭(pageMain) 고정: 이 탭은 건드리지 않습니다. (자동화는 다른 탭에서 진행)');
    } else {
      page = await browser.newPage();
      await page.setViewport({ width: 1920, height: 1080 });
      log('🫥 Headless 모드: 단일 탭으로 모니터링 진행');
    }

    const loggedIn = await naverLogin(page);
    if (!loggedIn) {
      return {
        browser,
        page,
        pageMain,
        isHeadless,
        loggedIn: false,
      };
    }

    return {
      browser,
      page,
      pageMain,
      isHeadless,
      loggedIn: true,
    };
  }

  return {
    startBrowserSession,
  };
}
