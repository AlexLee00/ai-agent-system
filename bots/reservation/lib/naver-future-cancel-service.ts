type Logger = (message: string) => void;
type DelayFn = (ms: number) => Promise<void>;
type MaskPhoneFn = (phone: string) => string;
type IsCancelledKeyFn = (key: string) => Promise<boolean>;
type AddCancelledKeyFn = (key: string) => Promise<any>;
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
type RunPickkoCancelFn = (booking: Record<string, any>, bookingId?: string | null) => Promise<any>;
type ScrapeNewestBookingsFromListFn = (page: any, maxItems?: number) => Promise<Record<string, any>[]>;
type LiveCancelVerificationResult = {
  ok: boolean;
  reason: 'cancel_tab_match' | 'still_confirmed' | 'not_in_cancel_tab' | 'verification_error';
  error?: string;
};

export type CreateNaverFutureCancelServiceDeps = {
  delay: DelayFn;
  log: Logger;
  maskPhone: MaskPhoneFn;
  isCancelledKey: IsCancelledKeyFn;
  addCancelledKey: AddCancelledKeyFn;
  upsertFutureConfirmed: UpsertFutureConfirmedFn;
  getStaleConfirmed: GetStaleConfirmedFn;
  deleteStaleConfirmed: DeleteStaleConfirmedFn;
  pruneOldFutureConfirmed: PruneOldFutureConfirmedFn;
  runPickkoCancel: RunPickkoCancelFn;
  scrapeNewestBookingsFromList: ScrapeNewestBookingsFromListFn;
  runtimeConfig: {
    staleConfirmCount: number;
    staleMinElapsedMs: number;
    staleExpireMs: number;
  };
};

