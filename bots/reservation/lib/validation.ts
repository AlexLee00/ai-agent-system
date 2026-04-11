export function transformPhoneNumber(phone: unknown): string | null {
  if (!phone) return null;
  const cleaned = String(phone).replace(/\D/g, '');
  if (!/^\d{11}$/.test(cleaned)) return null;
  return cleaned;
}

export function transformDate(date: unknown): string | null {
  if (!date) return null;
  const dateStr = String(date).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;

  const match1 = dateStr.match(/(\d{2})\.\s*(\d{1,2})\.\s*(\d{1,2})/);
  if (match1) {
    const yyyy = `20${match1[1]}`;
    const mm = String(parseInt(match1[2], 10)).padStart(2, '0');
    const dd = String(parseInt(match1[3], 10)).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  const match2 = dateStr.match(/(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})/);
  if (match2) {
    const yyyy = match2[1];
    const mm = String(parseInt(match2[2], 10)).padStart(2, '0');
    const dd = String(parseInt(match2[3], 10)).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  return null;
}

export function transformTime(time: unknown): string | null {
  if (!time) return null;
  const timeStr = String(time).trim();

  if (/^\d{2}:\d{2}$/.test(timeStr)) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    if (hours === 24 && minutes === 0) return '24:00';
    if (hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60) return timeStr;
    return null;
  }

  const match = timeStr.match(/(오전|오후)\s*(\d{1,2}):(\d{2})/);
  if (match) {
    const period = match[1];
    const hour = parseInt(match[2], 10);
    const minute = parseInt(match[3], 10);
    let h24 = hour;

    if (period.includes('오전')) {
      h24 = hour === 12 ? 0 : hour;
    } else if (period.includes('오후')) {
      h24 = hour === 12 ? 12 : hour + 12;
    }

    return `${String(h24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  return null;
}

export function transformRoom(room: unknown): string | null {
  if (!room) return null;
  const roomStr = String(room).toUpperCase().trim();
  if (!/^[A-Z]\d*$/.test(roomStr) && !/^[A-Z]$/.test(roomStr)) return null;
  return roomStr;
}

export function transformBookingId(bookingId: unknown): string | null {
  if (!bookingId) return null;
  const idStr = String(bookingId).replace(/\D/g, '');
  if (!/^\d+$/.test(idStr)) return null;
  return idStr;
}

export function transformAndNormalizeData(
  data: Record<string, unknown> | null | undefined,
  options: { strict?: boolean; log?: ((message: string) => void) | null } = {},
): Record<string, unknown> | null {
  const { strict = true, log = null } = options;

  if (!data || typeof data !== 'object') {
    log?.(`⚠️ 데이터 타입 오류: ${typeof data}`);
    return null;
  }

  const normalized: Record<string, unknown> = {};
  const errors: string[] = [];

  const phoneTransformed = transformPhoneNumber(data.phone);
  if (phoneTransformed === null) {
    errors.push(`전화번호 변환 실패: ${data.phone}`);
    if (strict) return null;
  } else {
    normalized.phone = phoneTransformed;
  }

  const dateTransformed = transformDate(data.date);
  if (dateTransformed === null) {
    errors.push(`날짜 변환 실패: ${data.date}`);
    if (strict) return null;
  } else {
    normalized.date = dateTransformed;
  }

  const startTimeTransformed = transformTime(data.start);
  if (startTimeTransformed === null) {
    errors.push(`시작시간 변환 실패: ${data.start}`);
    if (strict) return null;
  } else {
    normalized.start = startTimeTransformed;
  }

  const endTimeTransformed = transformTime(data.end);
  if (endTimeTransformed === null) {
    errors.push(`종료시간 변환 실패: ${data.end}`);
    if (strict) return null;
  } else {
    normalized.end = endTimeTransformed;
  }

  const roomTransformed = transformRoom(data.room);
  if (roomTransformed === null) {
    errors.push(`룸 변환 실패: ${data.room}`);
    if (strict) return null;
  } else {
    normalized.room = roomTransformed;
  }

  const bookingIdTransformed = transformBookingId(data.bookingId);
  if (bookingIdTransformed !== null) {
    normalized.bookingId = bookingIdTransformed;
  }

  if (data.raw) {
    normalized.raw = data.raw;
  }

  if (errors.length > 0) {
    log?.(`⚠️ 데이터 변환 실패: ${errors.join(', ')}`);
  }

  return normalized;
}

export function validateTimeRange(start: unknown, end: unknown): { ok: boolean; error?: string; isCrossMidnight?: boolean } {
  if (!start || !end) return { ok: false, error: '시작/종료시간 없음' };

  const [startHour, startMinute] = String(start).split(':').map(Number);
  const [endHour, endMinute] = String(end).split(':').map(Number);

  const startMin = startHour * 60 + startMinute;
  const endMin = endHour * 60 + endMinute;

  let isValid = false;
  let isCrossMidnight = false;

  if (endMin > startMin) {
    isValid = true;
  } else if (endMin < startMin) {
    isValid = true;
    isCrossMidnight = true;
  }

  if (!isValid) {
    return { ok: false, error: `종료시간이 시작시간보다 앞: ${start} → ${end}` };
  }

  return { ok: true, isCrossMidnight };
}
