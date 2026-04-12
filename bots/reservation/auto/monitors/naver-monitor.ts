#!/usr/bin/env node

const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const { transformAndNormalizeData } = require('../../lib/validation');
const { delay, log } = require('../../lib/utils');
const { loadSecrets, getSecret, initHubSecrets } = require('../../lib/secrets');
const { publishReservationAlert } = require('../../lib/alert-client');
const { createErrorTracker } = require('../../lib/error-tracker');
const { printModeBanner, getModeSuffix } = require('../../lib/mode');
const { recordHeartbeat, markStopped } = require('../../lib/status');
const { registerShutdownHandlers, isShuttingDown } = require('../../lib/health');
const {
  isSeenId, markSeen, addReservation, updateReservation, getReservation, findReservationByBooking,
  findReservationByCompositeKey, findReservationBySlot, getReservationsBySlot, hideDuplicateReservationsForSlot,
  rollbackProcessing, pruneOldReservations,
  isCancelledKey, addCancelledKey, pruneOldCancelledKeys,
  addAlert, updateAlertSent, resolveAlert, resolveAlertsByTitle, getUnresolvedAlerts, pruneOldAlerts,
  getTodayStats,
  upsertFutureConfirmed, getStaleConfirmed, deleteStaleConfirmed, pruneOldFutureConfirmed,
} = require('../../lib/db');
const fs = require('fs');
const path = require('path');
const { maskPhone } = require('../../lib/formatting');
const { buildReservationId, buildReservationCompositeKey } = require('../../lib/reservation-key');
const { saveJson } = require('../../lib/files');
const { formatVipBadge } = require('../../lib/vip');
const { updateAgentState } = require('../../lib/state-bus');
const { getNaverLaunchOptions, isHeadedMode } = require('../../lib/browser');
const { getReservationNaverMonitorConfig } = require('../../lib/runtime-config');
const {
  chooseCanonicalReservationIdForSlot,
} = require('../../lib/naver-monitor-helpers');
const {
  isTerminalReservationLike,
  getAlertLevelByType,
  buildMonitoringTrackingKey,
  buildSlotCompositeKey,
  fillMissingBookingDate,
  buildConfirmedListKey,
  buildCancelKey,
} = require('../../lib/naver-reservation-helpers');
const {
  buildMonitorAlertMessage,
  buildUnresolvedAlertsSummary,
} = require('../../lib/naver-alert-helpers');
const { createNaverMonitorService } = require('../../lib/naver-monitor-service');
const { createNaverPickkoRecoveryService } = require('../../lib/naver-pickko-recovery-service');
const { createNaverPickkoRunnerService } = require('../../lib/naver-pickko-runner-service');
const { createNaverListScrapeService } = require('../../lib/naver-list-scrape-service');
const { createNaverSessionService } = require('../../lib/naver-session-service');
const { createNaverCycleReportService } = require('../../lib/naver-cycle-report-service');
const { createNaverBookingStateService } = require('../../lib/naver-booking-state-service');
const { createNaverCandidateService } = require('../../lib/naver-candidate-service');
const { createNaverFutureCancelService } = require('../../lib/naver-future-cancel-service');
const { createNaverCancelDetectionService } = require('../../lib/naver-cancel-detection-service');
const { createNaverConfirmedCycleService } = require('../../lib/naver-confirmed-cycle-service');
const { createNaverMonitorCycleService } = require('../../lib/naver-monitor-cycle-service');
const { createNaverBrowserSessionService } = require('../../lib/naver-browser-session-service');
const { createNaverDetachedRecoveryService } = require('../../lib/naver-detached-recovery-service');
const {
  buildPickkoCancelArgs,
  buildPickkoAccurateArgs,
  buildPickkoCancelManualMessage,
  buildPickkoRetryExceededMessage,
  buildPickkoTimeElapsedMessage,
  buildPickkoManualFailureMessage,
} = require('../../lib/naver-pickko-runner-helpers');
const kst = require('../../../../packages/core/lib/kst');
const { writeHeartbeat } = require('../../../../packages/core/lib/agent-heartbeats');
const { IS_OPS } = require('../../../../packages/core/lib/env');
const rag = require('../../../../packages/core/lib/rag-safe');
const { storeReservationEvent } = require('../../../../packages/core/lib/reservation-rag');

