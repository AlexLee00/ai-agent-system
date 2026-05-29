// @ts-nocheck
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');
const env = require('../../../../packages/core/lib/env');
const { getBlogNaverPublishAssistConfig } = require('../runtime-config.ts');
const {
  assertSafeScheduledAt,
  formatKstScheduleFields,
} = require('./scheduled-publish-policy.ts');

const BROWSER_CONNECT_TIMEOUT_MS = 5000;
const BROWSER_PROTOCOL_TIMEOUT_MS = 180000;
const NAVER_NAVIGATION_TIMEOUT_MS = 45000;
const BLOG_BROWSER_RUNTIME_DIR = env.AI_AGENT_WORKSPACE || path.join(os.homedir(), '.ai-agent-system', 'workspace');
const DEFAULT_NAVER_PROFILE_DIR = path.join(BLOG_BROWSER_RUNTIME_DIR, 'naver-profile');
const NAVER_MONITOR_WS_FILES = [
  process.env.BLOG_NAVER_MONITOR_WS_FILE || '',
  path.join(BLOG_BROWSER_RUNTIME_DIR, 'naver-monitor-ws.txt'),
  path.join(BLOG_BROWSER_RUNTIME_DIR, 'reservation', 'naver-monitor-ws.txt'),
].filter(Boolean);

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function expandHome(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function readNaverMonitorWsEndpoint() {
  for (const filePath of NAVER_MONITOR_WS_FILES) {
    try {
      const value = String(fs.readFileSync(filePath, 'utf8') || '').trim();
      if (value) return value;
    } catch {
      // try next runtime file
    }
  }
  return '';
}

function getPublishAssistConfig() {
  const runtime = getBlogNaverPublishAssistConfig();
  return {
    enabled: runtime.enabled === true || process.env.BLOG_NAVER_PUBLISH_ASSIST_ENABLED === 'true',
    blogId: String(runtime.blogId || process.env.BLOG_NAVER_BLOG_ID || 'cafe_library').trim(),
    writeUrlTemplate: String(runtime.writeUrlTemplate || process.env.BLOG_NAVER_WRITE_URL_TEMPLATE || 'https://blog.naver.com/PostWriteForm.naver?blogId={blogId}').trim(),
    browserHttpUrl: String(runtime.browserHttpUrl || process.env.BLOG_BROWSER_HTTP_URL || 'http://127.0.0.1:18791').trim(),
    browserWsEndpoint: String(runtime.browserWsEndpoint || process.env.BLOG_BROWSER_WS_ENDPOINT || '').trim(),
    browserToken: String(runtime.browserToken || process.env.BLOG_BROWSER_TOKEN || process.env.BLOG_GATEWAY_TOKEN || '').trim(),
    profileDir: expandHome(runtime.profileDir || process.env.BLOG_NAVER_PROFILE_DIR || DEFAULT_NAVER_PROFILE_DIR),
    typingDelayMs: Math.max(0, Number(runtime.typingDelayMs || process.env.BLOG_NAVER_TYPING_DELAY_MS || 2)),
    actionDelayMs: Math.max(0, Number(runtime.actionDelayMs || process.env.BLOG_NAVER_ACTION_DELAY_MS || 350)),
    minScheduleDays: Math.max(5, Number(runtime.minScheduleDays || process.env.BLOG_NAVER_MIN_SCHEDULE_DAYS || 5)),
    scheduleHour: Number(runtime.scheduleHour ?? process.env.BLOG_NAVER_SCHEDULE_HOUR ?? 7),
    scheduleMinute: Number(runtime.scheduleMinute ?? process.env.BLOG_NAVER_SCHEDULE_MINUTE ?? 0),
    clickFinalPublish: runtime.clickFinalPublish === true || process.env.BLOG_NAVER_CLICK_FINAL_PUBLISH === 'true',
  };
}

function buildWriteUrl(config = getPublishAssistConfig()) {
  const blogId = String(config.blogId || '').trim();
  return String(config.writeUrlTemplate || '')
    .replace(/\{blogId\}/g, encodeURIComponent(blogId));
}

async function fetchManagedBrowserWsEndpoint(config) {
  const wsFileEndpoint = readNaverMonitorWsEndpoint();
  if (wsFileEndpoint) return wsFileEndpoint;
  if (config.browserWsEndpoint) return config.browserWsEndpoint;
  if (!config.browserHttpUrl) return '';

  const baseUrl = config.browserHttpUrl.replace(/\/+$/, '');
  const headers = {};
  if (config.browserToken) headers.Authorization = `Bearer ${config.browserToken}`;

  const candidates = [
    `${baseUrl}/`,
    `${baseUrl}/json/version`,
    config.browserToken ? `${baseUrl}/json/version?token=${encodeURIComponent(config.browserToken)}` : '',
  ].filter(Boolean);

  for (const target of candidates) {
    try {
      const res = await fetch(target, {
        headers,
        signal: AbortSignal.timeout(BROWSER_CONNECT_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) {
        const error = new Error('managed_browser_auth_failed');
        error.code = 'managed_browser_auth_failed';
        throw error;
      }
      if (!res.ok) continue;
      const json = await res.json();
      if (json?.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
      if (json?.cdpUrl) {
        const versionRes = await fetch(`${String(json.cdpUrl).replace(/\/+$/, '')}/json/version`, {
          signal: AbortSignal.timeout(BROWSER_CONNECT_TIMEOUT_MS),
        });
        if (!versionRes.ok) continue;
        const version = await versionRes.json();
        if (version?.webSocketDebuggerUrl) return version.webSocketDebuggerUrl;
      }
    } catch (error) {
      if (error?.code === 'managed_browser_auth_failed') throw error;
    }
  }

  return '';
}

async function connectBrowser(config = getPublishAssistConfig()) {
  const wsEndpoint = await fetchManagedBrowserWsEndpoint(config);
  if (wsEndpoint) {
    const browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
      protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
    });
    return { browser, managed: true, mode: 'connect' };
  }

  const browser = await puppeteer.launch({
    headless: false,
    pipe: false,
    defaultViewport: null,
    protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
    userDataDir: config.profileDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--window-position=0,25',
      '--window-size=1600,1100',
    ],
  });
  return { browser, managed: false, mode: 'launch' };
}

async function disconnectBrowser(handle) {
  if (!handle?.browser) return;
  if (handle.managed) {
    await handle.browser.disconnect();
    return;
  }
  await handle.browser.close();
}

async function gotoWritePage(page, config = getPublishAssistConfig()) {
  const url = buildWriteUrl(config);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVER_NAVIGATION_TIMEOUT_MS });
  await page.waitForFunction(() => document.readyState !== 'loading', { timeout: 10000 }).catch(() => {});
  return url;
}

