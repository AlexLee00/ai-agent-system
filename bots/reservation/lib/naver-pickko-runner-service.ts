import { spawn as nodeSpawn } from 'child_process';
const NODE_BIN = process.execPath || '/opt/homebrew/bin/node';

type Logger = (message: string) => void;

function safeWriteToStream(stream: NodeJS.WriteStream, text: string) {
  try {
    stream.write(text);
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as { code?: string }).code : undefined;
    if (code === 'EPIPE') return;
    throw error;
  }
}

export type CreateNaverPickkoRunnerServiceDeps = {
  isCancelledKey: (key: string) => Promise<boolean>;
  getReservation: (id: string) => Promise<any>;
  markSeen: (id: string) => Promise<any>;
  resolveAlertsByBooking: (phone: string, date: string, start: string) => Promise<void>;
  updateBookingState: (bookingId: string, booking: Record<string, any>, state: string) => Promise<any>;
  updateReservation: (bookingId: string, patch: Record<string, any>) => Promise<any>;
  addCancelledKey: (key: string) => Promise<any>;
  sendAlert: (options: Record<string, any>) => Promise<void> | void;
  ragSaveReservation: (booking: Record<string, any>, status?: string) => Promise<void> | void;
  publishReservationAlert: (payload: Record<string, any>) => Promise<any> | any;
  autoBugReport: (payload: Record<string, any>) => void;
  transformAndNormalizeData: (booking: Record<string, any>) => Record<string, any> | null;
  verifyRecoverablePickkoFailure: (
    bookingId: string | number | null,
    booking: Record<string, any>,
    failureStage: string | null,
    outputBuf: string,
  ) => Promise<boolean>;
  reconcileSlotDuplicatesAfterRecovery: (bookingId: string | number | null, booking: Record<string, any>) => Promise<any>;
  buildPickkoCancelArgs: (baseScriptPath: string, booking: Record<string, any>) => string[];
  buildPickkoAccurateArgs: (baseScriptPath: string, normalized: Record<string, any>, customerName: string) => string[];
  buildPickkoCancelManualMessage: (booking: Record<string, any>) => string;
  buildPickkoRetryExceededMessage: (booking: Record<string, any>, currentRetries: number, maxRetries: number) => string;
  buildPickkoTimeElapsedMessage: (booking: Record<string, any>) => string;
  buildPickkoManualFailureMessage: (booking: Record<string, any>, errorMsg: string, retryCount: number, failureStage?: string | null) => string;
  maskPhone: (phone: string) => string;
  toKst: (date: Date) => string;
  log: Logger;
  spawnImpl?: typeof nodeSpawn;
  setTimeoutImpl?: typeof setTimeout;
};