const WORKSPACE = path.join(process.env.HOME, '.openclaw', 'workspace');
const HEADED_FLAG_PATH = path.join(__dirname, '..', '..', '.playwright-headed');
const NAVER_WS_FILE = path.join(WORKSPACE, 'naver-monitor-ws.txt');
const NAVER_URL = 'https://new.smartplace.naver.com/bizes/place/3990161';
const MODE = IS_OPS ? 'ops' : 'dev';
const MONITOR_INTERVAL = parseInt(process.env.NAVER_INTERVAL_MS || (MODE === 'ops' ? '300000' : '120000'), 10);
const MONITOR_DURATION = 2 * 60 * 60 * 1000;
const NAVER_MONITOR_RUNTIME = getReservationNaverMonitorConfig();
const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000;
const MAX_RETRIES = NAVER_MONITOR_RUNTIME.maxRetries;

const bugReportCache = new Set<string>();

let previousConfirmedList: any[] = [];
let previousCancelledCount: number | null = null;
const pendingCancelMap = new Map<string, any>();
let lastHeartbeatTime = Date.now();
let dailyStats = { date: '', detected: 0, completed: 0, cancelled: 0, failed: 0 };
let lastDailyReportDate = '';

function ensureHeadedFlag(reason = 'unknown') {
  try {
    if (!fs.existsSync(HEADED_FLAG_PATH)) {
      fs.writeFileSync(HEADED_FLAG_PATH, `${kst.datetimeStr()} ${reason}\n`, 'utf8');
      log(`👀 headed 플래그 생성: ${HEADED_FLAG_PATH} (${reason})`);
    }
  } catch (err: any) {
    log(`⚠️ headed 플래그 생성 실패: ${err.message}`);
  }
}

function autoBugReport({
  title,
  desc,
  severity = 'high',
  category = 'reliability',
}: {
  title: string;
  desc: string;
  severity?: string;
  category?: string;
}) {
  const cacheKey = `${title.slice(0, 50)}:${kst.today()}`;
  if (bugReportCache.has(cacheKey)) {
    log(`[버그리포트] 중복 방지 (오늘 이미 등록됨): ${title}`);
    return;
  }
  bugReportCache.add(cacheKey);

  const child = spawn('node', [
    path.join(__dirname, 'bug-report.js'),
    '--new', '--title', title,
    '--desc', desc,
    '--severity', severity,
    '--by', 'ska',
    '--category', category,
  ], { cwd: path.join(__dirname, '..'), stdio: 'ignore' });

  child.on('close', (code: number) => {
    log(`[버그리포트] ${code === 0 ? '✅ 자동 등록 완료' : '⚠️ 등록 실패'}: ${title}`);
  });
  child.on('error', (e: any) => {
    log(`[버그리포트] ⚠️ 실행 오류: ${e.message}`);
  });
}

function runStartupPickkoVerification() {
  if (!NAVER_MONITOR_RUNTIME.verifyBeforeUnresolvedReport) return;

  try {
    const verifyScript = path.join(__dirname, '../../manual/admin/pickko-verify.js');
    log('🔎 [시작 검증] pickko-verify 백그라운드 실행');
    const child = spawn('node', [verifyScript], {
      cwd: path.join(__dirname, '../../manual/admin'),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: any) => {
      stderr += String(chunk || '');
      if (stderr.length > 1200) stderr = stderr.slice(-1200);
    });
    child.on('error', (err: any) => {
      log(`⚠️ [시작 검증] pickko-verify 실행 실패: ${err.message}`);
    });
    child.on('close', (code: number) => {
      if (code === 0) {
        log('✅ [시작 검증] pickko-verify 완료');
        return;
      }
      log(`⚠️ [시작 검증] pickko-verify 비정상 종료 (exit=${code})`);
      if (stderr.trim()) log(stderr.trim().slice(0, 400));
    });
  } catch (err: any) {
    log(`⚠️ [시작 검증] pickko-verify 예외: ${err.message}`);
  }
}

async function closePopupsIfPresent(page: any) {
  return naverSessionService.closePopupsIfPresent(page);
}

async function ensureHomeFromCalendar(page: any) {
  return naverSessionService.ensureHomeFromCalendar(page);
}

async function naverLogin(page: any) {
  return naverSessionService.naverLogin(page);
}

