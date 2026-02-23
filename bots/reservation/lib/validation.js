/**
 * 예약 시스템 데이터 정규식 기반 변환 라이브러리
 * 모든 스크립트에서 공통으로 사용하는 정규식 기반 변환
 * 
 * 원칙:
 *   추출 → 정규식으로 변환 → 저장 → 사용할 때 포맷 변환
 * 
 * Usage:
 *   const { transformAndNormalizeData, transformPhoneNumber } = require('./lib/validation');
 *   const normalized = transformAndNormalizeData(data);  // 정규식으로 변환
 */

// ✅ 전화번호 변환: "010-3500-0586" → "01035000586"
function transformPhoneNumber(phone) {
  if (!phone) return null;
  const cleaned = String(phone).replace(/\D/g, '');
  if (!/^\d{11}$/.test(cleaned)) {
    return null; // 정규식으로 변환 불가 → null
  }
  return cleaned;
}

// ✅ 날짜 변환: "26. 2. 23" → "2026-02-23" (여러 형식 지원)
function transformDate(date) {
  if (!date) return null;
  const dateStr = String(date).trim();
  
  // 이미 YYYY-MM-DD 형식이면 그대로 반환
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr;
  }
  
  // "26. 2. 23" → "2026-02-23"
  const match1 = dateStr.match(/(\d{2})\.\s*(\d{1,2})\.\s*(\d{1,2})/);
  if (match1) {
    const yyyy = `20${match1[1]}`;
    const mm = String(parseInt(match1[2], 10)).padStart(2, '0');
    const dd = String(parseInt(match1[3], 10)).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  
  // "2026/02/23" → "2026-02-23"
  const match2 = dateStr.match(/(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})/);
  if (match2) {
    const yyyy = match2[1];
    const mm = String(parseInt(match2[2], 10)).padStart(2, '0');
    const dd = String(parseInt(match2[3], 10)).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  
  return null; // 정규식으로 변환 불가 → null
}

