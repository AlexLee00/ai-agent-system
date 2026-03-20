const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { getReservationBrowserConfig } = require('./runtime-config');

const HEADED_FLAG = path.join(__dirname, '..', '.playwright-headed');

function readLegacyHeadlessEnv(scope) {
  if (scope === 'naver') return process.env.NAVER_HEADLESS;
  if (scope === 'pickko') return process.env.PICKKO_HEADLESS;
  return undefined;
}

function isHeadedMode(scope = 'general') {
  if (process.env.PLAYWRIGHT_HEADLESS === 'false') return true;
  if (process.env.PLAYWRIGHT_HEADLESS === 'true') return false;

  const legacy = readLegacyHeadlessEnv(scope);
  if (legacy === '0' || legacy === 'false') return true;
  if (legacy === '1' || legacy === 'true') return false;

  return fs.existsSync(HEADED_FLAG);
}

function getHeadlessMode(scope = 'general') {
  return isHeadedMode(scope) ? false : 'new';
}

function getCommonBrowserArgs(scope = 'general') {
  const headed = isHeadedMode(scope);
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    ...(headed ? ['--window-position=0,25', '--window-size=2294,1380'] : [])
  ];
}

function getPickkoLaunchOptions() {
  const runtime = getReservationBrowserConfig();
  const headed = isHeadedMode('pickko');
  const headless = getHeadlessMode('pickko');
  return {
    headless,
    defaultViewport: headed ? null : { width: 1920, height: 1080 },
    protocolTimeout: parseInt(process.env.PICKKO_PROTOCOL_TIMEOUT_MS || String(runtime.pickkoProtocolTimeoutMs), 10),
    args: getCommonBrowserArgs('pickko')
  };
}

function getNaverLaunchOptions({ userDataDir, protocolTimeout = 30000 } = {}) {
  const headed = isHeadedMode('naver');
  return {
    headless: getHeadlessMode('naver'),
    defaultViewport: headed ? null : { width: 1920, height: 1080 },
    protocolTimeout,
    ...(userDataDir ? { userDataDir } : {}),
    args: [
      ...getCommonBrowserArgs('naver'),
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=TabDiscarding,Translate,BackForwardCache'
    ]
  };
}

function setupDialogHandler(page, log) {
  page.on('dialog', async d => {
    try {
      log?.(`🧾 팝업 감지: ${d.message()}`);
      await d.accept();
      log?.('✅ 팝업 확인');
    } catch (e) { log?.(`⚠️ 팝업 처리 실패: ${e.message}`); }
  });
}

/**
 * 브라우저 실행 (최대 3회 재시도 + 2초 대기)
 * @returns {Promise<import('puppeteer').Browser>}
 */
async function launchBrowserWithRetry() {
  const runtime = getReservationBrowserConfig();
  const maxRetries = runtime.launchRetries;
  const opts = getPickkoLaunchOptions();
  for (let i = 0; i < maxRetries; i++) {
    try {
      const browser = await puppeteer.launch(opts);
      return browser;
    } catch (e) {
      console.warn(`[browser] 브라우저 실행 실패 (${i + 1}/${maxRetries}):`, e.message);
      if (i < maxRetries - 1) {
        await new Promise(r => setTimeout(r, runtime.launchRetryDelayMs));
      }
    }
  }
  throw new Error(`[browser] 브라우저 실행 불가 — ${maxRetries}회 재시도 실패`);
}

/**
 * 페이지 이동 (타임아웃 시 크래시 없이 계속 진행)
 * @param {import('puppeteer').Page} page
 * @param {string} url
 * @param {number} [timeout=30000]
 */
async function navigateWithTimeout(page, url, timeout = 30000) {
  const runtime = getReservationBrowserConfig();
  try {
    await page.goto(url, { timeout: timeout || runtime.navigationTimeoutMs, waitUntil: 'networkidle2' });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.message.includes('timeout')) {
      console.warn('[browser] 페이지 로드 타임아웃:', url);
      // 타임아웃이어도 DOM이 있을 수 있음 → 진행
    } else {
      throw e;
    }
  }
}

module.exports = {
  getPickkoLaunchOptions,
  getNaverLaunchOptions,
  getHeadlessMode,
  isHeadedMode,
  setupDialogHandler,
  launchBrowserWithRetry,
  navigateWithTimeout,
};
