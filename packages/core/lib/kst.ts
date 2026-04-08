/**
 * packages/core/lib/kst.js — 팀 제이 KST 시간 유틸리티
 *
 * 모든 팀 공통 사용. 외부 의존성 없음 (Node.js 내장 Intl 사용).
 *
 * 핵심 원칙:
 *   - new Date().toISOString() → UTC → KST 날짜 오차 가능 (자정 전후 ±1일)
 *   - 이 모듈의 today(), timeStr() 등은 항상 KST 기준
 *   - macOS launchd StartCalendarInterval = 로컬 시간(KST) 기준 → UTC 변환 불필요
 */

const TZ         = 'Asia/Seoul';
const KST_OFFSET = 9 * 60 * 60 * 1000;  // +09:00 in ms

// ── KST 날짜/시간 변환 ──────────────────────────────────────────────────

/** KST 기준 오늘 날짜 문자열 (YYYY-MM-DD) */
export function today(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
}

/** KST 기준 현재 시각 문자열 (HH:MM:SS) */
export function timeStr(): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date());
}

/** KST 기준 현재 날짜+시각 문자열 (YYYY-MM-DD HH:MM:SS) */
export function datetimeStr(): string {
  return `${today()} ${timeStr()}`;
}

/** 임의 Date 객체를 KST 로케일 문자열로 변환 */
export function toKST(date: Date | string | number): string {
  return (date instanceof Date ? date : new Date(date))
    .toLocaleString('ko-KR', { timeZone: TZ });
}

/** KST 기준 현재 시(hour) 반환 (0~23) */
export function currentHour(date?: Date): number {
  const d = date || new Date();
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false })
    .formatToParts(d);
  return parseInt(parts.find((p: Intl.DateTimeFormatPart) => p.type === 'hour')?.value || '0', 10) % 24;
}

/** KST 기준 현재 분(minute) 반환 (0~59) */
export function currentMinute(date?: Date): number {
  const d = date || new Date();
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, minute: 'numeric', hour12: false })
    .formatToParts(d);
  return parseInt(parts.find((p: Intl.DateTimeFormatPart) => p.type === 'minute')?.value || '0', 10);
}

/** KST 기준 오늘 특정 시각의 Date 객체 (ISO 8601 +09:00 사용) */
export function todayAt(hour: number, minute = 0, second = 0): Date {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  const ss = String(second).padStart(2, '0');
  return new Date(`${today()}T${hh}:${mm}:${ss}+09:00`);
}

// ── 미국 서머타임(DST) 판단 ──────────────────────────────────────────────

/**
 * 미국 동부 서머타임(EDT) 여부 판단
 * EDT = Eastern Daylight Time (3월 둘째 일요일 ~ 11월 첫째 일요일)
 * @param {Date} [date=new Date()]
 * @returns {boolean}
 */
export function isDST(date?: Date) {
  const d = date || new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  }).formatToParts(d);
  return parts.find((p: Intl.DateTimeFormatPart) => p.type === 'timeZoneName')?.value === 'EDT';
}

// ── 장 시간 상수 ─────────────────────────────────────────────────────────

export const MARKET_HOURS = {
  domestic: {
    open:      { hour: 9,  minute: 0 },
    close:     { hour: 15, minute: 30 },
    premarket: { hour: 8,  minute: 30 },
  },
  overseas: {
    // 비서머타임 (EST): KST 23:30~06:00
    open:         { hour: 23, minute: 30 },
    close:        { hour: 6,  minute: 0 },
    // 서머타임 (EDT): KST 22:30~05:00
    summer_open:  { hour: 22, minute: 30 },
    summer_close: { hour: 5,  minute: 0 },
  },
};

// ── 장 개장 판단 ─────────────────────────────────────────────────────────

/**
 * 특정 시장이 현재 개장 중인지 판단
 * @param {'domestic'|'overseas'|'crypto'} market
 * @returns {boolean}
 */
export function isMarketOpen(market: 'domestic' | 'overseas' | 'crypto'): boolean {
  if (market === 'crypto') return true;

  const h   = currentHour();
  const min = currentMinute();
  const now = h * 60 + min;

  if (market === 'domestic') {
    const mh    = MARKET_HOURS.domestic;
    const open  = mh.open.hour * 60 + mh.open.minute;
    const close = mh.close.hour * 60 + mh.close.minute;
    return now >= open && now < close;
  }

  if (market === 'overseas') {
    const dst      = isDST();
    const open     = dst ? MARKET_HOURS.overseas.summer_open  : MARKET_HOURS.overseas.open;
    const close    = dst ? MARKET_HOURS.overseas.summer_close : MARKET_HOURS.overseas.close;
    const openMin  = open.hour * 60 + open.minute;
    const closeMin = close.hour * 60 + close.minute;
    // 자정을 넘기는 구간 (23:30 ~ 06:00)
    return now >= openMin || now < closeMin;
  }

  return false;
}

/**
 * 특정 시장의 개장/폐장 시각 반환 (KST 기준, 서머타임 자동 반영)
 * @param {'domestic'|'overseas'|'crypto'} market
 */
export function getMarketHours(market: 'domestic' | 'overseas' | 'crypto'): { open: string; close: string; dst: boolean; premarket?: string } | { open: '24시간'; close: '24시간'; dst: false } | null {
  const fmt = ({ hour, minute }: { hour: number; minute: number }) =>
    `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  if (market === 'crypto') {
    return { open: '24시간', close: '24시간', dst: false };
  }
  if (market === 'domestic') {
    const mh = MARKET_HOURS.domestic;
    return {
      open:      fmt(mh.open),
      close:     fmt(mh.close),
      premarket: fmt(mh.premarket),
      dst:       false,
    };
  }
  if (market === 'overseas') {
    const dst   = isDST();
    const open  = dst ? MARKET_HOURS.overseas.summer_open  : MARKET_HOURS.overseas.open;
    const close = dst ? MARKET_HOURS.overseas.summer_close : MARKET_HOURS.overseas.close;
    return { open: fmt(open), close: fmt(close), dst };
  }
  return null;
}

// ── launchd 헬퍼 ─────────────────────────────────────────────────────────

/**
 * KST 시각을 launchd plist용 Hour/Minute으로 반환
 * ⚠️ macOS launchd StartCalendarInterval = 로컬 시간(KST) 기준
 *    → UTC 변환 불필요, KST 시각을 그대로 사용!
 *
 * @param {number} hour   KST 시 (0~23)
 * @param {number} minute KST 분 (0~59)
 */
export function toLaunchdTime(hour: number, minute = 0): { Hour: number; Minute: number } {
  return { Hour: hour, Minute: minute };
}

// ── 유틸리티 ─────────────────────────────────────────────────────────────

/** N분 전 Date 객체 */
export function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60 * 1000);
}

/** N시간 전 Date 객체 */
export function hoursAgo(n: number): Date {
  return new Date(Date.now() - n * 60 * 60 * 1000);
}

/** N일 전 KST 날짜 문자열 (YYYY-MM-DD) */
export function daysAgoStr(n: number): string {
  return new Date(Date.now() - n * 86400 * 1000).toLocaleDateString('sv-SE', { timeZone: TZ });
}

/** 두 날짜 간의 일수 차이 (절대값) */
export function daysBetween(date1: Date | string | number, date2: Date | string | number): number {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  return Math.floor(Math.abs(d2.getTime() - d1.getTime()) / 86400000);
}

// ── 내보내기 ─────────────────────────────────────────────────────────────


export { KST_OFFSET, TZ };
