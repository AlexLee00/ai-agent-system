const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const { delay, log } = require('../../lib/utils');
const { loadSecrets } = require('../../lib/secrets');
const { getReservationBrowserConfig } = require('../../lib/runtime-config');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../../lib/browser');
const { loginToPickko, fetchPickkoEntries } = require('../../lib/pickko');
const { publishReservationAlert } = require('../../lib/alert-client');
const { createErrorTracker } = require('../../lib/error-tracker');
const { getKioskBlock, upsertKioskBlock, recordKioskBlockAttempt, getKioskBlocksForDate, pruneOldKioskBlocks } = require('../../lib/db');
const { maskPhone, maskName } = require('../../lib/formatting');
const {
  fmtPhone,
  buildOpsAlertMessage,
  publishRetryableBlockAlert,
  publishKioskSuccessReport,
  journalBlockAttempt,
  roundUpToHalfHour,
  toClockMinutes,
  compareEntrySequence,
  waitForCustomerCooldown,
  markCustomerCooldown,
} = require('../../lib/kiosk-monitor-helpers');
const {
  updateAgentState,
  acquirePickkoLock,
  releasePickkoLock,
  isPickkoLocked,
  isManualPickkoPriorityActive,
} = require('../../lib/state-bus');
const { getReservationKioskMonitorConfig } = require('../../lib/runtime-config');
const { getReservationRuntimeDir, getReservationRuntimeFile } = require('../../lib/runtime-paths');
const { createKioskSlotRunnerService } = require('../../lib/kiosk-slot-runner-service');
const { createKioskAuditService } = require('../../lib/kiosk-audit-service');
const { createKioskVerifyService } = require('../../lib/kiosk-verify-service');
const { createKioskPickkoCycleService } = require('../../lib/kiosk-pickko-cycle-service');
const { createKioskNaverPhaseService } = require('../../lib/kiosk-naver-phase-service');
const { createKioskRuntimeService } = require('../../lib/kiosk-runtime-service');
const { createKioskPanelService } = require('../../lib/kiosk-panel-service');
const { createKioskCalendarService } = require('../../lib/kiosk-calendar-service');
const { createKioskSlotCalendarService } = require('../../lib/kiosk-slot-calendar-service');
const { createKioskBlockFlowService } = require('../../lib/kiosk-block-flow-service');
const { createKioskCliService } = require('../../lib/kiosk-cli-service');
const { createKioskMainService } = require('../../lib/kiosk-main-service');
const { createSkaReporter } = require('../../lib/ska-failure-reporter');

const SECRETS = loadSecrets();
const PICKKO_ID = SECRETS.pickko_id;
const PICKKO_PW = SECRETS.pickko_pw;
const NAVER_ID = SECRETS.naver_id;
const NAVER_PW = SECRETS.naver_pw;

const WORKSPACE = getReservationRuntimeDir();
const NAVER_WS_FILE = getReservationRuntimeFile('naver-monitor-ws.txt');
const BOOKING_URL = 'https://partner.booking.naver.com/bizes/596871/booking-calendar-view';
const KIOSK_MONITOR_RUNTIME = getReservationKioskMonitorConfig();
const BROWSER_RUNTIME = getReservationBrowserConfig();
const NAVER_SCHEDULE_TRACE_LOG = '/tmp/naver-schedule-trace.log';

function getTodayKST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

function nowKST() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace(' ', 'T') + '+09:00';
}

function appendScheduleTrace(kind: string, payload: Record<string, any>) {
  const line = JSON.stringify({
    ts: nowKST(),
    kind,
    ...payload,
  });
  fs.appendFileSync(NAVER_SCHEDULE_TRACE_LOG, `${line}\n`);
}

function attachNaverScheduleTrace(page: any, label = 'naver-page') {
  if (!process.env.NAVER_TRACE_SCHEDULE_API || page.__naverScheduleTraceAttached) return;
  page.__naverScheduleTraceAttached = true;

  page.on('request', (req: any) => {
    const url = req.url();
    if (!url.includes('api-partner.booking.naver.com')) return;
    if (!url.includes('/schedules')) return;

    appendScheduleTrace('request', {
      label,
      method: req.method(),
      url,
      headers: req.headers(),
      postData: req.postData() || null,
    });
    log(`🛰️ [trace:${label}] ${req.method()} ${url}`);
  });

  page.on('response', async (res: any) => {
    const url = res.url();
    if (!url.includes('api-partner.booking.naver.com')) return;
    if (!url.includes('/schedules')) return;

    let body = null;
    try {
      body = await res.text();
    } catch (err: any) {
      body = `[body_read_failed] ${err.message}`;
    }

    appendScheduleTrace('response', {
      label,
      url,
      status: res.status(),
      headers: res.headers(),
      body,
    });
    log(`🛰️ [trace:${label}] response ${res.status()} ${url}`);
  });
}