async function cleanupExpiredSeen() {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const removed = await pruneOldReservations(cutoffStr);
    if (removed > 0) {
      log(`🧹 개인정보 자동 정리: 만료 예약 ${removed}건 삭제 (7일 경과)`);
    }
    const ckCutoff = new Date();
    ckCutoff.setDate(ckCutoff.getDate() - 90);
    const ckCutoffStr = ckCutoff.toISOString().slice(0, 10);
    const removedCk = await pruneOldCancelledKeys(ckCutoffStr);
    if (removedCk > 0) {
      log(`🧹 개인정보 자동 정리: 취소 키 ${removedCk}건 삭제 (90일 경과)`);
    }
  } catch (err: any) {
    log(`⚠️ cleanupExpiredSeen 오류: ${err.message}`);
  }
}

const naverMonitorService = createNaverMonitorService({
  workspace: WORKSPACE,
  log,
  publishReservationAlert,
  findReservationByBooking,
  resolveAlert,
  resolveAlertsByTitle,
  getUnresolvedAlerts,
  addAlert,
  updateAlertSent,
  pruneOldAlerts,
  cleanupExpiredSeen,
  isTerminalReservationLike,
  getAlertLevelByType,
  maskPhone,
  toKst: kst.toKST,
  buildMonitorAlertMessage,
  buildUnresolvedAlertsSummary,
});
const {
  resolveAlertsByBooking,
  resolveSystemAlertByTitle,
  reportUnresolvedAlerts,
  sendAlert,
} = naverMonitorService;

async function ragSaveReservation(booking: any, status = '신규') {
  return naverBookingStateService.ragSaveReservation(booking, status);
}

async function rollbackProcessingEntries() {
  return naverBookingStateService.rollbackProcessingEntries();
}

async function updateBookingState(bookingId: any, booking: any, state = 'pending') {
  return naverBookingStateService.updateBookingState(bookingId, booking, state, dailyStats);
}

const naverPickkoRecoveryService = createNaverPickkoRecoveryService({
  getReservation,
  findReservationByCompositeKey,
  findReservationBySlot,
  getReservationsBySlot,
  hideDuplicateReservationsForSlot,
  updateReservation,
  markSeen,
  buildReservationCompositeKey,
  chooseCanonicalReservationIdForSlot,
  resolveAlertsByBooking,
  sendAlert,
  ragSaveReservation,
  maskPhone,
  toKst: kst.toKST,
  log,
});

const {
  shouldProcessCancelledBooking,
  reconcileSlotDuplicatesAfterRecovery,
  verifyRecoverablePickkoFailure,
} = naverPickkoRecoveryService;

const naverPickkoRunnerService = createNaverPickkoRunnerService({
  isCancelledKey,
  getReservation,
  markSeen,
  resolveAlertsByBooking,
  updateBookingState,
  updateReservation,
  addCancelledKey,
  sendAlert,
  ragSaveReservation,
  publishReservationAlert,
  autoBugReport,
  transformAndNormalizeData,
  verifyRecoverablePickkoFailure,
  reconcileSlotDuplicatesAfterRecovery,
  buildPickkoCancelArgs,
  buildPickkoAccurateArgs,
  buildPickkoCancelManualMessage,
  buildPickkoRetryExceededMessage,
  buildPickkoTimeElapsedMessage,
  buildPickkoManualFailureMessage,
  maskPhone,
  toKst: kst.toKST,
  log,
});

async function scrapeExpandedCancelled(page: any, cancelHref: string) {
  return naverListScrapeService.scrapeExpandedCancelled(page, cancelHref);
}

async function scrapeNewestBookingsFromList(page: any, limit = 5) {
  return naverListScrapeService.scrapeNewestBookingsFromList(page, limit);
}

function runPickkoCancel(booking: any) {
  return naverPickkoRunnerService.runPickkoCancel({
    booking,
    scriptsDir: __dirname,
    manualCancelScriptPath: path.join(__dirname, '../../manual/reservation/pickko-cancel.js'),
    onCancelled: () => { dailyStats.cancelled++; },
  });
}

function runPickko(booking: any, bookingId: any = null) {
  return naverPickkoRunnerService.runPickko({
    booking,
    bookingId,
    scriptsDir: __dirname,
    accurateScriptPath: path.join(__dirname, '../../manual/reservation/pickko-accurate.js'),
    maxRetries: MAX_RETRIES,
  });
}

