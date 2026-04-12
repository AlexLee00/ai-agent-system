type Logger = (message: string) => void;
type DelayFn = (ms: number) => Promise<void>;
type MaskPhoneFn = (phone: string) => string;
type BuildCancelKeyFn = (booking: Record<string, any>, todaySeoul?: string | null) => string;
type BuildConfirmedListKeyFn = (booking: Record<string, any>, todaySeoul?: string | null) => string;
type IsCancelledKeyFn = (key: string) => Promise<boolean>;
type AddCancelledKeyFn = (key: string) => Promise<any>;
type ShouldProcessCancelledBookingFn = (booking: Record<string, any>) => Promise<boolean>;
type RunPickkoCancelFn = (booking: Record<string, any>, bookingId?: string | null) => Promise<any>;
type ScrapeNewestBookingsFromListFn = (page: any, maxItems?: number) => Promise<Record<string, any>[]>;
type ScrapeExpandedCancelledFn = (page: any, cancelledHref: string) => Promise<Record<string, any>[]>;

export type CreateNaverCancelDetectionServiceDeps = {
  delay: DelayFn;
  log: Logger;
  maskPhone: MaskPhoneFn;
  buildCancelKey: BuildCancelKeyFn;
  buildConfirmedListKey: BuildConfirmedListKeyFn;
  isCancelledKey: IsCancelledKeyFn;
  addCancelledKey: AddCancelledKeyFn;
  shouldProcessCancelledBooking: ShouldProcessCancelledBookingFn;
  runPickkoCancel: RunPickkoCancelFn;
  scrapeNewestBookingsFromList: ScrapeNewestBookingsFromListFn;
  scrapeExpandedCancelled: ScrapeExpandedCancelledFn;
};