export function createNaverFutureCancelService(deps: CreateNaverFutureCancelServiceDeps) {
  const {
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
    runtimeConfig,
  } = deps;

  function normalizePhone(value: unknown): string {
    return String(value || '').replace(/\D/g, '');
  }

  function normalizeRoom(value: unknown): string {
    return String(value || '').trim().toUpperCase();
  }

  function matchesReservation(item: Record<string, any>, booking: Record<string, any>): boolean {
    const itemBookingId = String(item.bookingId || '').trim();
    const bookingId = String(booking.bookingId || '').trim();
    if (itemBookingId && bookingId && itemBookingId === bookingId) return true;

    return (
      normalizePhone(item.phoneRaw || item.phone) === normalizePhone(booking.phoneRaw || booking.phone) &&
      String(item.date || '') === String(booking.date || '') &&
      String(item.start || '') === String(booking.start || '') &&
      String(item.end || '') === String(booking.end || '') &&
      normalizeRoom(item.room) === normalizeRoom(booking.room)
    );
  }

  function buildDailyStatusUrl(listBase: string, status: string, date: string): string {
    return `${listBase}?status=${encodeURIComponent(status)}&date=${encodeURIComponent(date)}`;
  }

  async function verifyStaleCancelAgainstLiveNaver({
    page,
    listBase,
    booking,
  }: {
    page: any;
    listBase: string;
    booking: Record<string, any>;
  }): Promise<LiveCancelVerificationResult> {
    try {
      const confirmedUrl = buildDailyStatusUrl(listBase, 'CONFIRMED', booking.date);
      await page.goto(confirmedUrl, { waitUntil: 'networkidle2', timeout: 20000 });
      await delay(1000);
      const confirmedList = await scrapeNewestBookingsFromList(page, 100);
      if (confirmedList.some((item) => matchesReservation(item, booking))) {
        return { ok: false, reason: 'still_confirmed' };
      }

      const cancelledUrl = buildDailyStatusUrl(listBase, 'CANCELLED', booking.date);
      await page.goto(cancelledUrl, { waitUntil: 'networkidle2', timeout: 20000 });
      await delay(1000);
      const cancelledList = await scrapeNewestBookingsFromList(page, 100);
      if (cancelledList.some((item) => matchesReservation(item, booking))) {
        return { ok: true, reason: 'cancel_tab_match' };
      }

      return { ok: false, reason: 'not_in_cancel_tab' };
    } catch (error: any) {
      return {
        ok: false,
        reason: 'verification_error',
        error: error?.message || String(error),
      };
    }
  }

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

    const past30Str = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    const futureUrl =
      `${listBase}?bookingStatusCodes=RC03&dateDropdownType=RANGE` +
      `&dateFilter=REGDATE&startDateTime=${past30Str}&endDateTime=${future60Str}`;

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

          if (pendingCancelMap.has(cancelKey)) {
            const pending = pendingCancelMap.get(cancelKey);
            const elapsed = Date.now() - pending.firstDetectedAt;
            if (elapsed > runtimeConfig.staleExpireMs) {
              log(`⏳ [취소감지4] ${maskPhone(stale.phone_raw)} ${stale.date} ${stale.start_time}~${stale.end_time} — pending 만료(${Math.floor(elapsed / 60000)}분) → 재등록`);
              pendingCancelMap.set(cancelKey, {
                source: 'future_stale',
                booking,
                stale,
                firstDetectedAt: Date.now(),
                count: 1,
              });
              await upsertFutureConfirmed(stale.booking_key, stale.phone_raw, stale.date, stale.start_time, stale.end_time, stale.room, checkCount);
              continue;
            }

            const newCount = (pending.count || 1) + 1;
            if (newCount >= runtimeConfig.staleConfirmCount && elapsed >= runtimeConfig.staleMinElapsedMs) {
              log(`🗑️ [취소감지4] ${maskPhone(stale.phone_raw)} ${stale.date} ${stale.start_time}~${stale.end_time} — ${newCount}회 연속 stale + ${Math.floor(elapsed / 60000)}분 경과 → live 검증`);
              const liveVerification = await verifyStaleCancelAgainstLiveNaver({ page, listBase, booking });
              if (!liveVerification.ok) {
                const suffix = liveVerification.error ? ` (${liveVerification.error})` : '';
                log(`🛡️ [취소감지4] live 검증 차단(${liveVerification.reason}) — 픽코 취소 보류: ${maskPhone(stale.phone_raw)} ${stale.date} ${stale.start_time}~${stale.end_time}${suffix}`);
                pendingCancelMap.delete(cancelKey);
                await upsertFutureConfirmed(stale.booking_key, stale.phone_raw, stale.date, stale.start_time, stale.end_time, stale.room, checkCount);
                continue;
              }

              log(`🗑️ [취소감지4] ${maskPhone(stale.phone_raw)} ${stale.date} ${stale.start_time}~${stale.end_time} — 네이버 취소 탭 live 검증 통과 → 취소 확정`);
              pendingCancelMap.delete(cancelKey);
              const result = await runPickkoCancel(booking, cancelKey);
              if (result === 0) {
                await addCancelledKey(cancelKey);
                cycleNewCancelDetections += 1;
              } else {
                log(`🛡️ [취소감지4] 픽코 취소 미완료(exit ${result}) — 취소 key 등록 보류: ${maskPhone(stale.phone_raw)} ${stale.date} ${stale.start_time}~${stale.end_time}`);
              }
            } else {
              pendingCancelMap.set(cancelKey, { ...pending, source: 'future_stale', booking, count: newCount });
              log(`⏳ [취소감지4] ${maskPhone(stale.phone_raw)} ${stale.date} ${stale.start_time}~${stale.end_time} — ${newCount}회 stale (${Math.floor(elapsed / 60000)}분 경과) → 취소 대기 (${runtimeConfig.staleConfirmCount}회/${Math.floor(runtimeConfig.staleMinElapsedMs / 60000)}분 필요)`);
              await upsertFutureConfirmed(stale.booking_key, stale.phone_raw, stale.date, stale.start_time, stale.end_time, stale.room, checkCount);
            }
          } else {
            log(`⏳ [취소감지4] ${maskPhone(stale.phone_raw)} ${stale.date} ${stale.start_time}~${stale.end_time} — 1회 stale 감지 → 대기 (${runtimeConfig.staleConfirmCount}회 연속 필요)`);
            pendingCancelMap.set(cancelKey, {
              source: 'future_stale',
              booking,
              stale,
              firstDetectedAt: Date.now(),
              count: 1,
            });
            await upsertFutureConfirmed(stale.booking_key, stale.phone_raw, stale.date, stale.start_time, stale.end_time, stale.room, checkCount);
          }
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