async function naverBookingLogin(page: any) {
  return kioskCalendarService.naverBookingLogin(page);
}

async function blockNaverSlot(page: any, entry: Record<string, any>) {
  return kioskBlockFlowService.blockNaverSlot(page, entry);
}

async function restoreAvailGoneSlot(page: any, room: string, start: string, endRounded: string) {
  return kioskBlockFlowService.restoreAvailGoneSlot(page, room, start, endRounded);
}

async function unblockNaverSlot(page: any, entry: Record<string, any>) {
  return kioskBlockFlowService.unblockNaverSlot(page, entry);
}

async function selectBookingDate(page: any, date: string) {
  return kioskCalendarService.selectBookingDate(page, date);
}

async function isSettingsPanelVisible(page: any) {
  return kioskPanelService.isSettingsPanelVisible(page);
}

async function waitForSettingsPanelClosed(page: any, timeoutMs = 8000) {
  return kioskPanelService.waitForSettingsPanelClosed(page, timeoutMs);
}

async function clickRoomAvailableSlot(page: any, roomRaw: string, startTime: string) {
  return kioskSlotCalendarService.clickRoomAvailableSlot(page, roomRaw, startTime);
}

async function clickRoomSuspendedSlot(page: any, roomRaw: string, startTime: string) {
  return kioskSlotCalendarService.clickRoomSuspendedSlot(page, roomRaw, startTime);
}

async function fillUnavailablePopup(page: any, date: string, start: string, end: string) {
  return kioskPanelService.fillUnavailablePopup(page, date, start, end);
}

async function selectTimeDropdown(page: any, timeStr: string, which: 'start' | 'end') {
  return kioskPanelService.selectTimeDropdown(page, timeStr, which);
}

async function fillAvailablePopup(page: any, date: string | null, start: string, end: string) {
  return kioskPanelService.fillAvailablePopup(page, date, start, end);
}

async function selectUnavailableStatus(page: any) {
  return kioskPanelService.selectUnavailableStatus(page);
}

async function selectAvailableStatus(page: any) {
  return kioskPanelService.selectAvailableStatus(page);
}

async function verifyBlockInGrid(page: any, roomRaw: string, start: string, end: string) {
  return kioskCalendarService.verifyBlockInGrid(page, roomRaw, start, end);
}

const kioskSlotRunnerService = createKioskSlotRunnerService({
  connectBrowser: (options: any) => puppeteer.connect(options),
  attachNaverScheduleTrace,
  naverBookingLogin,
  blockNaverSlot,
  unblockNaverSlot,
  verifyBlockStateInFreshPage,
  journalBlockAttempt,
  recordKioskBlockAttempt,
  publishRetryableBlockAlert,
  publishKioskSuccessReport,
  publishReservationAlert,
  buildOpsAlertMessage,
  getKioskBlock,
  upsertKioskBlock,
  nowKST,
  log,
});

const kioskAuditService = createKioskAuditService({
  launchBrowser: (options: any) => puppeteer.launch(options),
  connectBrowser: (options: any) => puppeteer.connect(options),
  delay,
  setupDialogHandler,
  loginToPickko,
  fetchPickkoEntries,
  attachNaverScheduleTrace,
  naverBookingLogin,
  selectBookingDate,
  verifyBlockInGrid,
  blockNaverSlot,
  unblockNaverSlot,
  publishReservationAlert,
  getKioskBlock,
  upsertKioskBlock,
  getKioskBlocksForDate,
  maskName,
  getTodayKST,
  nowKST,
  getPickkoLaunchOptions,
  browserProtocolTimeoutMs: parseInt(
    process.env.PICKKO_PROTOCOL_TIMEOUT_MS || String(BROWSER_RUNTIME.pickkoProtocolTimeoutMs),
    10,
  ),
  pickkoId: PICKKO_ID,
  pickkoPw: PICKKO_PW,
  bookingUrl: BOOKING_URL,
  log,
});

const kioskVerifyService = createKioskVerifyService({
  connectBrowser: (options: any) => puppeteer.connect(options),
  naverBookingLogin,
  selectBookingDate,
  verifyBlockInGrid,
  roundUpToHalfHour,
  delay,
  bookingUrl: BOOKING_URL,
  log,
});