async function detectSecurityOrLoginInterruption(page) {
  return page.evaluate(() => {
    const text = String(document.body?.innerText || '');
    const href = String(location.href || '');
    const patterns = [
      /로그인/i,
      /captcha/i,
      /자동입력 방지/i,
      /보안문자/i,
      /본인확인/i,
      /2단계/i,
      /비정상적인 접근/i,
    ];
    const matched = patterns.find((pattern) => pattern.test(text) || pattern.test(href));
    return matched ? { blocked: true, reason: String(matched) } : { blocked: false, reason: '' };
  });
}

async function markEditable(page, role = 'body') {
  const script = `
    (() => {
      const targetRole = ${JSON.stringify(role)};
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 10 && rect.height > 10;
      };
      const titleSelectors = [
        '.se-title-text p',
        '.se-title-text [contenteditable="true"]',
        '[data-placeholder*="제목"]',
        'textarea[placeholder*="제목"]',
        'input[placeholder*="제목"]',
      ];
      const bodySelectors = [
        '.se-component-content div[contenteditable="true"]',
        '.se-section-text div[contenteditable="true"]',
        '.se-main-container div[contenteditable="true"]',
        'div[role="textbox"]',
        'div[contenteditable="true"]',
        'textarea',
      ];
      const selectors = targetRole === 'title' ? titleSelectors : bodySelectors;
      document.querySelectorAll('[data-naver-publish-assist-target]').forEach((node) => node.removeAttribute('data-naver-publish-assist-target'));
      for (const selector of selectors) {
        const nodes = Array.from(document.querySelectorAll(selector)).filter(isVisible);
        for (const node of nodes) {
          const text = String(node.innerText || node.textContent || node.getAttribute('placeholder') || '');
          if (targetRole === 'body' && /제목/.test(text) && nodes.length > 1) continue;
          node.setAttribute('data-naver-publish-assist-target', targetRole);
          return { ok: true, selector: '[data-naver-publish-assist-target]', tagName: node.tagName, textPreview: text.slice(0, 60) };
        }
      }
      return { ok: false, reason: targetRole + '_editor_not_found' };
    })()
  `;
  return page.evaluate(script);
}

async function focusMarkedEditable(page, role = 'body') {
  const marked = await markEditable(page, role);
  if (!marked.ok) return marked;
  const handle = await page.$('[data-naver-publish-assist-target]');
  if (!handle) return { ok: false, reason: `${role}_editor_handle_not_found` };
  await handle.click({ clickCount: 1 }).catch(() => {});
  return { ok: true, handle, marked };
}

