export function buildPickkoCancelArgs(baseScriptPath: string, booking: Record<string, any>): string[] {
  const phoneRawForKey = String(booking.phoneRaw || booking.phone || '').replace(/\D/g, '');
  return [
    baseScriptPath,
    `--phone=${phoneRawForKey}`,
    `--date=${booking.date}`,
    `--start=${booking.start}`,
    `--end=${booking.end}`,
    `--room=${booking.room}`,
    `--name=${String(booking.raw?.name || '고객').slice(0, 20)}`,
  ];
}

export function buildPickkoAccurateArgs(baseScriptPath: string, normalized: Record<string, any>, customerName: string): string[] {
  return [
    baseScriptPath,
    `--phone=${normalized.phone}`,
    `--date=${normalized.date}`,
    `--start=${normalized.start}`,
    `--end=${normalized.end}`,
    `--room=${normalized.room}`,
    `--name=${customerName}`,
  ];
}

export function buildPickkoCancelManualMessage(booking: Record<string, any>): string {
  return (
    `🚨 픽코 취소 실패 — 수동 처리 필요!\n\n`
    + `📞 고객: ${booking.phone}\n`
    + `📅 날짜: ${booking.date}\n`
    + `⏰ 시간: ${booking.start}~${booking.end} (${booking.room}룸)\n\n`
    + `픽코에서 직접 취소해 주세요!\n처리 후 '완료' 라고 답장해 주세요.`
  );
}

export function buildPickkoRetryExceededMessage(booking: Record<string, any>, currentRetries: number, maxRetries: number): string {
  return (
    `⛔ 픽코 등록 포기 — 최대 재시도 초과!\n\n`
    + `📞 고객: ${booking.phone}\n📅 날짜: ${booking.date}\n`
    + `⏰ 시간: ${booking.start}~${booking.end} (${booking.room}룸)\n`
    + `🔄 시도 횟수: ${currentRetries}회 (한도: ${maxRetries}회)\n\n`
    + `픽코에서 직접 등록해 주세요!\n처리 후 '완료' 라고 답장해 주세요.`
  );
}

export function buildPickkoTimeElapsedMessage(booking: Record<string, any>): string {
  return (
    `⏰ 시간 경과 — 픽코 등록 생략\n\n`
    + `📞 고객: ${booking.phone}\n`
    + `📅 날짜: ${booking.date}\n`
    + `⏰ 요청: ${booking.start}~${booking.end} (${booking.room}룸)\n\n`
    + `예약 시작 시각이 이미 지나 픽코 슬롯 선택 불가.\n픽코에서 직접 확인 후 필요 시 등록해 주세요.`
  );
}

export function buildPickkoManualFailureMessage(
  booking: Record<string, any>,
  errorMsg: string,
  retryCount: number,
  failureStage?: string | null,
): string {
  return (
    `🚨 픽코 등록 실패 — 수동 처리 필요!\n\n`
    + `📞 고객: ${booking.phone}\n`
    + `📅 날짜: ${booking.date}\n`
    + `⏰ 시간: ${booking.start}~${booking.end} (${booking.room}룸)\n`
    + `🔄 시도 횟수: ${retryCount}회\n`
    + (failureStage ? `🧩 실패 단계: ${failureStage}\n` : '')
    + `❌ 원인: ${errorMsg}\n\n`
    + `픽코에서 직접 등록해 주세요!\n처리 후 '완료' 라고 답장해 주세요.`
  );
}