const naverListScrapeService = createNaverListScrapeService({ delay, log });
const naverSessionService = createNaverSessionService({
  delay,
  log,
  publishReservationAlert,
  getSecret,
  isHeadedMode,
  ensureHeadedFlag,
  naverUrl: NAVER_URL,
});
const naverCycleReportService = createNaverCycleReportService({
  log,
  publishReservationAlert,
  getTodayStats,
  updateAgentState,
  writeHeartbeat,
  recordHeartbeat,
});
const naverBookingStateService = createNaverBookingStateService({
  log,
  maskPhone,
  toKst: kst.toKST,
  getReservation,
  addReservation,
  updateReservation,
  rollbackProcessing,
  buildReservationCompositeKey,
  storeReservationEvent,
  rag,
});
const naverCandidateService = createNaverCandidateService({
  log,
  fillMissingBookingDate,
  buildMonitoringTrackingKey,
  buildSlotCompositeKey,
  getReservation,
  findReservationByCompositeKey,
  findReservationBySlot,
  isSeenId,
  markSeen,
  resolveAlertsByBooking,
  updateBookingState,
  sendAlert,
  ragSaveReservation,
  runPickko,
  buildReservationId,
  formatVipBadge,
  maskPhone,
  mode: MODE,
  naverUrl: NAVER_URL,
});
const naverFutureCancelService = createNaverFutureCancelService({
  delay,
  log,
  maskPhone,
  isCancelledKey,
  addCancelledKey,
  upsertFutureConfirmed,
  getStaleConfirmed,
  deleteStaleConfirmed,
  pruneOldFutureConfirmed,
  runPickkoCancel,
  scrapeNewestBookingsFromList,
  runtimeConfig: NAVER_MONITOR_RUNTIME,
});
const naverCancelDetectionService = createNaverCancelDetectionService({
  delay,
  log,
  maskPhone,
  buildCancelKey,
  buildConfirmedListKey,
  isCancelledKey,
  addCancelledKey,
  shouldProcessCancelledBooking,
  runPickkoCancel,
  scrapeNewestBookingsFromList,
  scrapeExpandedCancelled,
});
const naverConfirmedCycleService = createNaverConfirmedCycleService({
  delay,
  log,
  saveJson,
  scrapeNewestBookingsFromList,
  processConfirmedCandidates: ({ newest, page }: { newest: any[]; page: any }) =>
    naverCandidateService.processConfirmedCandidates({ newest, page }),
});
const naverMonitorCycleService = createNaverMonitorCycleService({
  log,
  ensureHomeFromCalendar,
  naverLogin,
  closePopupsIfPresent,
  confirmedCycleService: naverConfirmedCycleService,
  cancelDetectionService: naverCancelDetectionService,
  futureCancelService: naverFutureCancelService,
  cycleReportService: naverCycleReportService,
  sendAlert,
  resolveSystemAlertByTitle,
  publishReservationAlert,
  pathJoin: path.join,
  getModeSuffix,
  delay,
});
const naverBrowserSessionService = createNaverBrowserSessionService({
  log,
  launchPuppeteer: (args: any) => puppeteer.launch(args),
  getNaverLaunchOptions,
  waitForWsEndpointFromActivePort: require('../../lib/naver-monitor-helpers').waitForWsEndpointFromActivePort,
  waitForDevtoolsEndpoint: require('../../lib/naver-monitor-helpers').waitForDevtoolsEndpoint,
  delay,
  writeFileSync: fs.writeFileSync,
  unlinkSync: fs.unlinkSync,
  pathJoin: path.join,
  isHeadedMode,
  naverLogin,
});
const naverDetachedRecoveryService = createNaverDetachedRecoveryService({
  log,
  rollbackProcessingEntries,
  naverLogin,
});