const kioskPickkoCycleService = createKioskPickkoCycleService({
  log,
  delay,
  loginToPickko,
  fetchPickkoEntries,
  getKioskBlock,
  compareEntrySequence,
  maskName,
  maskPhone,
});

const kioskNaverPhaseService = createKioskNaverPhaseService({
  log,
  readWsFile: fs.readFileSync,
  connectBrowser: (options: any) => puppeteer.connect(options),
  attachNaverScheduleTrace,
  naverBookingLogin,
  upsertKioskBlock,
  journalBlockAttempt,
  publishRetryableBlockAlert,
  publishReservationAlert,
  buildOpsAlertMessage,
  fmtPhone,
  nowKST,
  waitForCustomerCooldown,
  markCustomerCooldown,
  runtimeConfig: KIOSK_MONITOR_RUNTIME,
  delay,
  blockNaverSlot,
  unblockNaverSlot,
  publishKioskSuccessReport,
  getKioskBlock,
  bookingUrl: BOOKING_URL,
});

const kioskRuntimeService = createKioskRuntimeService({
  log,
  pruneOldKioskBlocks,
  isManualPickkoPriorityActive,
  isPickkoLocked,
  acquirePickkoLock,
  releasePickkoLock,
  updateAgentState,
  launchBrowser: (options: any) => puppeteer.launch(options),
  getPickkoLaunchOptions,
  setupDialogHandler,
});

const kioskPanelService = createKioskPanelService({
  delay,
  log,
});

const kioskCalendarService = createKioskCalendarService({
  log,
  delay,
  bookingUrl: BOOKING_URL,
  naverId: NAVER_ID,
  naverPw: NAVER_PW,
  publishReservationAlert,
  getTodayKST,
});

const kioskSlotCalendarService = createKioskSlotCalendarService({
  log,
  delay,
  isSettingsPanelVisible: (page: any) => kioskPanelService.isSettingsPanelVisible(page),
});

const kioskBlockFlowService = createKioskBlockFlowService({
  log,
  delay,
  bookingUrl: BOOKING_URL,
  roundUpToHalfHour,
  toClockMinutes,
  maskName,
  selectBookingDate: (page: any, date: string) => kioskCalendarService.selectBookingDate(page, date),
  verifyBlockInGrid: (page: any, room: string, start: string, end: string) => kioskCalendarService.verifyBlockInGrid(page, room, start, end),
  clickRoomAvailableSlot: (page: any, room: string, start: string) => kioskSlotCalendarService.clickRoomAvailableSlot(page, room, start),
  clickRoomSuspendedSlot: (page: any, room: string, start: string) => kioskSlotCalendarService.clickRoomSuspendedSlot(page, room, start),
  fillUnavailablePopup: (page: any, date: string, start: string, end: string) => kioskPanelService.fillUnavailablePopup(page, date, start, end),
  fillAvailablePopup: (page: any, date: string | null, start: string, end: string) => kioskPanelService.fillAvailablePopup(page, date, start, end),
});

const kioskCliService = createKioskCliService({
  readWsEndpoint: () => {
    try { return fs.readFileSync(NAVER_WS_FILE, 'utf8').trim(); } catch (_) { return null; }
  },
  runBlockSlotOnly: ({ entry, wsEndpoint }: any) => kioskSlotRunnerService.runBlockSlotOnly({ entry, wsEndpoint }),
  runUnblockSlotOnly: ({ entry, wsEndpoint }: any) => kioskSlotRunnerService.runUnblockSlotOnly({ entry, wsEndpoint }),
  runAuditToday: ({ dateOverride, wsEndpoint }: any) => kioskAuditService.auditToday({ dateOverride, wsEndpoint }),
  runVerifySlotOnly: ({ entry, wsEndpoint }: any) => kioskVerifyService.verifySlotOnly({ entry, wsEndpoint }),
  log,
  publishReservationAlert,
});

const kioskMainService = createKioskMainService({
  getTodayKST,
  log,
  updateAgentState,
  prepareRuntime: ({ today }: any) => kioskRuntimeService.prepareRuntime({ today }),
  cleanupRuntime: ({ browser, lockAcquired }: any) => kioskRuntimeService.cleanupRuntime({ browser, lockAcquired }),
  preparePickkoCycle: ({ page, today, pickkoId, pickkoPw }: any) => kioskPickkoCycleService.preparePickkoCycle({ page, today, pickkoId, pickkoPw }),
  processNaverPhase: ({ wsFile, toBlockEntries, cancelledEntries, recordKioskBlockAttempt }: any) =>
    kioskNaverPhaseService.processNaverPhase({ wsFile, toBlockEntries, cancelledEntries, recordKioskBlockAttempt }),
  recordKioskBlockAttempt,
  wsFile: NAVER_WS_FILE,
  pickkoId: PICKKO_ID,
  pickkoPw: PICKKO_PW,
});

