type Logger = (message: string) => void;
type DelayFn = (ms: number) => Promise<void>;
type ScrapeNewestBookingsFromListFn = (page: any, maxItems?: number) => Promise<Record<string, any>[]>;
type BuildCancelKeyFn = (booking: Record<string, any>, todaySeoul?: string | null) => string;
type FindTrackedReservationFn = (booking: Record<string, any>) => Promise<Record<string, any> | null>;

const kst = require('../../../packages/core/lib/kst');

export type UnifiedCancelEvidence = {
  cancelKey: string;
  booking: Record<string, any>;
  date: string;
  tracked: boolean;
  trackedReservationId: string | null;
  source: 'unified_cancel_scanner';
};

export type UnifiedCancelScanResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  scanUrl?: string;
  startDate: string;
  endDate: string;
  rawCount: number;
  evidence: UnifiedCancelEvidence[];
};

export type CancelShadowDiff = {
  ok: boolean;
  today: string;
  counts: {
    unified: number;
    legacy: number;
    todayMissingInLegacy: number;
    todayMissingInUnified: number;
    futureUnifiedOnly: number;
  };
  todayMissingInLegacy: UnifiedCancelEvidence[];
  todayMissingInUnified: UnifiedCancelEvidence[];
  futureUnifiedOnly: UnifiedCancelEvidence[];
};

function addDaysKst(dateStr: string, days: number): string {
  const base = new Date(`${dateStr}T00:00:00+09:00`);
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000)
    .toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

export function buildCancelledRangeUrl(cancelledHref: string, {
  startDate = kst.today(),
  daysAhead = 60,
  endDate = addDaysKst(startDate, daysAhead),
  dateDropdownType = 'RANGE',
}: {
  startDate?: string;
  daysAhead?: number;
  endDate?: string;
  dateDropdownType?: string;
} = {}): string {
  if (!cancelledHref) throw new Error('cancelledHref_required');
  const url = new URL(cancelledHref);
  url.search = '';
  url.searchParams.set('bookingStatusCodes', 'RC04');
  url.searchParams.set('dateDropdownType', dateDropdownType);
  url.searchParams.set('dateFilter', 'USEDATE');
  url.searchParams.set('startDateTime', startDate);
  url.searchParams.set('endDateTime', endDate);
  url.searchParams.set('searchValueCode', 'USER_NAME');
  return url.toString();
}

export async function inspectCancelListSoft200(page: any): Promise<{
  ok: boolean;
  reason?: string;
  rows: number;
  noData: boolean;
}> {
  return page.evaluate(() => {
    const bodyText = String(document.body?.innerText || document.body?.textContent || '');
    const rows = document.querySelectorAll('a[class*="contents-user"]').length;
    const noDataEl = document.querySelector('[class*="nodata-area"], [class*="nodata"], .nodata') as HTMLElement | null;
    const noData = !!noDataEl && noDataEl.offsetParent !== null;
    const loginLike = /로그인|login|인증|세션 만료|권한이 없습니다/i.test(bodyText);
    const errorLike = /일시적인 오류|페이지를 찾을 수|서비스 점검|새로고침/i.test(bodyText);
    if (loginLike) return { ok: false, reason: 'login_required', rows, noData };
    if (errorLike && rows === 0 && !noData) return { ok: false, reason: 'soft_200_error_page', rows, noData };
    if (rows === 0 && !noData) return { ok: false, reason: 'empty_without_nodata', rows, noData };
    return { ok: true, rows, noData };
  });
}

function normalizeDate(value: unknown): string {
  return String(value || '').trim();
}

export async function dedupeCancelEvidence(rows: Record<string, any>[], {
  buildCancelKey,
  todaySeoul = kst.today(),
  findTrackedReservation,
}: {
  buildCancelKey: BuildCancelKeyFn;
  todaySeoul?: string;
  findTrackedReservation?: FindTrackedReservationFn;
}): Promise<UnifiedCancelEvidence[]> {
  const seen = new Set<string>();
  const out: UnifiedCancelEvidence[] = [];
  for (const booking of rows) {
    const cancelKey = buildCancelKey(booking, todaySeoul);
    if (!cancelKey || seen.has(cancelKey)) continue;
    seen.add(cancelKey);
    const tracked = findTrackedReservation
      ? await findTrackedReservation(booking).catch(() => null)
      : null;
    out.push({
      cancelKey,
      booking,
      date: normalizeDate(booking.date),
      tracked: !!tracked,
      trackedReservationId: tracked?.id ? String(tracked.id) : null,
      source: 'unified_cancel_scanner',
    });
  }
  return out;
}

