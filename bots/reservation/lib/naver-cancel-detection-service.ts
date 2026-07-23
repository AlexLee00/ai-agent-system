type Logger = (message: string) => void;
type DelayFn = (ms: number) => Promise<void>;
type MaskPhoneFn = (phone: string) => string;
type BuildCancelKeyFn = (booking: Record<string, any>, todaySeoul?: string | null) => string;
type IsCancelledKeyFn = (key: string) => Promise<boolean>;
type AddCancelledKeyFn = (key: string) => Promise<any>;
type TrackedCancelledBooking = boolean | Record<string, any> | null | undefined;
type ShouldProcessCancelledBookingFn = (booking: Record<string, any>) => Promise<TrackedCancelledBooking>;
type RunPickkoCancelFn = (booking: Record<string, any>, bookingId?: string | null) => Promise<any>;
type ScrapeNewestBookingsFromListFn = (page: any, maxItems?: number) => Promise<Record<string, any>[]>;
type ScrapeStatusListFn = (page: any, sourceUrl: string, options?: Record<string, any>) => Promise<Record<string, any>[]>;

export type CreateNaverCancelDetectionServiceDeps = {
  delay: DelayFn;
  log: Logger;
  maskPhone: MaskPhoneFn;
  buildCancelKey: BuildCancelKeyFn;
  isCancelledKey: IsCancelledKeyFn;
  addCancelledKey: AddCancelledKeyFn;
  shouldProcessCancelledBooking: ShouldProcessCancelledBookingFn;
  runPickkoCancel: RunPickkoCancelFn;
  scrapeNewestBookingsFromList: ScrapeNewestBookingsFromListFn;
  scrapeCancelledStatusList?: ScrapeStatusListFn;
  scrapeConfirmedStatusList?: ScrapeStatusListFn;
};