async function typeIntoMarkedEditable(page, text = '', role = 'body', config = getPublishAssistConfig()) {
  const focused = await focusMarkedEditable(page, role);
  if (!focused.ok) return focused;
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await sleep(config.actionDelayMs);
  const raw = String(text || '');
  const chunkSize = 1000;
  for (let i = 0; i < raw.length; i += chunkSize) {
    await page.keyboard.type(raw.slice(i, i + chunkSize), { delay: config.typingDelayMs });
    await sleep(20);
  }
  return { ok: true, chars: raw.length };
}

async function clickTextButton(page, labels = [], options = {}) {
  const result = await page.evaluate((targetLabels) => {
    const labelsLower = targetLabels.map((label) => String(label || '').trim().toLowerCase()).filter(Boolean);
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], label, span, div'))
      .filter((node) => {
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        if (style.visibility === 'hidden' || style.display === 'none' || rect.width < 8 || rect.height < 8) return false;
        const text = String(node.innerText || node.textContent || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
        return labelsLower.some((label) => text === label || text.includes(label));
      });
    const target = candidates[0];
    if (!target) return { ok: false, reason: 'button_not_found' };
    target.setAttribute('data-naver-publish-assist-click-target', 'true');
    target.scrollIntoView({ block: 'center', inline: 'center' });
    return { ok: true, text: String(target.innerText || target.textContent || '').trim().slice(0, 80) };
  }, labels);
  if (!result.ok) return result;
  const handle = await page.$('[data-naver-publish-assist-click-target]');
  if (!handle) return { ok: false, reason: 'button_handle_not_found' };
  await handle.click({ delay: Number(options.delayMs || 20) }).catch(async () => {
    await page.evaluate(() => document.querySelector('[data-naver-publish-assist-click-target]')?.click());
  });
  await page.evaluate(() => document.querySelectorAll('[data-naver-publish-assist-click-target]').forEach((node) => node.removeAttribute('data-naver-publish-assist-click-target'))).catch(() => {});
  return result;
}

async function uploadImagesBestEffort(page, imagePaths = [], config = getPublishAssistConfig()) {
  const existing = (imagePaths || []).filter((filePath) => {
    try {
      return filePath && fs.existsSync(filePath);
    } catch {
      return false;
    }
  });
  if (!existing.length) return { ok: true, uploaded: 0, skipped: true };

  const imageButton = await clickTextButton(page, ['사진', '이미지', '파일'], { delayMs: 20 }).catch((error) => ({ ok: false, reason: error.message }));
  await sleep(config.actionDelayMs);
  const inputs = await page.$$('input[type="file"]');
  if (!inputs.length) return { ok: false, uploaded: 0, reason: imageButton?.reason || 'file_input_not_found' };
  await inputs[0].uploadFile(...existing);
  await sleep(config.actionDelayMs * 2);
  return { ok: true, uploaded: existing.length };
}

