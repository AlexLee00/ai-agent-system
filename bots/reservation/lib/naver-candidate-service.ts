type Logger = (message: string) => void;
type FillMissingBookingDateFn = (booking: Record<string, any>) => Record<string, any>;
type BuildKeyFn = (booking: Record<string, any>) => string;
type BuildSlotKeyFn = (booking: Record<string, any>) => string;
type GetReservationFn = (id: string) => Promise<any>;
type FindByCompositeFn = (key: string) => Promise<any>;
type FindBySlotFn = (phone: string, date: string, start: string, room: string) => Promise<any>;
type IsSeenIdFn = (id: string) => Promise<boolean>;
type MarkSeenFn = (id: string) => Promise<any>;
type ResolveAlertsFn = (phone: string, date: string, start: string) => Promise<void>;
type UpdateBookingStateFn = (bookingId: string, booking: Record<string, any>, state?: string) => Promise<any>;
type SendAlertFn = (options: Record<string, any>) => Promise<void>;
type RagSaveFn = (booking: Record<string, any>, status?: string) => Promise<void>;
type RunPickkoFn = (booking: Record<string, any>, bookingId?: string | null, page?: any) => Promise<number>;
type BuildReservationIdFn = (phoneRaw: string, date: string, start: string) => string;
type BuildCancelKeyFn = (booking: Record<string, any>, todaySeoul?: string | null) => string;
type RemoveCancelledKeyFn = (key: string) => Promise<any>;
type FormatVipBadgeFn = (phone: string) => Promise<string>;
type MaskPhoneFn = (phone: string) => string;

type NaverCandidateBooking = Record<string, any> & {
  raw?: Record<string, any>;
  phone: string;
  phoneRaw: string;
  date: string;
  start: string;
  end: string;
  room: string;
  _key: string;
  _slotKey: string;
  _trackingId?: string;
};

export type CreateNaverCandidateServiceDeps = {
  log: Logger;
  fillMissingBookingDate: FillMissingBookingDateFn;
  buildMonitoringTrackingKey: BuildKeyFn;
  buildSlotCompositeKey: BuildSlotKeyFn;
  getReservation: GetReservationFn;
  findReservationByCompositeKey: FindByCompositeFn;
  findReservationBySlot: FindBySlotFn;
  isSeenId: IsSeenIdFn;
  markSeen: MarkSeenFn;
  resolveAlertsByBooking: ResolveAlertsFn;
  updateBookingState: UpdateBookingStateFn;
  sendAlert: SendAlertFn;
  ragSaveReservation: RagSaveFn;
  runPickko: RunPickkoFn;
  buildReservationId: BuildReservationIdFn;
  buildCancelKey: BuildCancelKeyFn;
  removeCancelledKey: RemoveCancelledKeyFn;
  formatVipBadge: FormatVipBadgeFn;
  maskPhone: MaskPhoneFn;
  mode: string;
  naverUrl: string;
};