export function createNaverPickkoRunnerService(deps: CreateNaverPickkoRunnerServiceDeps) {
  const {
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
    toKst,
    log,
    spawnImpl = nodeSpawn,
    setTimeoutImpl = setTimeout,
  } = deps;

  function runPickkoCancel({
    booking,
    scriptsDir,
    manualCancelScriptPath,
    onCancelled,
  }: {
    booking: Record<string, any>;
    scriptsDir: string;
    manualCancelScriptPath: string;
    onCancelled?: () => void;
  }): Promise<number> {
    return new Promise(async (resolve) => {
      const phoneRawForKey = String(booking.phoneRaw || booking.phone || '').replace(/\D/g, '');
      const doneKey = `cancel_done|${phoneRawForKey}|${booking.date}|${booking.start}`;

      if (await isCancelledKey(doneKey)) {
        log(`ℹ️ [취소 스킵] 이미 완료된 취소 — ${maskPhone(phoneRawForKey)} ${booking.date} ${booking.start} (doneKey 존재)`);
        resolve(0);
        return;
      }

      if (booking.bookingId) {
        const currentEntry = await getReservation(String(booking.bookingId)).catch(() => null);
        if (currentEntry && (currentEntry.status === 'cancelled' || ['time_elapsed', 'cancelled'].includes(currentEntry.pickkoStatus))) {
          log(`✅ [취소 건너뜀] 이미 종결 처리됨: ${maskPhone(phoneRawForKey)} ${booking.date} ${booking.start} → ${currentEntry.pickkoStatus || currentEntry.status}`);
          await markSeen(String(booking.bookingId)).catch(() => {});
          await resolveAlertsByBooking(booking.phone, booking.date, booking.start);
          resolve(0);
          return;
        }
      }

      const args = buildPickkoCancelArgs(manualCancelScriptPath, booking);
      log(`🗑️ 픽코 취소 실행: ${maskPhone(booking.phone)} / ${booking.date} ${booking.start}~${booking.end} / ${booking.room}`);

      const onCancelSuccess = async (isRetry: boolean) => {
        await addCancelledKey(doneKey).catch(() => {});
        if (booking.bookingId) {
          await updateBookingState(String(booking.bookingId), booking, 'cancelled').catch(() => {});
          await markSeen(String(booking.bookingId)).catch(() => {});
        }
        await resolveAlertsByBooking(booking.phone, booking.date, booking.start);
        if (onCancelled) onCancelled();
        await Promise.resolve(sendAlert({
          type: 'cancelled',
          title: isRetry ? '🗑️ 픽코 예약 취소 완료! (재시도 성공)' : '🗑️ 픽코 예약 취소 완료!',
          phone: booking.phone,
          date: booking.date,
          time: `${booking.start}~${booking.end}`,
          room: booking.room,
          action: isRetry ? '재시도 후 정상 취소 처리됨' : '정상 취소 처리됨',
        }));
        await Promise.resolve(ragSaveReservation(booking, isRetry ? '취소완료(재시도)' : '취소완료'));
      };

      const onCancelFail = async (code: number | null, firstCode?: number | null) => {
        const desc = firstCode != null
          ? `고객:${booking.phone} / ${booking.date} ${booking.start}~${booking.end} / ${booking.room}룸 / 1차:${firstCode} 재시도:${code}`
          : `고객:${booking.phone} / ${booking.date} ${booking.start}~${booking.end} / ${booking.room}룸 / exit code ${code}`;
        await Promise.resolve(sendAlert({
          type: 'error',
          title: firstCode != null ? '❌ 픽코 취소 실패 (재시도 포함)' : '❌ 픽코 취소 실패',
          phone: booking.phone,
          date: booking.date,
          start: booking.start,
          time: `${booking.start}~${booking.end}`,
          room: booking.room,
          reason: `exit code ${code}`,
          action: '수동 취소 필요',
        }));
        await Promise.resolve(publishReservationAlert({
          from_bot: 'andy',
          event_type: 'alert',
          alert_level: 3,
          message: buildPickkoCancelManualMessage(booking),
        }));
        autoBugReport({
          title: firstCode != null ? '픽코 자동 취소 실패 (재시도 포함)' : '픽코 자동 취소 실패',
          desc,
          severity: 'high',
          category: 'reliability',
        });
      };

      const spawnCancel = () => {
        const child = spawnImpl(NODE_BIN, args, { cwd: scriptsDir, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (chunk) => safeWriteToStream(process.stdout, chunk.toString()));
        child.stderr.on('data', (chunk) => safeWriteToStream(process.stderr, chunk.toString()));
        return child;
      };

      const isAlreadyGoneOutput = (buf: string) => /취소 대상 예약 미발견/.test(String(buf || ''));

      const child = spawnCancel();
      let firstOutputBuf = '';
      child.stdout.on('data', (chunk) => { firstOutputBuf += chunk.toString(); });
      child.stderr.on('data', (chunk) => { firstOutputBuf += chunk.toString(); });
      child.on('close', async (code) => {
        if (code === 0 || isAlreadyGoneOutput(firstOutputBuf)) {
          await onCancelSuccess(false);
          resolve(0);
          return;
        }

        log(`⚠️ 픽코 취소 실패 (exit ${code}) — 60초 후 1회 재시도: ${maskPhone(booking.phone)} ${booking.date} ${booking.start}`);
        const firstCode = code;
        setTimeoutImpl(() => {
          const retryChild = spawnCancel();
          let retryOutputBuf = '';
          retryChild.stdout.on('data', (chunk) => { retryOutputBuf += chunk.toString(); });
          retryChild.stderr.on('data', (chunk) => { retryOutputBuf += chunk.toString(); });
          retryChild.on('close', async (retryCode) => {
            if (retryCode === 0 || isAlreadyGoneOutput(retryOutputBuf)) {
              if (retryCode !== 0) {
                log(`ℹ️ 픽코 취소 대상이 이미 사라짐 → 취소 완료로 간주: ${maskPhone(booking.phone)} ${booking.date} ${booking.start}`);
              }
              await onCancelSuccess(true);
            } else {
              await onCancelFail(retryCode, firstCode);
            }
            resolve(retryCode ?? 1);
          });
        }, 60000);
      });
    });
  }

  function runPickko({
    booking,
    bookingId = null,
    scriptsDir,
    accurateScriptPath,
    maxRetries,
  }: {
    booking: Record<string, any>;
    bookingId?: string | number | null;
    scriptsDir: string;
    accurateScriptPath: string;
    maxRetries: number;
  }): Promise<number> {
    return new Promise(async (resolve) => {
      const normalized = transformAndNormalizeData(booking);
      if (!normalized) {
        log(`❌ 픽코 호출 전 변환 실패: ${JSON.stringify(booking)}`);
        if (bookingId) {
          await updateBookingState(String(bookingId), booking, 'failed');
          await Promise.resolve(sendAlert({
            type: 'error',
            title: '❌ 데이터 변환 실패',
            phone: booking.phone,
            date: booking.date,
            start: booking.start,
            time: `${booking.start}~${booking.end}`,
            room: booking.room,
            reason: '정규식 변환 실패',
            action: '수동 확인 필요',
          }));
        }
        resolve(1);
        return;
      }

      if (bookingId) {
        const currentEntry = await getReservation(String(bookingId)).catch(() => null);
        const currentRetries = currentEntry?.retries || 0;
        if (currentEntry && (
          currentEntry.status === 'completed'
          || ['manual', 'manual_retry', 'manual_pending', 'verified', 'time_elapsed'].includes(currentEntry.pickkoStatus)
        )) {
          log(`✅ [건너뜀] 이미 수동/완료 처리됨: ${maskPhone(booking.phone)} ${booking.date} ${booking.start}`);
          await markSeen(String(bookingId)).catch(() => {});
          await resolveAlertsByBooking(booking.phone, booking.date, booking.start);
          resolve(0);
          return;
        }
        if (currentRetries >= maxRetries) {
          log(`⛔ [건너뜀] 최대 재시도 초과 (${currentRetries}회): ${maskPhone(booking.phone)} ${booking.date}`);
          await Promise.resolve(publishReservationAlert({
            from_bot: 'andy',
            event_type: 'alert',
            alert_level: 3,
            message: buildPickkoRetryExceededMessage(booking, currentRetries, maxRetries),
          }));
          resolve(99);
          return;
        }
      }

      if (bookingId) {
        await updateBookingState(String(bookingId), booking, 'processing');
      }

      const customerName = String(booking.raw?.name || '고객').slice(0, 20);
      const args = buildPickkoAccurateArgs(accurateScriptPath, normalized, customerName);

      log(`✅ [변환완료] 🤖 픽코 실행 시작`);
      log(`   📞 고객: ${maskPhone(normalized.phone)}`);
      log(`   📅 날짜: ${normalized.date}`);
      log(`   ⏰ 시간: ${normalized.start}~${normalized.end} (네이버 & 픽코 등록) → 픽코 표기: ${normalized.start}~??:?? (-10분)`);
      log(`   🏛️ 룸: ${normalized.room}`);

      const child = spawnImpl(NODE_BIN, args, { cwd: scriptsDir, stdio: ['ignore', 'pipe', 'pipe'] });
      let outputBuf = '';
      child.stdout.on('data', (chunk) => { const text = chunk.toString(); safeWriteToStream(process.stdout, text); outputBuf += text; });
      child.stderr.on('data', (chunk) => { const text = chunk.toString(); safeWriteToStream(process.stderr, text); outputBuf += text; });
      child.on('close', async (code) => {
        log(`🤖 픽코 실행 종료 (exit code: ${code})`);
        const stageMatch = outputBuf.match(/PICKKO_FAILURE_STAGE=([A-Z0-9_]+)/);
        const failureStage = stageMatch ? stageMatch[1] : null;

        if (code === 2) {
          log(`⏰ [시간 경과] 픽코 등록 생략 — completed/time_elapsed 처리`);
          if (bookingId) {
            await updateReservation(String(bookingId), {
              status: 'completed',
              pickkoStatus: 'time_elapsed',
              errorReason: '시간 경과로 등록 불가',
              pickkoCompleteTime: toKst(new Date()),
            });
            await markSeen(String(bookingId)).catch(() => {});
            await resolveAlertsByBooking(booking.phone, booking.date, booking.start);
            await Promise.resolve(publishReservationAlert({
              from_bot: 'andy',
              event_type: 'alert',
              alert_level: 2,
              message: buildPickkoTimeElapsedMessage(booking),
            }));
          }
          resolve(2);
          return;
        }

        if (code === 0) {
          const alreadyRegisteredRecovered = failureStage === 'ALREADY_REGISTERED';
          const alreadyPaidWithoutButton = /결제하기 버튼 미발견/.test(outputBuf);
          if (bookingId) {
            await updateBookingState(String(bookingId), booking, 'completed');
            if (alreadyRegisteredRecovered) {
              await updateReservation(String(bookingId), { pickkoStatus: 'manual', errorReason: null });
            }
            if (alreadyRegisteredRecovered || alreadyPaidWithoutButton) {
              await reconcileSlotDuplicatesAfterRecovery(String(bookingId), booking);
            }
            await Promise.resolve(sendAlert({
              type: 'completed',
              title: alreadyRegisteredRecovered ? '✅ 픽코 예약 완료! (기존 등록 확인)' : '✅ 픽코 예약 완료!',
              customer: booking.phoneText || '고객',
              phone: booking.phone,
              date: booking.date,
              time: `${booking.start}~${booking.end}`,
              room: booking.room,
              status: alreadyRegisteredRecovered ? 'manual' : 'paid',
              action: alreadyRegisteredRecovered
                ? (alreadyPaidWithoutButton ? '기존 픽코 결제완료 예약 확인' : '기존 등록 예약 재사용')
                : '정상 처리됨',
            }));
            await Promise.resolve(ragSaveReservation(booking, alreadyRegisteredRecovered ? '픽코완료(기등록복구)' : '픽코완료'));
            await resolveAlertsByBooking(booking.phone, booking.date, booking.start);
          }
          log('✅ [완료] 픽코 예약이 성공했습니다!');
          resolve(0);
          return;
        }

        const errMatch = outputBuf.match(/❌\s*(?:에러|오류)\s*발생[:\s]+(.+)/m)
          || outputBuf.match(/OPS-CRITICAL[:\s]+(.+)/m)
          || outputBuf.match(/Error[:\s]+(.+)/m);
        const rawErrorMsg = errMatch ? errMatch[1].trim().substring(0, 200) : `exit code ${code}`;
        const errorMsg = failureStage ? `[${failureStage}] ${rawErrorMsg}` : rawErrorMsg;
        const needsManualPendingFollowup = failureStage === 'ALREADY_REGISTERED';

        if (bookingId) {
          const recovered = await verifyRecoverablePickkoFailure(String(bookingId), booking, failureStage, outputBuf);
          if (recovered) {
            resolve(0);
            return;
          }

          if (needsManualPendingFollowup) {
            await updateBookingState(String(bookingId), booking, 'completed');
            await updateReservation(String(bookingId), {
              pickkoStatus: 'manual_pending',
              errorReason: `pay_pending_failed: ${errorMsg}`,
            });
            await Promise.resolve(sendAlert({
              type: 'error',
              title: '⚠️ 픽코 예약 등록됨, 결제 확인 필요',
              customer: booking.phoneText || '고객',
              phone: booking.phone,
              date: booking.date,
              time: `${booking.start}~${booking.end}`,
              room: booking.room,
              status: 'manual_pending',
              reason: errorMsg,
              action: 'pickko-pay-scan 또는 운영 화면에서 결제대기 후속 확인 필요',
            }));
            await Promise.resolve(ragSaveReservation(booking, '픽코완료(결제대기후속필요)'));
            log(`⚠️ [manual_pending] 기존 등록 슬롯은 확인됐지만 결제 후속 확인이 필요합니다: ${maskPhone(booking.phone)} ${booking.date} ${booking.start}`);
            resolve(1);
            return;
          }

          await updateBookingState(String(bookingId), booking, 'failed');
          await updateReservation(String(bookingId), { errorReason: errorMsg });
          await Promise.resolve(sendAlert({
            type: 'error',
            title: '❌ 픽코 예약 실패',
            customer: booking.phoneText || '고객',
            phone: booking.phone,
            date: booking.date,
            start: booking.start,
            time: `${booking.start}~${booking.end}`,
            room: booking.room,
            reason: errorMsg,
            action: '수동 확인 필요',
          }));
          await Promise.resolve(ragSaveReservation(booking, '픽코실패'));

          const failedEntry = await getReservation(String(bookingId)).catch(() => null);
          const retryCount = failedEntry?.retries || 1;
          await Promise.resolve(publishReservationAlert({
            from_bot: 'andy',
            event_type: 'alert',
            alert_level: 3,
            message: buildPickkoManualFailureMessage(booking, errorMsg, retryCount, failureStage),
          }));
        }

        autoBugReport({
          title: '픽코 자동 등록 실패',
          desc: `고객:${booking.phone} / ${booking.date} ${booking.start}~${booking.end} / ${booking.room}룸 / ${errorMsg}`,
          severity: 'high',
          category: 'reliability',
        });
        log(`❌ [실패] 픽코 예약이 실패했습니다 (code=${code})`);
        resolve(code ?? 1);
      });
    });
  }

  return {
    runPickkoCancel,
    runPickko,
  };
}