// ✅ 시간 변환: "오후 5:00" → "17:00" (여러 형식 지원)
function transformTime(time) {
  if (!time) return null;
  const timeStr = String(time).trim();
  
  // 이미 HH:MM 형식이면 유효성 체크 후 반환
  if (/^\d{2}:\d{2}$/.test(timeStr)) {
    const [h, m] = timeStr.split(':').map(Number);
    if (h === 24 && m === 0) return '24:00'; // 자정(하루 끝) 허용
    if (h >= 0 && h < 24 && m >= 0 && m < 60) {
      return timeStr;
    }
    return null;
  }
  
  // "오전/오후 H:MM" → "HH:MM"
  const pattern = /(오전|오후)\s*(\d{1,2}):(\d{2})/;
  const match = timeStr.match(pattern);
  if (match) {
    const period = match[1];
    const hour = parseInt(match[2], 10);
    const min = parseInt(match[3], 10);
    
    let h24 = hour;
    if (period.includes('오전')) {
      h24 = hour === 12 ? 0 : hour; // 오전 12:00 → 00:00
    } else if (period.includes('오후')) {
      h24 = hour === 12 ? 12 : hour + 12; // 오후 12:00 → 12:00, 오후 5:00 → 17:00
    }
    
    return `${String(h24).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }
  
  return null; // 정규식으로 변환 불가 → null
}

// ✅ 스터디룸 변환: "a2" → "A2" (소문자 → 대문자)
function transformRoom(room) {
  if (!room) return null;
  const roomStr = String(room).toUpperCase().trim();
  if (!/^[A-Z]\d*$/.test(roomStr) && !/^[A-Z]$/.test(roomStr)) {
    return null; // 정규식으로 변환 불가 → null
  }
  return roomStr;
}

// ✅ BookingID 변환: 숫자만 추출
function transformBookingId(bookingId) {
  if (!bookingId) return null;
  const idStr = String(bookingId).replace(/\D/g, '');
  if (!/^\d+$/.test(idStr)) {
    return null; // 정규식으로 변환 불가 → null
  }
  return idStr;
}

// ✅ 통합 변환 함수: 모든 필드를 정규식으로 변환하여 저장 형식으로 정규화
function transformAndNormalizeData(data, options = {}) {
  const { strict = true, log = null } = options;
  
  if (!data || typeof data !== 'object') {
    if (log) log(`⚠️ 데이터 타입 오류: ${typeof data}`);
    return null;
  }

  const normalized = {};
  const errors = [];

  // 1️⃣ 전화번호 (필수) - 정규식으로 변환
  const phoneTransformed = transformPhoneNumber(data.phone);
  if (phoneTransformed === null) {
    errors.push(`전화번호 변환 실패: ${data.phone}`);
    if (strict) return null; // 필수 필드 변환 불가
  } else {
    normalized.phone = phoneTransformed;
  }

  // 2️⃣ 날짜 (필수) - 정규식으로 변환
  const dateTransformed = transformDate(data.date);
  if (dateTransformed === null) {
    errors.push(`날짜 변환 실패: ${data.date}`);
    if (strict) return null;
  } else {
    normalized.date = dateTransformed;
  }

  // 3️⃣ 시작시간 (필수) - 정규식으로 변환
  const startTimeTransformed = transformTime(data.start);
  if (startTimeTransformed === null) {
    errors.push(`시작시간 변환 실패: ${data.start}`);
    if (strict) return null;
  } else {
    normalized.start = startTimeTransformed;
  }

  // 4️⃣ 종료시간 (필수) - 정규식으로 변환
  const endTimeTransformed = transformTime(data.end);
  if (endTimeTransformed === null) {
    errors.push(`종료시간 변환 실패: ${data.end}`);
    if (strict) return null;
  } else {
    normalized.end = endTimeTransformed;
  }

  // 5️⃣ 스터디룸 (필수) - 정규식으로 변환
  const roomTransformed = transformRoom(data.room);
  if (roomTransformed === null) {
    errors.push(`룸 변환 실패: ${data.room}`);
    if (strict) return null;
  } else {
    normalized.room = roomTransformed;
  }

  // 6️⃣ BookingID (선택) - 정규식으로 변환
  const bookingIdTransformed = transformBookingId(data.bookingId);
  if (bookingIdTransformed !== null) {
    normalized.bookingId = bookingIdTransformed;
  }

  // 7️⃣ 원본 데이터 유지 (raw)
  if (data.raw) {
    normalized.raw = data.raw;
  }

  if (errors.length > 0 && log) {
    log(`⚠️ 데이터 변환 실패: ${errors.join(', ')}`);
  }

  return normalized;
}

// ✅ 시간 범위 검증: start < end인지 확인
function validateTimeRange(start, end) {
  if (!start || !end) return { ok: false, error: '시작/종료시간 없음' };
  
  const [sh, sm] = String(start).split(':').map(Number);
  const [eh, em] = String(end).split(':').map(Number);
  
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  
  // 자정 넘어가는 경우 처리 (예: 23:00 ~ 00:30)
  let isValid = false;
  let isCrossMidnight = false;
  
  if (endMin > startMin) {
    isValid = true;
  } else if (endMin < startMin) {
    // 자정 넘어가는 경우로 간주
    isValid = true;
    isCrossMidnight = true;
  }
  
  if (!isValid) {
    return { ok: false, error: `종료시간이 시작시간보다 앞: ${start} → ${end}` };
  }
  
  return { ok: true, isCrossMidnight };
}

// ============ 📤 포맷 변환 함수 ============
// 저장된 정규화 데이터 → 사용처에 맞는 포맷으로 변환

// ✅ 전화번호 포맷: 01035000586 → 010-3500-0586
function formatPhoneNumber(phone) {
  if (!phone) return null;
  const cleaned = String(phone).replace(/\D/g, '');
  if (!/^\d{11}$/.test(cleaned)) return phone; // 형식 오류면 원본 반환
  return `${cleaned.slice(0, 3)}-${cleaned.slice(3, 7)}-${cleaned.slice(7)}`;
}

// ✅ 날짜 포맷: 2026-02-23 → 여러 형식 지원
function formatDate(date, format = 'YYYY-MM-DD') {
  if (!date) return null;
  const dateStr = String(date);
  
  if (format === 'YYYY-MM-DD') {
    return dateStr; // 그대로 반환 (정규화 형식)
  } else if (format === 'YYYY/MM/DD') {
    return dateStr.replace(/-/g, '/');
  } else if (format === 'YY.M.D') {
    // 2026-02-23 → 26.2.23
    const [yyyy, mm, dd] = dateStr.split('-');
    const yy = yyyy.slice(2);
    const m = String(parseInt(mm, 10));
    const d = String(parseInt(dd, 10));
    return `${yy}.${m}.${d}`;
  } else if (format === 'YYYY년MM월DD일') {
    const [yyyy, mm, dd] = dateStr.split('-');
    return `${yyyy}년${parseInt(mm, 10)}월${parseInt(dd, 10)}일`;
  }
  
  return dateStr; // 기본값
}

// ✅ 시간 포맷: 17:00 → 여러 형식 지원
function formatTime(time, format = 'HH:MM') {
  if (!time) return null;
  const timeStr = String(time);
  
  if (format === 'HH:MM') {
    return timeStr; // 그대로 반환 (정규화 형식)
  } else if (format === 'H:MM') {
    // 17:00 → 17:00 (이미 정규화되어 있음)
    return timeStr;
  } else if (format === '오전/오후 H:MM') {
    // 17:00 → 오후 5:00
    const [h, m] = timeStr.split(':').map(Number);
    const period = h < 12 ? '오전' : '오후';
    const displayHour = h === 0 ? 12 : (h > 12 ? h - 12 : h);
    return `${period} ${displayHour}:${String(m).padStart(2, '0')}`;
  }
  
  return timeStr; // 기본값
}

// ✅ 스터디룸 포맷: A2 → 여러 형식 지원
function formatRoom(room, format = 'CODE') {
  if (!room) return null;
  const roomStr = String(room).toUpperCase().trim();
  
  if (format === 'CODE') {
    return roomStr; // 그대로 반환 (A1, A2, B)
  } else if (format === 'DESCRIPTION') {
    // A1 → A1룸, A2 → A2룸, B → B룸
    return `${roomStr}룸`;
  } else if (format === 'FULL') {
    // A1 → A1룸 (2인 최적, 최대 4인)
    const descriptions = {
      'A1': 'A1룸 (2인 최적, 최대 4인)',
      'A2': 'A2룸 (2인 최적, 최대 4인)',
      'B': 'B룸 (4인 이상)'
    };
    return descriptions[roomStr] || roomStr;
  }
  
  return roomStr; // 기본값
}

// ✅ BookingID 포맷: 1164673607 → 여러 형식 지원
function formatBookingId(bookingId, format = 'NUMBER') {
  if (!bookingId) return null;
  const idStr = String(bookingId);
  
  if (format === 'NUMBER') {
    return idStr; // 그대로 반환
  } else if (format === 'CODE') {
    // 1164673607 → BK-1164673607
    return `BK-${idStr}`;
  }
  
  return idStr; // 기본값
}

// ============ 🔄 통합 포맷 변환 함수 ============
// 정규화된 데이터 객체 → 사용처에 맞는 포맷으로 변환
function formatDataForUsage(normalized, targets = {}) {
  if (!normalized) return null;
  
  const {
    phoneFormat = 'DISPLAY',    // 'DISPLAY' (010-3500-0586) or 'RAW' (01035000586)
    dateFormat = 'YYYY-MM-DD',  // ISO 8601
    timeFormat = 'HH:MM',       // 24시간
    roomFormat = 'CODE'         // CODE (A1) or DESCRIPTION (A1룸)
  } = targets;

  const formatted = {};

  // 전화번호
  if (normalized.phone) {
    formatted.phone = phoneFormat === 'DISPLAY' 
      ? formatPhoneNumber(normalized.phone)
      : normalized.phone;
    formatted.phoneRaw = normalized.phone; // 항상 정규화된 형식도 유지
  }

  // 날짜
  if (normalized.date) {
    formatted.date = formatDate(normalized.date, dateFormat);
    formatted.dateRaw = normalized.date; // 항상 정규화된 형식도 유지
  }

  // 시작시간
  if (normalized.start) {
    formatted.start = formatTime(normalized.start, timeFormat);
    formatted.startRaw = normalized.start; // 항상 정규화된 형식도 유지
  }

  // 종료시간
  if (normalized.end) {
    formatted.end = formatTime(normalized.end, timeFormat);
    formatted.endRaw = normalized.end; // 항상 정규화된 형식도 유지
  }

  // 스터디룸
  if (normalized.room) {
    formatted.room = formatRoom(normalized.room, roomFormat);
    formatted.roomRaw = normalized.room; // 항상 정규화된 형식도 유지
  }

  // BookingID
  if (normalized.bookingId) {
    formatted.bookingId = formatBookingId(normalized.bookingId, 'NUMBER');
  }

  // 원본 데이터
  if (normalized.raw) {
    formatted.raw = normalized.raw;
  }

  return formatted;
}

module.exports = {
  // 정규식 기반 변환 함수 (추출 데이터 → 저장 형식)
  transformPhoneNumber,
  transformDate,
  transformTime,
  transformRoom,
  transformBookingId,
  transformAndNormalizeData,
  validateTimeRange,
  
  // 포맷 변환 함수 (저장 형식 → 사용처 맞춤)
  formatPhoneNumber,
  formatDate,
  formatTime,
  formatRoom,
  formatBookingId,
  formatDataForUsage
};