async function setScheduleBestEffort(page, scheduledAt, config = getPublishAssistConfig()) {
  assertSafeScheduledAt(scheduledAt, { minDays: config.minScheduleDays });
  const fields = formatKstScheduleFields(scheduledAt);

  const openPublishLayer = await clickTextButton(page, ['발행']).catch((error) => ({ ok: false, reason: error.message }));
  if (!openPublishLayer.ok) return { ok: false, reason: `publish_layer_open_failed:${openPublishLayer.reason}` };
  await sleep(config.actionDelayMs * 2);

  const scheduleToggle = await clickTextButton(page, ['예약', '예약 발행', '예약발행']).catch((error) => ({ ok: false, reason: error.message }));
  if (!scheduleToggle.ok) return { ok: false, reason: `schedule_toggle_failed:${scheduleToggle.reason}` };
  await sleep(config.actionDelayMs);

  const fillResult = await page.evaluate((scheduleFields) => {
    function setValue(el, value) {
      if (!el) return false;
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    const inputs = Array.from(document.querySelectorAll('input, select'));
    const dateInput = inputs.find((el) => /date|날짜|예약/.test(`${el.name || ''} ${el.id || ''} ${el.placeholder || ''}`) || el.type === 'date');
    const hourInput = inputs.find((el) => /hour|시/.test(`${el.name || ''} ${el.id || ''} ${el.placeholder || ''}`));
    const minuteInput = inputs.find((el) => /minute|분/.test(`${el.name || ''} ${el.id || ''} ${el.placeholder || ''}`));
    const dateOk = dateInput ? setValue(dateInput, scheduleFields.date) : false;
    const hourOk = hourInput ? setValue(hourInput, scheduleFields.hour) : false;
    const minuteOk = minuteInput ? setValue(minuteInput, scheduleFields.minute) : false;
    return { dateOk, hourOk, minuteOk, inputCount: inputs.length };
  }, fields);

  return {
    ok: fillResult.dateOk || fillResult.hourOk || fillResult.minuteOk,
    fields,
    fillResult,
    reason: (fillResult.dateOk || fillResult.hourOk || fillResult.minuteOk) ? '' : 'schedule_fields_not_found',
  };
}

async function verifyReservationMode(page, scheduledAt, config = getPublishAssistConfig()) {
  assertSafeScheduledAt(scheduledAt, { minDays: config.minScheduleDays });
  return page.evaluate(() => {
    const text = String(document.body?.innerText || '');
    const hasSchedule = /예약|예약 발행|예약발행/.test(text);
    const hasImmediateOnly = /즉시\s*발행/.test(text) && !hasSchedule;
    return {
      ok: hasSchedule && !hasImmediateOnly,
      hasSchedule,
      hasImmediateOnly,
      textPreview: text.slice(0, 800),
    };
  });
}

async function runNaverScheduledPublishAssist({ document, scheduledAt, apply = false, confirm = '', dryRun = true, config: configOverride = null } = {}) {
  const config = configOverride || getPublishAssistConfig();
  assertSafeScheduledAt(scheduledAt, { minDays: config.minScheduleDays });
  const plan = {
    ok: true,
    dryRun: !apply || dryRun,
    apply: !!apply,
    confirmRequired: 'naver-scheduled-publish-assist',
    confirmed: confirm === 'naver-scheduled-publish-assist',
    blogId: config.blogId,
    writeUrl: buildWriteUrl(config),
    schedule: formatKstScheduleFields(scheduledAt),
    title: document?.title || '',
    blockCount: document?.blocks?.length || 0,
    imageCount: document?.imagePaths?.length || 0,
    charCount: document?.plainText?.length || 0,
    actions: [
      'open_naver_write_page',
      'type_title',
      'type_body',
      'upload_images_best_effort',
      'open_publish_layer',
      'select_schedule_publish',
      'set_schedule_at_min_5_days',
      'click_final_publish_when_confirmed',
      'record_naver_scheduled_review',
    ],
  };
  if (!apply || dryRun) return { ...plan, status: 'dry_run_plan' };
  if (confirm !== 'naver-scheduled-publish-assist') {
    return { ...plan, ok: false, status: 'confirm_required' };
  }
  if (!config.enabled) {
    return { ...plan, ok: false, status: 'disabled', reason: 'BLOG_NAVER_PUBLISH_ASSIST_ENABLED false' };
  }
  if (!config.clickFinalPublish) {
    return { ...plan, ok: false, status: 'final_publish_click_disabled', reason: 'BLOG_NAVER_CLICK_FINAL_PUBLISH false' };
  }

  const handle = await connectBrowser(config);
  let page;
  try {
    page = await handle.browser.newPage();
    await gotoWritePage(page, config);
    const interruption = await detectSecurityOrLoginInterruption(page);
    if (interruption.blocked) return { ...plan, ok: false, status: 'manual_login_required', interruption };

    const titleResult = await typeIntoMarkedEditable(page, document.title, 'title', config);
    if (!titleResult.ok) return { ...plan, ok: false, status: 'title_input_failed', titleResult };

    const bodyResult = await typeIntoMarkedEditable(page, document.plainText, 'body', config);
    if (!bodyResult.ok) return { ...plan, ok: false, status: 'body_input_failed', bodyResult };

    const imageResult = await uploadImagesBestEffort(page, document.imagePaths || [], config);
    const scheduleResult = await setScheduleBestEffort(page, scheduledAt, config);
    if (!scheduleResult.ok) return { ...plan, ok: false, status: 'schedule_setup_failed', imageResult, scheduleResult };

    const reservationCheck = await verifyReservationMode(page, scheduledAt, config);
    if (!reservationCheck.ok) return { ...plan, ok: false, status: 'reservation_mode_not_verified', imageResult, scheduleResult, reservationCheck };

    const finalClick = await clickTextButton(page, ['발행', '예약 발행', '확인']).catch((error) => ({ ok: false, reason: error.message }));
    if (!finalClick.ok) return { ...plan, ok: false, status: 'final_publish_click_failed', imageResult, scheduleResult, reservationCheck, finalClick };
    await sleep(config.actionDelayMs * 2);

    return {
      ...plan,
      status: 'naver_scheduled_publish_submitted',
      browserMode: handle.mode,
      imageResult,
      scheduleResult,
      reservationCheck,
      finalClick,
      pageUrl: page.url(),
    };
  } finally {
    await disconnectBrowser(handle).catch(() => {});
  }
}

module.exports = {
  getPublishAssistConfig,
  buildWriteUrl,
  connectBrowser,
  disconnectBrowser,
  runNaverScheduledPublishAssist,
  detectSecurityOrLoginInterruption,
  verifyReservationMode,
  setScheduleBestEffort,
  typeIntoMarkedEditable,
};