export async function scanUnifiedCancelledList({
  page,
  cancelledHref,
  startDate = kst.today(),
  daysAhead = 60,
  includeTodayExact = true,
  limit = 300,
  delay = async () => {},
  log = () => {},
  scrapeNewestBookingsFromList,
  buildCancelKey,
  findTrackedReservation,
}: {
  page: any;
  cancelledHref: string;
  startDate?: string;
  daysAhead?: number;
  includeTodayExact?: boolean;
  limit?: number;
  delay?: DelayFn;
  log?: Logger;
  scrapeNewestBookingsFromList: ScrapeNewestBookingsFromListFn;
  buildCancelKey: BuildCancelKeyFn;
  findTrackedReservation?: FindTrackedReservationFn;
}): Promise<UnifiedCancelScanResult> {
  const endDate = addDaysKst(startDate, daysAhead);
  const scanUrl = buildCancelledRangeUrl(cancelledHref, { startDate, endDate });
  log(`🔎 [통합취소스캐너] 취소 RANGE 스캔: ${startDate}~${endDate}`);
  await page.goto(scanUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector(
    'a[class*="contents-user"], [class*="nodata-area"], [class*="nodata"], .nodata',
    { timeout: 20000 },
  ).catch(() => null);
  await delay(500);

  const soft = await inspectCancelListSoft200(page).catch((error: any) => ({
    ok: false,
    reason: `soft_200_probe_failed:${error?.message || String(error)}`,
    rows: 0,
    noData: false,
  }));
  if (!soft.ok) {
    log(`🛡️ [통합취소스캐너] soft-200 가드 스킵: ${soft.reason}`);
    return {
      ok: false,
      skipped: true,
      reason: soft.reason,
      scanUrl,
      startDate,
      endDate,
      rawCount: 0,
      evidence: [],
    };
  }

  const rows = await scrapeNewestBookingsFromList(page, limit);
  let combinedRows = rows;
  if (includeTodayExact && startDate === kst.today()) {
    const todayUrl = buildCancelledRangeUrl(cancelledHref, { startDate, endDate: startDate });
    log(`🔎 [통합취소스캐너] 오늘 취소 보강 스캔: ${startDate}`);
    await page.goto(todayUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector(
      'a[class*="contents-user"], [class*="nodata-area"], [class*="nodata"], .nodata',
      { timeout: 20000 },
    ).catch(() => null);
    await delay(500);
    const todaySoft = await inspectCancelListSoft200(page).catch(() => ({ ok: false }));
    if (todaySoft.ok) {
      const todayRows = await scrapeNewestBookingsFromList(page, Math.min(limit, 100));
      combinedRows = [...todayRows, ...rows];
    } else {
      log('⚠️ [통합취소스캐너] 오늘 취소 보강 스캔 soft-200 실패 — 기간 스캔 결과만 사용');
    }
  }
  const evidence = await dedupeCancelEvidence(combinedRows, {
    buildCancelKey,
    todaySeoul: startDate,
    findTrackedReservation,
  });
  return {
    ok: true,
    scanUrl,
    startDate,
    endDate,
    rawCount: combinedRows.length,
    evidence,
  };
}

export function compareCancelShadow({
  unified,
  legacy,
  today = kst.today(),
}: {
  unified: UnifiedCancelEvidence[];
  legacy: UnifiedCancelEvidence[];
  today?: string;
}): CancelShadowDiff {
  const legacyKeys = new Set(legacy.map((entry) => entry.cancelKey));
  const unifiedKeys = new Set(unified.map((entry) => entry.cancelKey));
  const todayUnified = unified.filter((entry) => entry.date === today);
  const todayLegacy = legacy.filter((entry) => entry.date === today);

  const todayMissingInLegacy = todayUnified.filter((entry) => !legacyKeys.has(entry.cancelKey));
  const todayMissingInUnified = todayLegacy.filter((entry) => !unifiedKeys.has(entry.cancelKey));
  const futureUnifiedOnly = unified.filter((entry) => entry.date > today && !legacyKeys.has(entry.cancelKey));

  return {
    ok: todayMissingInLegacy.length === 0 && todayMissingInUnified.length === 0,
    today,
    counts: {
      unified: unified.length,
      legacy: legacy.length,
      todayMissingInLegacy: todayMissingInLegacy.length,
      todayMissingInUnified: todayMissingInUnified.length,
      futureUnifiedOnly: futureUnifiedOnly.length,
    },
    todayMissingInLegacy,
    todayMissingInUnified,
    futureUnifiedOnly,
  };
}
