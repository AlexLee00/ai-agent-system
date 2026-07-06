type Logger = (message: string) => void;
type DelayFn = (ms: number) => Promise<void>;
type MaskPhoneFn = (phone: string) => string;
type IsCancelledKeyFn = (key: string) => Promise<boolean>;
type AddCancelledKeyFn = (key: string) => Promise<any>;
type BuildCancelKeyFn = (booking: Record<string, any>, todaySeoul?: string | null) => string;
type UpsertFutureConfirmedFn = (
  bookingKey: string,
  phoneRaw: string,
  date: string,
  startTime: string,
  endTime: string,
  room: string | null,
  scanCycle: number,
) => Promise<any>;
type GetStaleConfirmedFn = (currentCycle: number, minDate: string) => Promise<any[]>;
type DeleteStaleConfirmedFn = (currentCycle: number, minDate: string) => Promise<any>;
type PruneOldFutureConfirmedFn = (cutoffDate: string) => Promise<any>;
type ScrapeNewestBookingsFromListFn = (page: any, maxItems?: number) => Promise<Record<string, any>[]>;

export type CreateNaverFutureCancelServiceDeps = {
  delay: DelayFn;
  log: Logger;
  maskPhone: MaskPhoneFn;
  isCancelledKey: IsCancelledKeyFn;
  addCancelledKey: AddCancelledKeyFn;
  buildCancelKey: BuildCancelKeyFn;
  upsertFutureConfirmed: UpsertFutureConfirmedFn;
  getStaleConfirmed: GetStaleConfirmedFn;
  deleteStaleConfirmed: DeleteStaleConfirmedFn;
  pruneOldFutureConfirmed: PruneOldFutureConfirmedFn;
  scrapeNewestBookingsFromList: ScrapeNewestBookingsFromListFn;
};

export function createNaverFutureCancelService(deps: CreateNaverFutureCancelServiceDeps) {
  const {
    delay,
    log,
    maskPhone,
    isCancelledKey,
    addCancelledKey,
    buildCancelKey,
    upsertFutureConfirmed,
    getStaleConfirmed,
    deleteStaleConfirmed,
    pruneOldFutureConfirmed,
    scrapeNewestBookingsFromList,
  } = deps;

  async function processFutureCancelSnapshot({
    checkCount,
    cancelledHref,
    page,
    todaySeoul,
    naverUrl,
    pendingCancelMap,
    cycleNewCancelDetections,
  }: {
    checkCount: number;
    cancelledHref: string | null;
    page: any;
    todaySeoul: string;
    naverUrl: string;
    pendingCancelMap: Map<string, any>;
    cycleNewCancelDetections: number;
  }): Promise<number> {
    const tomorrowStr = new Date(Date.now() + 24 * 60 * 60 * 1000)
      .toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    const future60Str = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000)
      .toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    const listBase = cancelledHref
      ? new URL(cancelledHref).origin + new URL(cancelledHref).pathname
      : null;

    if (!listBase) {
      log('⚠️ [취소감지4] cancelledHref 없음 → 스킵');
      throw new Error('cancelledHref 없음');
    }

    const futureUrl =
      `${listBase}?bookingStatusCodes=RC03&dateDropdownType=RANGE` +
      `&dateFilter=USEDATE&startDateTime=${tomorrowStr}&endDateTime=${future60Str}`;

    log(`🔮 [취소감지4] 미래 예약 스캔 (${tomorrowStr}~${future60Str}) — 사이클 #${checkCount}`);
    await page.goto(futureUrl, { waitUntil: 'networkidle2', timeout: 20000 });
    await delay(1500);

    const FUTURE_SCAN_LIMIT = 300;
    const futureList = await scrapeNewestBookingsFromList(page, FUTURE_SCAN_LIMIT);
    const futureDateItems = futureList.filter((item) => item.date && item.date > todaySeoul);
    log(`🔮 [취소감지4] ${futureList.length}건 확인 → 미래 날짜 ${futureDateItems.length}건 스냅샷`);

    const hitScanLimit = futureList.length >= FUTURE_SCAN_LIMIT;
    if (hitScanLimit) {
      log(`⚠️ [취소감지4] 스캔 한도(${FUTURE_SCAN_LIMIT}건) 도달 — stale 감지 스킵 (오탐 방지)`);
    }

    for (const item of futureDateItems) {
      const phoneRawItem = item.phoneRaw || item.phone?.replace(/\D/g, '') || '';
      const bookingKey =
        item.bookingId || `${item.date}|${item.start}|${item.end}|${item.room || ''}|${phoneRawItem}`;
      await upsertFutureConfirmed(
        bookingKey,
        phoneRawItem,
        item.date || '',
        item.start || '',
        item.end || '',
        item.room || null,
        checkCount,
      );
    }

    if (futureList.length > 0 && !hitScanLimit) {
      const staleItems = await getStaleConfirmed(checkCount, tomorrowStr);
      if (staleItems.length > 0) {
        log(`🗑️ [취소감지4] ${staleItems.length}건 stale (네이버 확정에서 사라짐) → 더블체크 진행`);
        for (const stale of staleItems) {
          const cancelKey = /^\d+$/.test(String(stale.booking_key))
            ? `cancelid|${stale.booking_key}`
            : `cancel|${stale.date}|${stale.start_time}|${stale.end_time}|${stale.room || ''}|${stale.phone_raw}`;
          if (await isCancelledKey(cancelKey)) continue;

          const nowKst = new Date(Date.now() + 9 * 3600 * 1000);
          const slotEndKst = new Date(`${stale.date}T${stale.end_time}:00+09:00`);
          if (slotEndKst <= nowKst) {
            log(`ℹ️ [취소감지4] ${maskPhone(stale.phone_raw)} ${stale.date} ${stale.start_time}~${stale.end_time} — 슬롯 종료됨 → 취소 스킵 (재감지 방지 등록)`);
            await addCancelledKey(cancelKey).catch(() => {});
            continue;
          }

          const booking = {
            phoneRaw: stale.phone_raw,
            phone: stale.phone_raw,
            date: stale.date,
            start: stale.start_time,
            end: stale.end_time,
            room: stale.room || '',
            bookingId: /^\d+$/.test(String(stale.booking_key)) ? stale.booking_key : null,
          };

          log(`🛡️ [취소감지4] ${maskPhone(stale.phone_raw)} ${stale.date} ${stale.start_time}~${stale.end_time} — 미래 stale 경로는 관찰 전용, 픽코 취소 실행 금지`);
          pendingCancelMap.delete(cancelKey);
          await upsertFutureConfirmed(stale.booking_key, stale.phone_raw, stale.date, stale.start_time, stale.end_time, stale.room, checkCount);
        }
        await deleteStaleConfirmed(checkCount, tomorrowStr);
      }
    } else {
      log('⚠️ [취소감지4] 미래 예약 0건 — stale 감지 스킵 (페이지 로딩 실패 가능성)');
    }

    await pruneOldFutureConfirmed(todaySeoul);
    await page.goto(naverUrl, { waitUntil: 'networkidle2' }).catch(() => null);
    return cycleNewCancelDetections;
  }

  return {
    processFutureCancelSnapshot,
  };
}
