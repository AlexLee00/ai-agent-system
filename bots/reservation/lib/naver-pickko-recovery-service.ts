type Logger = (message: string) => void;
type MaskPhoneFn = (phone: string) => string;
type BuildCompositeKeyFn = (phone: string, date: string, start: string, end: string, room: string) => string;
type ChooseCanonicalReservationIdForSlotFn = (rows: Array<Record<string, any>>, fallbackId?: string | number | null) => string | null;
type ResolveAlertsByBookingFn = (phone: string, date: string, start: string) => Promise<void>;
type SendAlertFn = (options: Record<string, any>) => Promise<void> | void;
type RagSaveReservationFn = (booking: Record<string, any>, status?: string) => Promise<void> | void;

export type CreateNaverPickkoRecoveryServiceDeps = {
  getReservation: (id: string) => Promise<any>;
  findReservationByCompositeKey: (key: string) => Promise<any>;
  findReservationBySlot: (phone: string, date: string, start: string, room: string) => Promise<any>;
  getReservationsBySlot: (phone: string, date: string, start: string, room: string) => Promise<any[]>;
  hideDuplicateReservationsForSlot: (
    canonicalId: string,
    phone: string,
    date: string,
    start: string,
    room: string,
  ) => Promise<number>;
  updateReservation: (id: string, patch: Record<string, any>) => Promise<any>;
  markSeen: (id: string) => Promise<any>;
  buildReservationCompositeKey: BuildCompositeKeyFn;
  chooseCanonicalReservationIdForSlot: ChooseCanonicalReservationIdForSlotFn;
  resolveAlertsByBooking: ResolveAlertsByBookingFn;
  sendAlert: SendAlertFn;
  ragSaveReservation: RagSaveReservationFn;
  maskPhone: MaskPhoneFn;
  toKst: (date: Date) => string;
  log: Logger;
};

export function createNaverPickkoRecoveryService(deps: CreateNaverPickkoRecoveryServiceDeps) {
  const {
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
    toKst,
    log,
  } = deps;

  async function findTrackedReservationForCancelCandidate(booking: Record<string, any>) {
    const matchesSameWindow = (row: Record<string, any> | null | undefined) => {
      if (!row) return false;
      const existingEnd = String(row.end || row.end_time || '');
      const bookingEnd = String(booking.end || '');
      const existingRoom = String(row.room || '').toUpperCase();
      const bookingRoom = String(booking.room || '').toUpperCase();
      return existingEnd === bookingEnd && existingRoom === bookingRoom;
    };

    const phoneRaw = String(booking.phoneRaw || booking.phone || '').replace(/\D/g, '');
    const compositeKey = buildReservationCompositeKey(
      phoneRaw,
      booking.date,
      booking.start,
      booking.end,
      booking.room,
    );

    if (booking.bookingId) {
      const byId = await getReservation(String(booking.bookingId)).catch(() => null);
      if (byId) return byId;
    }

    const byComposite = await findReservationByCompositeKey(compositeKey).catch(() => null);
    if (byComposite) return byComposite;

    const bySlot = await findReservationBySlot(phoneRaw, booking.date, booking.start, booking.room).catch(() => null);
    if (bySlot && matchesSameWindow(bySlot)) return bySlot;

    return null;
  }

  async function shouldProcessCancelledBooking(booking: Record<string, any>): Promise<boolean> {
    return Boolean(await findTrackedReservationForCancelCandidate(booking));
  }

  async function reconcileSlotDuplicatesAfterRecovery(bookingId: string | number | null, booking: Record<string, any>) {
    const slotRows = await getReservationsBySlot(
      booking.phoneRaw || booking.phone,
      booking.date,
      booking.start,
      booking.room,
    ).catch(() => []);

    if (!Array.isArray(slotRows) || slotRows.length <= 1) {
      return { canonicalId: bookingId ? String(bookingId) : null, hiddenCount: 0, slotRows };
    }

    const canonicalId = chooseCanonicalReservationIdForSlot(slotRows, bookingId);
    const hiddenCount = canonicalId
      ? await hideDuplicateReservationsForSlot(
          canonicalId,
          booking.phoneRaw || booking.phone,
          booking.date,
          booking.start,
          booking.room,
        ).catch(() => 0)
      : 0;

    if (hiddenCount > 0) {
      log(`🧹 [중복정리] ${maskPhone(booking.phone)} ${booking.date} ${booking.start} ${booking.room} → canonical=${canonicalId}, hidden=${hiddenCount}`);
    }

    return { canonicalId, hiddenCount, slotRows };
  }

  async function verifyRecoverablePickkoFailure(
    bookingId: string | number | null,
    booking: Record<string, any>,
    failureStage: string | null,
    outputBuf: string,
  ): Promise<boolean> {
    const recoverableSignal = (
      failureStage === 'ALREADY_REGISTERED' ||
      /결제하기 버튼 미발견/.test(String(outputBuf || ''))
    );
    if (!recoverableSignal || !bookingId) return false;

    const slotRows = await getReservationsBySlot(
      booking.phoneRaw || booking.phone,
      booking.date,
      booking.start,
      booking.room,
    ).catch(() => []);

    const peerCompleted = Array.isArray(slotRows) && slotRows.some((row) =>
      String(row.id) !== String(bookingId) &&
      row.status === 'completed' &&
      ['paid', 'manual', 'manual_retry', 'verified'].includes(row.pickkoStatus),
    );

    if (!peerCompleted) return false;

    await updateReservation(String(bookingId), {
      status: 'completed',
      pickkoStatus: 'manual',
      errorReason: null,
      pickkoCompleteTime: toKst(new Date()),
    });
    await markSeen(String(bookingId)).catch(() => {});
    await reconcileSlotDuplicatesAfterRecovery(String(bookingId), booking);
    await resolveAlertsByBooking(booking.phone, booking.date, booking.start);
    await Promise.resolve(sendAlert({
      type: 'completed',
      title: '✅ 픽코 예약 완료! (실패 검증 복구)',
      customer: booking.phoneText || '고객',
      phone: booking.phone,
      date: booking.date,
      time: `${booking.start}~${booking.end}`,
      room: booking.room,
      status: 'manual',
      action: '동일 슬롯의 기존 완료 예약을 확인해 자동 복구함',
    }));
    await Promise.resolve(ragSaveReservation(booking, '픽코완료(실패검증복구)'));
    log(`✅ [실패검증복구] 동일 슬롯 완료 이력 확인: ${maskPhone(booking.phone)} ${booking.date} ${booking.start} ${booking.room}`);
    return true;
  }

  return {
    findTrackedReservationForCancelCandidate,
    shouldProcessCancelledBooking,
    reconcileSlotDuplicatesAfterRecovery,
    verifyRecoverablePickkoFailure,
  };
}