export function createNaverCandidateService(deps: CreateNaverCandidateServiceDeps) {
  const {
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
    buildCancelKey,
    removeCancelledKey,
    formatVipBadge,
    maskPhone,
    mode,
    naverUrl,
  } = deps;

  async function processConfirmedCandidates({
    newest,
    page,
  }: {
    newest: NaverCandidateBooking[];
    page: any;
  }): Promise<void> {
    let autoMarked = 0;
    for (const booking of newest) {
      const key = buildMonitoringTrackingKey(booking);
      if (await isSeenId(key)) continue;
      const existing = await getReservation(key);
      if (existing && (existing.status === 'completed' || ['manual', 'manual_retry', 'manual_pending'].includes(existing.pickkoStatus))) {
        await markSeen(key);
        autoMarked += 1;
        log(`🔄 [자동마킹] ${maskPhone(existing.phone || booking.phone)} ${existing.date || booking.date} → ${existing.pickkoStatus || existing.status} → seen 처리`);
        await resolveAlertsByBooking(booking.phone, booking.date, booking.start);
      }
    }
    if (autoMarked > 0) log(`🔄 [자동마킹] ${autoMarked}건 완료`);

    const baseItems = newest
      .map((booking) => fillMissingBookingDate(booking) as NaverCandidateBooking)
      .filter((booking) => booking.phone && booking.date && booking.start && booking.end && booking.room)
      .map((booking) => ({
        ...booking,
        _key: buildMonitoringTrackingKey(booking),
        _slotKey: buildSlotCompositeKey(booking),
      })) as NaverCandidateBooking[];

    const existingRows = await Promise.all(baseItems.map(async (booking) => {
      return await getReservation(booking._key)
        || await findReservationByCompositeKey(booking._slotKey)
        || await findReservationBySlot(booking.phone, booking.date, booking.start, booking.room);
    }));

    const entries = baseItems.map((booking, index) => ({
      booking,
      seen: !!existingRows[index] && (existingRows[index].markedSeen || existingRows[index].seenOnly),
      existing: existingRows[index],
    }));
    const unseenEntries = entries.filter((entry) => !entry.seen);
    const reactivatedEntries = unseenEntries.filter((entry) => (
      !!entry.existing
      && (
        entry.existing.status === 'cancelled'
        || ['cancelled', 'time_elapsed'].includes(entry.existing.pickkoStatus)
      )
    ));
    const newCandidates: NaverCandidateBooking[] = unseenEntries
      .filter((entry) => !entry.existing)
      .map((entry) => ({ ...entry.booking, _trackingId: entry.booking._key }));
    const candidates: NaverCandidateBooking[] = unseenEntries
      .filter((entry) => (
        !entry.existing
        || entry.existing.status === 'pending'
        || entry.existing.status === 'failed'
        || entry.existing.status === 'cancelled'
        || ['cancelled', 'time_elapsed'].includes(entry.existing.pickkoStatus)
      ))
      .map((entry) => ({ ...entry.booking, _trackingId: entry.existing?.id || entry.booking._key }));

    if (candidates.length === 0) {
      log('ℹ️ 실행 후보 없음(이미 처리했거나 파싱 실패)');
      return;
    }

    log(`✅ 실행 후보 ${candidates.length}건 발견.`);
    if (newCandidates.length > 0) log(`   🆕 신규 감지 ${newCandidates.length}건`);
    const retries = candidates.length - newCandidates.length;
    if (retries > 0) log(`   🔁 재처리 후보 ${retries}건 (pending/failed)`);
    if (reactivatedEntries.length > 0) log(`   ♻️ 취소 후 재예약 재활성화 ${reactivatedEntries.length}건`);

    for (const entry of reactivatedEntries) {
      const booking = entry.booking;
      const existing = entry.existing;
      const bookingId = String(existing?.id || booking._trackingId || booking._key || buildReservationId(booking.phoneRaw, booking.date, booking.start));
      const phoneRaw = String(booking.phoneRaw || booking.phone || '').replace(/\D/g, '');
      const cancelKeys = [
        buildCancelKey(booking, booking.date),
        existing?.id ? `cancelid|${existing.id}` : null,
        phoneRaw ? `cancel_done|${phoneRaw}|${booking.date}|${booking.start}` : null,
      ].filter(Boolean) as string[];

      for (const cancelKey of new Set(cancelKeys)) {
        await removeCancelledKey(cancelKey).catch(() => {});
      }

      await updateBookingState(bookingId, booking, 'pending');
      await sendAlert({
        type: 'info',
        title: '♻️ 취소 후 재예약 재활성화 감지',
        customer: booking.raw?.name || '고객',
        phone: booking.phone,
        date: booking.date,
        time: `${booking.start}~${booking.end}`,
        room: booking.room,
        status: 'pending',
        action: '기존 취소 키 해제 후 Pickko 재등록 준비',
      });
      log(`♻️ [재활성화] ${maskPhone(booking.phone)} ${booking.date} ${booking.start}~${booking.end} ${booking.room} → cancelled key 해제 후 재처리`);
    }

    const devTestPhone = (process.env.DEV_TEST_PHONE || '01035000586').replace(/\D/g, '');
    const allowDevPickko = process.env.DEV_PICKKO_TEST === '1';

    for (const booking of newCandidates) {
      const bookingId = booking._trackingId || booking._key || buildReservationId(booking.phoneRaw, booking.date, booking.start);
      await updateBookingState(bookingId, booking, 'pending');

      const vipBadge = await formatVipBadge(booking.phone);
      const isDevMode = mode === 'dev';
      const isDevTestTarget = allowDevPickko && String(booking.phoneRaw) === devTestPhone;
      const alertType = isDevMode ? 'info' : 'new';
      const alertTitle = isDevMode
        ? `🧪 DEV 신규 예약 감지${vipBadge ? ` ${vipBadge.trim()}` : ''}`
        : `🆕 신규 예약 감지!${vipBadge ? ` ${vipBadge.trim()}` : ''}`;
      const alertAction = isDevMode
        ? (isDevTestTarget ? 'DEV 테스트 번호 감지 — Pickko 테스트 실행 대기' : 'DEV 모드 — 운영 Pickko 자동 등록 건너뜀')
        : 'Pickko 자동 등록 준비 중...';

      await sendAlert({
        type: alertType,
        title: alertTitle,
        customer: booking.raw?.name || '고객',
        phone: booking.phone,
        date: booking.date,
        time: `${booking.start}~${booking.end}`,
        room: booking.room,
        status: 'pending',
        action: alertAction,
      });

      await ragSaveReservation(booking, '신규');
    }

    if (mode === 'dev') {
      if (!allowDevPickko) {
        log('🧷 MODE=dev, DEV_PICKKO_TEST!=1 → 픽코 실행은 건너뜁니다(파싱만 확인).');
        await page.goto(naverUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForNetworkIdle({ idleTime: 800, timeout: 30000 }).catch(() => null);
        return;
      }

      const onlyMine = candidates.filter((booking) => String(booking.phoneRaw) === devTestPhone);
      if (onlyMine.length === 0) {
        log(`🧷 MODE=dev: 테스트 번호(${devTestPhone}) 후보 없음 → 픽코 실행 안 함`);
        await page.goto(naverUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForNetworkIdle({ idleTime: 800, timeout: 30000 }).catch(() => null);
        return;
      }

      log(`🧪 DEV 픽코 테스트: ${devTestPhone} 대상 ${onlyMine.length}건만 실행`);
      for (const booking of onlyMine) {
        const bookingId = booking._trackingId || booking._key || buildReservationId(booking.phoneRaw, booking.date, booking.start);
        const code = await runPickko(booking, bookingId, page);
        if (code === 0) {
          await markSeen(bookingId);
        } else {
          log(`⚠️ DEV 픽코 실패(code=${code}) → seen 마킹 안 함(재시도 가능)`);
        }
      }

      await page.goto(naverUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForNetworkIdle({ idleTime: 800, timeout: 30000 }).catch(() => null);
      return;
    }

    for (const booking of candidates) {
      const bookingId = booking._trackingId || booking._key || buildReservationId(booking.phoneRaw, booking.date, booking.start);
      const code = await runPickko(booking, bookingId, page);
      if (code === 0) {
        await markSeen(bookingId);
      } else if (code === 99) {
        await markSeen(bookingId);
        log('⛔ 최대 재시도 초과 → seen 마킹 완료 (재감지 차단)');
      } else {
        log(`⚠️ OPS 픽코 실패(code=${code}) → seen 마킹 안 함(재시도 가능)`);
      }
    }

    await page.goto(naverUrl, { waitUntil: 'networkidle2' });
  }

  return {
    processConfirmedCandidates,
  };
}