async function monitorBookings() {
  const LOCK_FILE = path.join(WORKSPACE, `naver-monitor${getModeSuffix()}.lock`);
  if (fs.existsSync(LOCK_FILE)) {
    const oldPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
    if (oldPid && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 0);
        log(`🔍 구 프로세스 발견 (PID: ${oldPid}) → 종료 중...`);
        process.kill(oldPid, 'SIGTERM');
        await delay(2000);
        try { process.kill(oldPid, 'SIGKILL'); } catch (_e) {}
        log(`✅ 구 프로세스 종료 완료 (PID: ${oldPid})`);
      } catch (_e) {
        log(`ℹ️ 구 프로세스 이미 종료됨 (PID: ${oldPid})`);
      }
    }
    fs.unlinkSync(LOCK_FILE);
  }

  try {
    fs.openSync(LOCK_FILE, 'wx');
    fs.writeFileSync(LOCK_FILE, String(process.pid));
  } catch (e: any) {
    log(`⚠️ 락 파일 생성 실패: ${e.message}`);
    return;
  }

  registerShutdownHandlers({ locks: [LOCK_FILE], waitMs: 15000 });

  let browser: any;
  let page: any;
  const startTime = Date.now();
  let checkCount = 0;
  let detachRetryCount = 0;
  let sleepMs = MONITOR_INTERVAL;
  const errorTracker = createErrorTracker({
    label: 'naver-monitor',
    threshold: NAVER_MONITOR_RUNTIME.errorTrackerThreshold,
  });

  try {
    printModeBanner('naver-monitor');
    recordHeartbeat({ status: 'starting' });
    log('🚀 네이버 예약 모니터링 시작 (2시간)');

    runStartupPickkoVerification();
    await reportUnresolvedAlerts();

    const browserSession = await naverBrowserSessionService.startBrowserSession({
      workspace: WORKSPACE,
      modeSuffix: getModeSuffix(),
      naverUrl: NAVER_URL,
      naverWsFile: NAVER_WS_FILE,
    });
    browser = browserSession.browser;
    page = browserSession.page;

    if (!browserSession.loggedIn) {
      log('❌ 로그인 실패로 종료');
      return;
    }

    while (Date.now() - startTime < MONITOR_DURATION && !isShuttingDown()) {
      checkCount++;
      recordHeartbeat({ status: 'running' });
      await updateAgentState('andy', 'running', `모니터링 사이클 #${checkCount}`);

      try {
        ({
          sleepMs,
          previousConfirmedList,
          previousCancelledCount,
          lastHeartbeatTime,
          lastDailyReportDate,
          dailyStats,
        } = await naverMonitorCycleService.executeCycle({
          page,
          checkCount,
          startTime,
          monitorInterval: MONITOR_INTERVAL,
          monitorDuration: MONITOR_DURATION,
          naverUrl: NAVER_URL,
          workspace: WORKSPACE,
          headedFlagPath: HEADED_FLAG_PATH,
          previousConfirmedList,
          previousCancelledCount,
          pendingCancelMap,
          lastHeartbeatTime,
          heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
          lastDailyReportDate,
          dailyStats,
        }));

        detachRetryCount = 0;
        errorTracker.success();
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
      } catch (err: any) {
        log(`❌ 루프 오류: ${err.message}`);
        await errorTracker.fail(err);
        await naverCycleReportService.markCycleError(checkCount, err);

        const msg = String(err.message || '');
        if (/detached/i.test(msg) || /Connection closed/i.test(msg)) {
          detachRetryCount++;
          const recovery = await naverDetachedRecoveryService.recoverDetachedPage({
            page,
            browser,
            detachRetryCount,
          });
          page = recovery.page;
          if (recovery.shouldExit) {
            process.exit(1);
          }
          continue;
        }

        await new Promise((resolve) => setTimeout(resolve, MONITOR_INTERVAL));
      }
    }

    log('\n✅ 모니터링 완료 (2시간 경과)');
    log(`📊 총 ${checkCount}회 확인 수행`);
  } catch (err: any) {
    log(`❌ 치명적 오류: ${err.message}`);
    await updateAgentState('andy', 'error', null, err.message);
  } finally {
    const isHeadless = !isHeadedMode('naver');
    if (browser) {
      if (isHeadless) {
        await browser.close();
        log('🔌 브라우저 종료');
      } else {
        log('🟢 headed 디버그 상태: 브라우저를 닫지 않고 유지합니다(수동 확인/2단계 대비).');
      }
    }

    try { fs.unlinkSync(NAVER_WS_FILE); } catch (_e) {}
    try { fs.unlinkSync(path.join(WORKSPACE, `naver-monitor${getModeSuffix()}.lock`)); } catch (_e) {}
  }
}

async function runCli() {
  await initHubSecrets();
  return monitorBookings();
}

module.exports = {
  ensureHeadedFlag,
  autoBugReport,
  runStartupPickkoVerification,
  closePopupsIfPresent,
  ensureHomeFromCalendar,
  naverLogin,
  cleanupExpiredSeen,
  ragSaveReservation,
  rollbackProcessingEntries,
  updateBookingState,
  scrapeExpandedCancelled,
  scrapeNewestBookingsFromList,
  runPickkoCancel,
  runPickko,
  monitorBookings,
  runCli,
};

runCli()
  .then(() => markStopped({ reason: '정상 종료' }))
  .catch(async (err: any) => {
    log(`❌ 예상치 못한 오류: ${err.message}`);
    markStopped({ reason: err.message, error: true });
    await rollbackProcessingEntries();
    process.exit(1);
  });
