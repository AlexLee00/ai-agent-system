// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const kst = require('../../../packages/core/lib/kst');
const { maskPhone } = require('../lib/formatting');
const { delay, log } = require('../lib/utils');
const {
  getReservationRuntimeFile,
  getReservationRuntimeDir,
} = require('../lib/runtime-paths');
const {
  buildCancelKey,
} = require('../lib/naver-reservation-helpers');
const { buildReservationCompositeKey } = require('../lib/reservation-key');
const {
  getReservation,
  findReservationByCompositeKey,
  findReservationBySlot,
  getReservationsBySlot,
  hideDuplicateReservationsForSlot,
  updateReservation,
  markSeen,
} = require('../lib/db');
const { createNaverListScrapeService } = require('../lib/naver-list-scrape-service');
const { createNaverPickkoRecoveryService } = require('../lib/naver-pickko-recovery-service');
const {
  buildCancelledRangeUrl,
  compareCancelShadow,
  dedupeCancelEvidence,
  scanUnifiedCancelledList,
} = require('../lib/unified-cancel-scanner');
const {
  appendCancelShadowSummary,
} = require('../lib/cancel-shadow-history');

const NAVER_URL = 'https://new.smartplace.naver.com/bizes/place/3990161';

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    json: argv.includes('--json'),
    force: argv.includes('--force'),
    record: argv.includes('--record'),
    browserWs: null,
    cancelledHref: null,
  };
  for (const arg of argv) {
    if (arg.startsWith('--browser-ws=')) args.browserWs = arg.slice('--browser-ws='.length);
    if (arg.startsWith('--cancelled-href=')) args.cancelledHref = arg.slice('--cancelled-href='.length);
  }
  return args;
}

async function findCancelledHref(page, naverUrl = NAVER_URL) {
  await page.goto(naverUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForNetworkIdle({ idleTime: 800, timeout: 10000 }).catch(() => null);
  const href = await page.evaluate(() => {
    for (const link of Array.from(document.querySelectorAll('a'))) {
      const anchor = link;
      const text = String(anchor.textContent || '').replace(/\s+/g, ' ').trim();
      const linkHref = String(anchor.href || '');
      if (text.includes('오늘 취소') && linkHref.includes('booking-list-view')) return linkHref;
    }
    return null;
  }).catch(() => null);
  if (href) return href;
  const bizId = naverUrl.match(/\/place\/(\d+)/)?.[1] || '';
  return `https://new.smartplace.naver.com/bizes/place/${bizId}/booking-list-view?status=CANCELLED&date=${kst.today()}`;
}

function buildEvidenceFromRows(rows, todaySeoul) {
  return dedupeCancelEvidence(rows, {
    buildCancelKey,
    todaySeoul,
    findTrackedReservation: (booking) => recoveryService.findTrackedReservationForCancelCandidate(booking),
  });
}

function sanitizeEvidence(entry) {
  const booking = entry.booking || {};
  return {
    ...entry,
    booking: {
      bookingId: booking.bookingId || null,
      phone: maskPhone(booking.phone || booking.phoneRaw || ''),
      date: booking.date || null,
      start: booking.start || null,
      end: booking.end || null,
      room: booking.room || null,
      raw: booking.raw ? {
        dateTimeText: booking.raw.dateTimeText || null,
        hostText: booking.raw.hostText || null,
      } : undefined,
    },
  };
}

function sanitizeDiff(diff) {
  return {
    ...diff,
    todayMissingInLegacy: diff.todayMissingInLegacy.map(sanitizeEvidence),
    todayMissingInUnified: diff.todayMissingInUnified.map(sanitizeEvidence),
    futureUnifiedOnly: diff.futureUnifiedOnly.map(sanitizeEvidence),
  };
}

const recoveryService = createNaverPickkoRecoveryService({
  getReservation,
  findReservationByCompositeKey,
  findReservationBySlot,
  getReservationsBySlot,
  hideDuplicateReservationsForSlot,
  updateReservation,
  markSeen,
  buildReservationCompositeKey,
  chooseCanonicalReservationIdForSlot: () => null,
  resolveAlertsByBooking: async () => {},
  sendAlert: async () => {},
  ragSaveReservation: async () => {},
  maskPhone,
  toKst: kst.toKST,
  log,
});

async function connectBrowser(browserWs) {
  const ws = browserWs || (fs.existsSync(getReservationRuntimeFile('naver-monitor-ws.txt'))
    ? fs.readFileSync(getReservationRuntimeFile('naver-monitor-ws.txt'), 'utf8').trim()
    : '');
  if (!ws) return null;
  return puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null, protocolTimeout: 30000 });
}

async function runCancelShadowDiff(options = {}) {
  const todaySeoul = kst.today();
  const runtimeLog = options.json
    ? (message) => console.error(message)
    : log;
  const listScrapeService = createNaverListScrapeService({ delay, log: runtimeLog });
  if (process.env.SKA_UNIFIED_CANCEL_SCANNER !== 'true' && !options.force) {
    return {
      ok: true,
      skipped: true,
      reason: 'SKA_UNIFIED_CANCEL_SCANNER_disabled',
      today: todaySeoul,
    };
  }

  const browser = await connectBrowser(options.browserWs);
  if (!browser) {
    return {
      ok: false,
      skipped: true,
      reason: 'naver_browser_ws_missing',
      wsFile: getReservationRuntimeFile('naver-monitor-ws.txt'),
      today: todaySeoul,
    };
  }

  let page;
  try {
    page = await browser.newPage();
    const cancelledHref = options.cancelledHref || await findCancelledHref(page);
    const unified = await scanUnifiedCancelledList({
      page,
      cancelledHref,
      startDate: todaySeoul,
      daysAhead: 60,
      limit: 300,
      delay,
      log: runtimeLog,
      scrapeNewestBookingsFromList: listScrapeService.scrapeNewestBookingsFromList,
      includeExpandedFallback: false,
      buildCancelKey,
      findTrackedReservation: (booking) => recoveryService.findTrackedReservationForCancelCandidate(booking),
    });

    const todayUrl = buildCancelledRangeUrl(cancelledHref, { startDate: todaySeoul, endDate: todaySeoul });
    await page.goto(todayUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    const todayRows = await listScrapeService.scrapeNewestBookingsFromList(page, 100);
    const legacy = await buildEvidenceFromRows(todayRows, todaySeoul);
    const diff = compareCancelShadow({
      unified: unified.evidence,
      legacy,
      today: todaySeoul,
    });
    return {
      ok: diff.ok,
      today: todaySeoul,
      cancelledHref,
      unified: {
        ok: unified.ok,
        skipped: unified.skipped || false,
        reason: unified.reason || null,
        rawCount: unified.rawCount,
      },
      diff: sanitizeDiff(diff),
      workspace: getReservationRuntimeDir(),
    };
  } finally {
    if (page) await page.close().catch(() => null);
    await browser.disconnect().catch(() => null);
  }
}

async function main() {
  const args = parseArgs();
  const result = await runCancelShadowDiff(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.skipped) {
    console.log(`cancel-shadow-diff skipped: ${result.reason}`);
  } else {
    console.log(`cancel-shadow-diff ${result.ok ? 'ok' : 'mismatch'} ${JSON.stringify(result.diff?.counts || {})}`);
  }
  if (args.record) {
    const summary = appendCancelShadowSummary(result);
    if (!args.json) console.log(`cancel-shadow-diff recorded ${summary.today}`);
  }
  process.exit(result.ok || result.skipped ? 0 : 1);
}

module.exports = {
  parseArgs,
  findCancelledHref,
  runCancelShadowDiff,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
  });
}