async function main() {
  return kioskMainService.runMainCycle();
}

async function blockSlotOnly(entry: Record<string, any>) {
  return kioskCliService.blockSlotOnly(entry);
}

async function auditToday(dateOverride: string | null = null) {
  return kioskCliService.auditToday(dateOverride);
}

async function unblockSlotOnly(entry: Record<string, any>) {
  return kioskCliService.unblockSlotOnly(entry);
}

async function verifyBlockStateInFreshPage(naverBrowser: any, entry: Record<string, any>, options: Record<string, any> = {}) {
  return kioskVerifyService.verifyBlockStateInFreshPage(naverBrowser, entry, options);
}

async function verifySlotOnly(entry: Record<string, any>) {
  return kioskCliService.verifySlotOnly(entry);
}

const KIOSK_ARGS = process.argv.slice(2).reduce((acc: Record<string, any>, arg: string) => {
  const [k, v] = arg.replace(/^--/, '').split('=');
  acc[k] = v !== undefined ? v : true;
  return acc;
}, {});

const kioskErrorTracker = createErrorTracker({
  label: 'kiosk-monitor',
  threshold: KIOSK_MONITOR_RUNTIME.errorTrackerThreshold,
  persist: true,
  onReport: createSkaReporter('jimmy'),
});

function runCli() {
  if (KIOSK_ARGS['block-slot']) {
    blockSlotOnly({
      name: KIOSK_ARGS.name || '고객',
      phoneRaw: (KIOSK_ARGS.phone || '00000000000').replace(/-/g, ''),
      date: KIOSK_ARGS.date,
      start: KIOSK_ARGS.start,
      end: KIOSK_ARGS.end,
      room: KIOSK_ARGS.room,
    }).then((code) => process.exit(code)).catch((err: any) => {
      log(`❌ block-slot 오류: ${err.message}`);
      process.exit(1);
    });
    return;
  }

  if (KIOSK_ARGS['verify-slot']) {
    verifySlotOnly({
      name: KIOSK_ARGS.name || '고객',
      date: KIOSK_ARGS.date,
      start: KIOSK_ARGS.start,
      end: KIOSK_ARGS.end,
      room: KIOSK_ARGS.room,
    }).then((code) => process.exit(code)).catch((err: any) => {
      log(`❌ verify-slot 오류: ${err.message}`);
      process.exit(1);
    });
    return;
  }

  if (KIOSK_ARGS['unblock-slot']) {
    unblockSlotOnly({
      name: KIOSK_ARGS.name || '고객',
      phoneRaw: (KIOSK_ARGS.phone || '00000000000').replace(/-/g, ''),
      date: KIOSK_ARGS.date,
      start: KIOSK_ARGS.start,
      end: KIOSK_ARGS.end,
      room: KIOSK_ARGS.room,
    }).then((code) => process.exit(code)).catch((err: any) => {
      log(`❌ unblock-slot 오류: ${err.message}`);
      process.exit(1);
    });
    return;
  }

  if (KIOSK_ARGS['audit-today'] || KIOSK_ARGS['audit-date']) {
    const auditDate = typeof KIOSK_ARGS['audit-date'] === 'string' ? KIOSK_ARGS['audit-date'] : null;
    auditToday(auditDate)
      .then(() => process.exit(0))
      .catch(async (err: any) => {
        await kioskCliService.handleAuditTodayFailure(err);
        process.exit(1);
      });
    return;
  }

  main()
    .then(() => kioskErrorTracker.success())
    .catch(async (err: any) => {
      log(`❌ 치명 오류: ${err.message}`);
      await kioskErrorTracker.fail(err);
      process.exit(1);
    });
}

module.exports = {
  getTodayKST,
  nowKST,
  appendScheduleTrace,
  attachNaverScheduleTrace,
  naverBookingLogin,
  blockNaverSlot,
  restoreAvailGoneSlot,
  unblockNaverSlot,
  selectBookingDate,
  isSettingsPanelVisible,
  waitForSettingsPanelClosed,
  clickRoomAvailableSlot,
  clickRoomSuspendedSlot,
  fillUnavailablePopup,
  selectTimeDropdown,
  fillAvailablePopup,
  selectUnavailableStatus,
  selectAvailableStatus,
  verifyBlockInGrid,
  main,
  blockSlotOnly,
  auditToday,
  unblockSlotOnly,
  verifyBlockStateInFreshPage,
  verifySlotOnly,
  runCli,
};

runCli();
