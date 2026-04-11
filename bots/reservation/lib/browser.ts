import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import { getReservationBrowserConfig } from './runtime-config';

const HEADED_FLAG = path.join(__dirname, '..', '.playwright-headed');

function readLegacyHeadlessEnv(scope: string): string | undefined {
  if (scope === 'naver') return process.env.NAVER_HEADLESS;
  if (scope === 'pickko') return process.env.PICKKO_HEADLESS;
  return undefined;
}

export function isHeadedMode(scope = 'general'): boolean {
  if (process.env.PLAYWRIGHT_HEADLESS === 'false') return true;
  if (process.env.PLAYWRIGHT_HEADLESS === 'true') return false;

  const legacy = readLegacyHeadlessEnv(scope);
  if (legacy === '0' || legacy === 'false') return true;
  if (legacy === '1' || legacy === 'true') return false;

  return fs.existsSync(HEADED_FLAG);
}

export function getHeadlessMode(scope = 'general'): false | 'new' {
  return isHeadedMode(scope) ? false : 'new';
}

function getCommonBrowserArgs(scope = 'general'): string[] {
  const headed = isHeadedMode(scope);
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    ...(headed ? ['--window-position=0,25', '--window-size=2294,1380'] : []),
  ];
}

export function getPickkoLaunchOptions(): Record<string, unknown> {
  const runtime = getReservationBrowserConfig();
  const headed = isHeadedMode('pickko');
  const headless = getHeadlessMode('pickko');
  return {
    headless,
    defaultViewport: headed ? null : { width: 1920, height: 1080 },
    protocolTimeout: parseInt(process.env.PICKKO_PROTOCOL_TIMEOUT_MS || String(runtime.pickkoProtocolTimeoutMs), 10),
    args: getCommonBrowserArgs('pickko'),
  };
}

export function getNaverLaunchOptions({
  userDataDir,
  protocolTimeout = 30000,
}: {
  userDataDir?: string;
  protocolTimeout?: number;
} = {}): Record<string, unknown> {
  const headed = isHeadedMode('naver');
  return {
    headless: getHeadlessMode('naver'),
    pipe: false,
    defaultViewport: headed ? null : { width: 1920, height: 1080 },
    protocolTimeout,
    ...(userDataDir ? { userDataDir } : {}),
    args: [
      ...getCommonBrowserArgs('naver'),
      '--remote-debugging-port=0',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=TabDiscarding,Translate,BackForwardCache',
    ],
  };
}

export function setupDialogHandler(page: any, logger?: (message: string) => void): void {
  page.on('dialog', async (dialog) => {
    try {
      logger?.(`🧾 팝업 감지: ${dialog.message()}`);
      await dialog.accept();
      logger?.('✅ 팝업 확인');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.(`⚠️ 팝업 처리 실패: ${message}`);
    }
  });
}

export async function launchBrowserWithRetry(): Promise<any> {
  const runtime = getReservationBrowserConfig();
  const maxRetries = runtime.launchRetries;
  const options = getPickkoLaunchOptions();
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      return await puppeteer.launch(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[browser] 브라우저 실행 실패 (${attempt + 1}/${maxRetries}):`, message);
      if (attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, runtime.launchRetryDelayMs));
      }
    }
  }
  throw new Error(`[browser] 브라우저 실행 불가 — ${maxRetries}회 재시도 실패`);
}

export async function navigateWithTimeout(
  page: any,
  url: string,
  timeout = 30000,
): Promise<void> {
  const runtime = getReservationBrowserConfig();
  try {
    await page.goto(url, { timeout: timeout || runtime.navigationTimeoutMs, waitUntil: 'networkidle2' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if ((error as Error)?.name === 'TimeoutError' || message.includes('timeout')) {
      console.warn('[browser] 페이지 로드 타임아웃:', url);
      return;
    }
    throw error;
  }
}