export function createNaverCancelDetectionService(deps: CreateNaverCancelDetectionServiceDeps) {
  const {
    delay,
    log,
    maskPhone,
    buildCancelKey,
    isCancelledKey,
    addCancelledKey,
    shouldProcessCancelledBooking,
    runPickkoCancel,
    scrapeNewestBookingsFromList,
    scrapeCancelledStatusList,
    scrapeConfirmedStatusList,
  } = deps;

  function isTodayCancelledCandidate(candidate: Record<string, any>, todaySeoul: string): boolean {
    return String(candidate?.date || '').trim() === todaySeoul;
  }

  function isCancelledTrackedReservation(tracked: TrackedCancelledBooking): boolean {
    if (!tracked || typeof tracked !== 'object') return false;
    return Boolean(
      tracked.status === 'cancelled'
      || ['time_elapsed', 'cancelled'].includes(String(tracked.pickkoStatus || tracked.pickko_status || '')),
    );
  }

  function formatTrackedState(tracked: TrackedCancelledBooking): string {
    if (!tracked || typeof tracked !== 'object') return 'unknown';
    return `${tracked.status || '-'} / ${tracked.pickkoStatus || tracked.pickko_status || '-'}`;
  }

  function withTrackedBookingId(candidate: Record<string, any>, tracked: TrackedCancelledBooking): Record<string, any> {
    if (candidate.bookingId || !tracked || typeof tracked !== 'object' || !tracked.id) return candidate;
    return { ...candidate, bookingId: tracked.id };
  }

  function normalizePhone(value: any): string {
    return String(value || '').replace(/\D+/g, '');
  }

  function normalizeRoom(value: any): string {
    const text = String(value || '').toUpperCase();
    if (text.includes('A1')) return 'A1';
    if (text.includes('A2')) return 'A2';
    if (text.includes('B')) return 'B';
    return text.trim();
  }

  function isSameBooking(a: Record<string, any>, b: Record<string, any>): boolean {
    const aId = String(a.bookingId || a.booking_id || '').trim();
    const bId = String(b.bookingId || b.booking_id || '').trim();
    if (aId && bId && aId === bId) return true;
    return (
      normalizePhone(a.phoneRaw || a.phone || a.phone_raw) === normalizePhone(b.phoneRaw || b.phone || b.phone_raw)
      && String(a.date || '').trim() === String(b.date || '').trim()
      && String(a.start || a.start_time || '').trim() === String(b.start || b.start_time || '').trim()
      && String(a.end || a.end_time || '').trim() === String(b.end || b.end_time || '').trim()
      && normalizeRoom(a.room) === normalizeRoom(b.room)
    );
  }

  function hasConfirmedAliveMatch(candidate: Record<string, any>, confirmedList: Record<string, any>[]): boolean {
    return confirmedList.some((confirmed) => isSameBooking(candidate, confirmed));
  }

  async function processConfirmedAbsentCancelCandidate({
    candidate,
    cancelKey,
    cycleNewCancelDetections,
    sourceLabel,
  }: {
    candidate: Record<string, any>;
    cancelKey: string;
    cycleNewCancelDetections: number;
    sourceLabel: string;
  }): Promise<number> {
    const tracked = await shouldProcessCancelledBooking(candidate);
    const alreadyRecorded = await isCancelledKey(cancelKey);
    if (alreadyRecorded) {
      if (!tracked || isCancelledTrackedReservation(tracked)) return cycleNewCancelDetections;
      log(`🧹 [${sourceLabel}] stale 취소키 감지 — DB 상태는 ${formatTrackedState(tracked)} 이므로 픽코 취소 계속 진행: ${maskPhone(candidate.phone || candidate.phoneRaw)} ${candidate.date} ${candidate.start}~${candidate.end} ${candidate.room || ''}`);
    }
    if (!tracked) {
      await addCancelledKey(cancelKey);
      log(`ℹ️ [${sourceLabel}] 미추적 취소건 키 등록 후 픽코 취소 스킵: ${maskPhone(candidate.phone || candidate.phoneRaw)} ${candidate.date} ${candidate.start}~${candidate.end} ${candidate.room || ''} (DB 추적 없음)`);
      return cycleNewCancelDetections + 1;
    }
    const result = await runPickkoCancel(withTrackedBookingId(candidate, tracked), cancelKey);
    if (result === 0) {
      await addCancelledKey(cancelKey);
      return cycleNewCancelDetections + 1;
    }
    log(`🛡️ [${sourceLabel}] 픽코 취소 미완료(exit ${result}) — 취소 key 등록 보류: ${maskPhone(candidate.phone || candidate.phoneRaw)} ${candidate.date} ${candidate.start}~${candidate.end}`);
    return cycleNewCancelDetections;
  }

  async function processCancelTab({
    page,
    cancelledHref,
    bizId,
      todaySeoul,
      naverUrl,
      cycleNewCancelDetections,
      currentConfirmedList = [],
    }: {
      page: any;
      cancelledHref: string | null;
      bizId: string;
      todaySeoul: string;
      naverUrl: string;
      cycleNewCancelDetections: number;
      currentConfirmedList?: Record<string, any>[];
    }): Promise<{ currentCancelledList: Record<string, any>[]; cycleNewCancelDetections: number }> {
    const cancelHref = cancelledHref || `https://new.smartplace.naver.com/bizes/place/${bizId}/booking-list-view?status=CANCELLED&date=${todaySeoul}`;
    log(`🔗 오늘 취소 탭 이동: ${cancelHref}`);
    await page.goto(cancelHref, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector(
      'a[class*="contents-user"], [class*="nodata-area"], [class*="nodata"], .nodata',
      { timeout: 20000 },
    ).catch(() => null);
    await delay(500);

    const cancelledList = await scrapeNewestBookingsFromList(page, 20);
    log(`🗑️ 오늘 취소 탭: ${cancelledList.length}건`);

    if (cancelledList.length > 0) {
      let actionableCancels = 0;
      for (const candidate of cancelledList) {
        if (!isTodayCancelledCandidate(candidate, todaySeoul)) {
          log(`🛡️ [취소탭] 오늘자 외 취소 후보 자동 처리 차단: ${maskPhone(candidate.phone || candidate.phoneRaw)} ${candidate.date} ${candidate.start}~${candidate.end} ${candidate.room || ''}`);
          continue;
        }
        if (hasConfirmedAliveMatch(candidate, currentConfirmedList)) {
          log(`🛡️ [취소탭] RC03 확정 생존 확인 → 픽코 취소 금지: ${maskPhone(candidate.phone || candidate.phoneRaw)} ${candidate.date} ${candidate.start}~${candidate.end} ${candidate.room || ''}`);
          continue;
        }
        const cancelKey = buildCancelKey(candidate, todaySeoul);
        const tracked = await shouldProcessCancelledBooking(candidate);
        const alreadyRecorded = await isCancelledKey(cancelKey);
        if (alreadyRecorded) {
          if (!tracked || isCancelledTrackedReservation(tracked)) continue;
          log(`🧹 [취소탭] stale 취소키 감지 — DB 상태는 ${formatTrackedState(tracked)} 이므로 픽코 취소 계속 진행: ${maskPhone(candidate.phone || candidate.phoneRaw)} ${candidate.date} ${candidate.start}~${candidate.end} ${candidate.room || ''}`);
        }
        actionableCancels += 1;
        if (!tracked) {
          await addCancelledKey(cancelKey);
          cycleNewCancelDetections += 1;
          log(`ℹ️ [취소탭] 미추적 취소건 키 등록 후 픽코 취소 스킵: ${maskPhone(candidate.phone || candidate.phoneRaw)} ${candidate.date} ${candidate.start}~${candidate.end} ${candidate.room || ''} (DB 추적 없음)`);
          continue;
        }
        const result = await runPickkoCancel(withTrackedBookingId(candidate, tracked), cancelKey);
        if (result === 0) {
          await addCancelledKey(cancelKey);
          cycleNewCancelDetections += 1;
        } else {
          log(`🛡️ [취소탭] 픽코 취소 미완료(exit ${result}) — 취소 key 등록 보류: ${maskPhone(candidate.phone || candidate.phoneRaw)} ${candidate.date} ${candidate.start}~${candidate.end}`);
        }
      }
      if (actionableCancels === 0) log('ℹ️ 취소 탭 신규 취소 없음');
    }

    await page.goto(naverUrl, { waitUntil: 'networkidle2' }).catch(() => null);
    return { currentCancelledList: cancelledList, cycleNewCancelDetections };
  }

  async function processStatusCancelledList({
    page,
    cancelledHref,
    todaySeoul,
    naverUrl,
    cycleNewCancelDetections,
  }: {
    page: any;
    cancelledHref: string | null;
    todaySeoul: string;
    naverUrl: string;
    cycleNewCancelDetections: number;
  }): Promise<{
    statusCancelledList: Record<string, any>[];
    confirmedStatusList: Record<string, any>[];
    cycleNewCancelDetections: number;
  }> {
    if (!scrapeCancelledStatusList || !scrapeConfirmedStatusList) {
      log('ℹ️ [취소상태목록] 스캐너 미구성 → 스킵');
      return { statusCancelledList: [], confirmedStatusList: [], cycleNewCancelDetections };
    }
    const statusListSourceUrl = cancelledHref || naverUrl;

    const scanOptions = {
      startDate: todaySeoul,
      daysAhead: 30,
      dateDropdownType: 'MONTH',
      limit: 300,
    };
    const cancelledList = await scrapeCancelledStatusList(page, statusListSourceUrl, scanOptions);
    const confirmedList = await scrapeConfirmedStatusList(page, statusListSourceUrl, scanOptions);
    log(`🧾 [취소상태목록] RC04 ${cancelledList.length}건 / RC03 ${confirmedList.length}건`);

    for (const candidate of cancelledList) {
      if (!candidate?.date || !candidate?.start || !candidate?.end) {
        log(`🛡️ [취소상태목록] 파싱 불완전 후보 스킵: ${JSON.stringify(candidate || {})}`);
        continue;
      }
      if (hasConfirmedAliveMatch(candidate, confirmedList)) {
        log(`🛡️ [취소상태목록] RC03 확정 생존 확인 → 픽코 취소 금지: ${maskPhone(candidate.phone || candidate.phoneRaw)} ${candidate.date} ${candidate.start}~${candidate.end} ${candidate.room || ''}`);
        continue;
      }
      const cancelKey = buildCancelKey(candidate, todaySeoul);
      cycleNewCancelDetections = await processConfirmedAbsentCancelCandidate({
        candidate,
        cancelKey,
        cycleNewCancelDetections,
        sourceLabel: '취소상태목록',
      });
    }

    await page.goto(naverUrl, { waitUntil: 'networkidle2' }).catch(() => null);
    return { statusCancelledList: cancelledList, confirmedStatusList: confirmedList, cycleNewCancelDetections };
  }

  async function reconcileDroppedConfirmed({
    previousConfirmedList,
    currentConfirmedList,
    currentCancelledList,
    todaySeoul,
    confirmedCount,
    pendingCancelMap,
    cycleNewCancelDetections,
  }: {
    previousConfirmedList: Record<string, any>[];
    currentConfirmedList: Record<string, any>[];
    currentCancelledList: Record<string, any>[];
    todaySeoul: string;
    confirmedCount: number;
    pendingCancelMap: Map<string, any>;
    cycleNewCancelDetections: number;
  }): Promise<number> {
    for (const [pendingKey, entry] of pendingCancelMap.entries()) {
      if (entry?.source === 'confirmed_drop') pendingCancelMap.delete(pendingKey);
    }
    log('🛡️ [취소감지1] 확정목록 drop 기반 취소 경로 폐기 — RC04/RC03 취소상태목록 계약만 사용');
    return cycleNewCancelDetections;
  }

  return {
    processCancelTab,
    processStatusCancelledList,
    reconcileDroppedConfirmed,
  };
}
