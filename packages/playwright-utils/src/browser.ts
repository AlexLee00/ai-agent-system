// @ts-nocheck
'use strict';

/**
 * packages/playwright-utils/src/browser.js — Puppeteer 브라우저 헬퍼
 * bots/reservation/lib/browser.js에서 복사 (원본 유지)
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const HEADED_FLAG = path.join(process.cwd(), 'bots', 'reservation', '.playwright-headed');

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

function getPickkoLaunchOptions() {
  const headed = isHeadedMode('pickko');
  return {
    headless: getHeadlessMode('pickko'),
    defaultViewport: headed ? null : { width: 1920, height: 1080 },
    protocolTimeout: parseInt(process.env.PICKKO_PROTOCOL_TIMEOUT_MS || '180000', 10),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      ...(headed ? ['--window-position=0,25', '--window-size=2294,1380'] : [])
    ]
  };
}

function setupDialogHandler(page, log) {
  page.on('dialog', async d => {
    try {
      log?.(`팝업 감지: ${d.message()}`);
      await d.accept();
      log?.('팝업 확인');
    } catch (e) { log?.(`팝업 처리 실패: ${e.message}`); }
  });
}

module.exports = { getPickkoLaunchOptions, getHeadlessMode, isHeadedMode, setupDialogHandler };