export function createNaverCancelDetectionService(deps: CreateNaverCancelDetectionServiceDeps) {
  const {
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
  } = deps;

  async function processCancelTab({
    page,
    cancelledHref,
    bizId,
    todaySeoul,
    naverUrl,
    cycleNewCancelDetections,
  }: {
    page: any;
    cancelledHref: string | null;
    bizId: string;
    todaySeoul: string;
    naverUrl: string;
    cycleNewCancelDetections: number;
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
      const cancelledFlags = await Promise.all(cancelledList.map((c) => isCancelledKey(buildCancelKey(c, todaySeoul))));
      const cancelCandidates = cancelledList.filter((c, i) => !cancelledFlags[i]);

      if (cancelCandidates.length > 0) {
        log(`🗑️ 취소 탭 신규 취소: ${cancelCandidates.length}건`);
        for (const candidate of cancelCandidates) {
          const cancelKey = buildCancelKey(candidate, todaySeoul);
          const tracked = await shouldProcessCancelledBooking(candidate);
          await addCancelledKey(cancelKey);
          if (!tracked) {
            log(`ℹ️ [취소탭] 미추적 과거 취소건 스킵: ${maskPhone(candidate.phone || candidate.phoneRaw)} ${candidate.date} ${candidate.start}~${candidate.end} ${candidate.room || ''} (DB 추적 없음)`);
            continue;
          }
          cycleNewCancelDetections += 1;
          await runPickkoCancel(candidate, cancelKey);
        }
      } else {
        log('ℹ️ 취소 탭 신규 취소 없음');
      }
    }

    await page.goto(naverUrl, { waitUntil: 'networkidle2' }).catch(() => null);
    return { currentCancelledList: cancelledList, cycleNewCancelDetections };
  }

  async function processExpandedCancelled({
    page,
    cancelledHref,
    todaySeoul,
    naverUrl,
    cycleNewCancelDetections,
  }: {
    page: any;
    cancelledHref: string;
    todaySeoul: string;
    naverUrl: string;
    cycleNewCancelDetections: number;
  }): Promise<number> {
    log(`🔍 [취소감지2E] 확장 취소 스캔 시작 — 사이클 #${new Date().toISOString()}`);
    const expandedList = await scrapeExpandedCancelled(page, cancelledHref);
    log(`🔍 [취소감지2E] ${expandedList.length}건 확인`);

    if (expandedList.length > 0) {
      const expandedFlags = await Promise.all(expandedList.map((c) => isCancelledKey(buildCancelKey(c, todaySeoul))));
      const newCancels = expandedList.filter((c, i) => !expandedFlags[i]);
      if (newCancels.length > 0) {
        log(`🗑️ [취소감지2E] 신규 취소 ${newCancels.length}건 처리`);
        for (const candidate of newCancels) {
          const key = buildCancelKey(candidate, todaySeoul);
          const tracked = await shouldProcessCancelledBooking(candidate);
          await addCancelledKey(key);
          if (!tracked) {
            log(`ℹ️ [취소감지2E] 미추적 과거 취소건 스킵: ${maskPhone(candidate.phone || candidate.phoneRaw)} ${candidate.date} ${candidate.start}~${candidate.end} ${candidate.room || ''} (DB 추적 없음)`);
            continue;
          }
          cycleNewCancelDetections += 1;
          await runPickkoCancel(candidate, key);
        }
      } else {
        log('[취소감지2E] 신규 취소 없음');
      }
    }

    await page.goto(naverUrl, { waitUntil: 'networkidle2' }).catch(() => null);
    return cycleNewCancelDetections;
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
    if (confirmedCount === 0) {
      log(`⚠️ 취소 감지 1 스킵: 카운터=0 (페이지 글리치 의심, 이전 확정 ${previousConfirmedList.length}건 유지)`);
      return cycleNewCancelDetections;
    }

    const currentKeys = new Set(currentConfirmedList.map((b) => buildConfirmedListKey(b, todaySeoul)));
    const droppedFromConfirmed = previousConfirmedList.filter((b) => !currentKeys.has(buildConfirmedListKey(b, todaySeoul)));

    if (pendingCancelMap.size > 0) {
      const currentKeysSet = new Set(currentConfirmedList.map((b) => buildConfirmedListKey(b, todaySeoul)));
      for (const [pendingKey, entry] of pendingCancelMap.entries()) {
        if (entry?.source !== 'confirmed_drop' || !entry?.booking) continue;
        const reappeared = currentKeysSet.has(buildConfirmedListKey(entry.booking, todaySeoul));
        const expired = Date.now() - entry.detectedAt > 30 * 60 * 1000;
        if (reappeared) {
          log(`✅ [취소감지1] 더블체크 취소 — 다시 나타남: ${maskPhone(entry.booking.phone)} ${entry.booking.date} (오탐 방지)`);
          pendingCancelMap.delete(pendingKey);
        } else if (expired) {
          log(`⏱️ [취소감지1] pending 30분 만료 → 취소 확정: ${maskPhone(entry.booking.phone)} ${entry.booking.date}`);
          pendingCancelMap.delete(pendingKey);
          if (!await isCancelledKey(pendingKey)) {
            await addCancelledKey(pendingKey);
            cycleNewCancelDetections += 1;
            await runPickkoCancel(entry.booking, pendingKey);
          }
        }
      }
    }

    if (droppedFromConfirmed.length === 0) {
      log('ℹ️ 확정 리스트 변화 없음');
      return cycleNewCancelDetections;
    }

    log(`🗑️ 확정 리스트에서 ${droppedFromConfirmed.length}건 사라짐 → 취소 탭 교차검증 시작`);
    const cancelledKeySet = new Set(currentCancelledList.map((c) => buildCancelKey(c, todaySeoul)));
    for (const dropped of droppedFromConfirmed) {
      const cancelKey = buildCancelKey(dropped, todaySeoul);
      if (await isCancelledKey(cancelKey)) continue;

      if (cancelledKeySet.has(cancelKey)) {
        await addCancelledKey(cancelKey);
        cycleNewCancelDetections += 1;
        await runPickkoCancel(dropped, cancelKey);
        continue;
      }

      if (dropped.date && dropped.date > todaySeoul) {
        if (pendingCancelMap.has(cancelKey)) {
          log(`🗑️ [취소감지1] ${maskPhone(dropped.phone)} ${dropped.date} ${dropped.start}~${dropped.end} 2회 연속 미감지 → 취소 확정`);
          pendingCancelMap.delete(cancelKey);
          await addCancelledKey(cancelKey);
          cycleNewCancelDetections += 1;
          await runPickkoCancel(dropped, cancelKey);
        } else {
          log(`⏳ [취소감지1] ${maskPhone(dropped.phone)} ${dropped.date} ${dropped.start}~${dropped.end} 사라짐 감지 → 1사이클 후 재확인 (더블체크 대기)`);
          pendingCancelMap.set(cancelKey, {
            source: 'confirmed_drop',
            booking: dropped,
            detectedAt: Date.now(),
          });
        }
      } else {
        log(`⚠️ [취소감지1] ${maskPhone(dropped.phone)} ${dropped.start}~${dropped.end} 확정 리스트에서 사라졌으나 취소 탭 미확인 → 이용완료 추정, 픽코 취소 스킵`);
      }
    }

    return cycleNewCancelDetections;
  }

  return {
    processCancelTab,
    processExpandedCancelled,
    reconcileDroppedConfirmed,
  };
}
