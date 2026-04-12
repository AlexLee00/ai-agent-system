type Logger = (message: string) => void;
type MaskPhoneFn = (phone: string) => string;
type ToKstFn = (date: Date) => string;
type GetReservationFn = (id: string) => Promise<any>;
type AddReservationFn = (id: string, payload: Record<string, any>) => Promise<any>;
type UpdateReservationFn = (id: string, patch: Record<string, any>) => Promise<any>;
type RollbackProcessingFn = () => Promise<number>;
type BuildCompositeKeyFn = (phoneRaw: string, date: string, start: string, end: string, room: string) => string;
type StoreReservationEventFn = (rag: any, booking: Record<string, any>, payload: Record<string, any>) => Promise<any>;

export type CreateNaverBookingStateServiceDeps = {
  log: Logger;
  maskPhone: MaskPhoneFn;
  toKst: ToKstFn;
  getReservation: GetReservationFn;
  addReservation: AddReservationFn;
  updateReservation: UpdateReservationFn;
  rollbackProcessing: RollbackProcessingFn;
  buildReservationCompositeKey: BuildCompositeKeyFn;
  storeReservationEvent: StoreReservationEventFn;
  rag: any;
};

export function createNaverBookingStateService(deps: CreateNaverBookingStateServiceDeps) {
  const {
    log,
    maskPhone,
    toKst,
    getReservation,
    addReservation,
    updateReservation,
    rollbackProcessing,
    buildReservationCompositeKey,
    storeReservationEvent,
    rag,
  } = deps;

  async function ragSaveReservation(booking: Record<string, any>, status = '신규'): Promise<void> {
    try {
      await storeReservationEvent(rag, booking, {
        status,
        sourceBot: 'naver-monitor',
      });
      log(`📚 [RAG] 저장 완료: ${maskPhone(booking.phone)} / ${booking.date} ${booking.start}~${booking.end} (${status})`);
    } catch (error: any) {
      log(`⚠️ [RAG] 저장 실패(무시): ${error?.message || String(error)}`);
    }
  }

  async function rollbackProcessingEntries(): Promise<void> {
    try {
      const count = await rollbackProcessing();
      if (count > 0) log(`🔄 [롤백] processing → failed 전환 ${count}건`);
    } catch (error: any) {
      log(`⚠️ [롤백 실패] ${error?.message || String(error)}`);
    }
  }

  async function updateBookingState(
    bookingId: string,
    booking: Record<string, any>,
    state = 'pending',
    dailyStats?: Record<string, number>,
  ): Promise<any> {
    try {
      const existing = await getReservation(bookingId);

      if (!existing) {
        await addReservation(bookingId, {
          compositeKey: buildReservationCompositeKey(booking.phoneRaw, booking.date, booking.start, booking.end, booking.room),
          name: booking.raw?.name || null,
          phone: booking.phone,
          phoneRaw: booking.phoneRaw,
          date: booking.date,
          start: booking.start,
          end: booking.end,
          room: booking.room,
          detectedAt: toKst(new Date()),
          status: state,
          pickkoStatus: null,
          retries: 0,
        });
        log(`   📊 [신규] ${maskPhone(booking.phone)} / ${booking.date} ${booking.start}~${booking.end} ${booking.room} → status: ${state}`);
        if (dailyStats) dailyStats.detected = (dailyStats.detected || 0) + 1;
      } else {
        const oldStatus = existing.status;
        const updates: Record<string, any> = { status: state };

        if (state === 'processing') {
          updates.pickkoStartTime = toKst(new Date());
        } else if (state === 'completed') {
          updates.pickkoStatus = 'paid';
          updates.pickkoCompleteTime = toKst(new Date());
          if (dailyStats) dailyStats.completed = (dailyStats.completed || 0) + 1;
        } else if (state === 'failed') {
          updates.retries = (existing.retries || 0) + 1;
          if (dailyStats) dailyStats.failed = (dailyStats.failed || 0) + 1;
        }

        await updateReservation(bookingId, updates);
        log(`   📊 [업데이트] ${maskPhone(booking.phone)}: ${oldStatus} → ${state}`);
      }

      return getReservation(bookingId);
    } catch (error: any) {
      log(`❌ updateBookingState 실패: ${error?.message || String(error)}`);
      return null;
    }
  }

  return {
    ragSaveReservation,
    rollbackProcessingEntries,
    updateBookingState,
  };
}
