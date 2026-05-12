// @ts-nocheck
/**
 * kis-market-hours-guard — KIS 국내/해외 장 시간 체크 + 신호 deferred 큐
 *
 * 한국장:   KST 09:00~15:30 (월~금)
 * 미국장:   KST 23:30~06:00 (+1) (월~금, 서머타임 시 22:30~05:00)
 * 신호 defer: 장 외 시간에 도착한 KIS 신호를 다음 개장 시까지 보류
 */

// KST 기준 2026년 한국 공휴일 (간소화, 핵심만)
const KR_HOLIDAYS_2026 = new Set([
  '2026-01-01', '2026-01-28', '2026-01-29', '2026-01-30',
  '2026-03-01', '2026-05-05', '2026-05-25', '2026-06-06',
  '2026-08-15', '2026-09-24', '2026-09-25', '2026-09-26',
  '2026-10-03', '2026-10-09', '2026-12-25',
]);

// US NYSE/NASDAQ 공휴일 2026 (간소화)
const US_HOLIDAYS_2026 = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03',
  '2026-05-25', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
]);

function toKst(date = new Date()) {
  return new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
}

function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function yyyymmdd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function timeZoneParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour === '24' ? 0 : parts.hour);
  const minute = Number(parts.minute || 0);
  return {
    weekday: parts.weekday,
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    minutesOfDay: hour * 60 + minute,
  };
}

function isKrHoliday(kstDate) {
  return KR_HOLIDAYS_2026.has(yyyymmdd(kstDate));
}

function isUsHolidayByDateStr(dateStr) {
  return US_HOLIDAYS_2026.has(dateStr);
}

// 서머타임 여부 추정 (EDT: 3월 2번째 일 ~ 11월 1번째 일)
function isDst(date) {
  const y = date.getFullYear();
  const marchStart = new Date(y, 2, 1);
  while (marchStart.getDay() !== 0) marchStart.setDate(marchStart.getDate() + 1);
  marchStart.setDate(marchStart.getDate() + 7);

  const novStart = new Date(y, 10, 1);
  while (novStart.getDay() !== 0) novStart.setDate(novStart.getDate() + 1);

  return date >= marchStart && date < novStart;
}

export function evaluateKisMarketHours({ market = 'domestic', now = new Date() } = {}) {
  const kst = toKst(now);
  const day = kst.getDay(); // 0=일, 6=토
  const mins = minutesOfDay(kst);
  const weekday = day >= 1 && day <= 5;
  const dateStr = yyyymmdd(kst);

  const isDomestic = String(market).toLowerCase().includes('domestic') ||
                     String(market).toLowerCase() === 'kis';
  const isOverseas = String(market).toLowerCase().includes('overseas') ||
                     String(market).toLowerCase().includes('us') ||
                     String(market).toLowerCase().includes('usa');

  let isOpen = false;
  let openMins = 0;
  let closeMins = 0;
  let holiday = false;

  if (isDomestic) {
    openMins = 9 * 60;       // 09:00 KST
    closeMins = 15 * 60 + 30; // 15:30 KST
    holiday = isKrHoliday(kst);
    isOpen = weekday && !holiday && mins >= openMins && mins <= closeMins;
  } else if (isOverseas) {
    const ny = timeZoneParts(now, 'America/New_York');
    openMins = 9 * 60 + 30;
    closeMins = 16 * 60;
    holiday = isUsHolidayByDateStr(ny.dateStr);
    const nyWeekday = !['Sat', 'Sun'].includes(ny.weekday || '');
    isOpen = nyWeekday && !holiday && ny.minutesOfDay >= openMins && ny.minutesOfDay < closeMins;
    return {
      market,
      isOpen,
      state: isOpen ? 'open' : 'closed',
      reasonCode: holiday ? 'holiday' : isOpen ? 'kis_market_open' : 'kis_market_closed',
      nextAction: isOpen ? 'allow' : 'defer_until_open',
      kst: kst.toISOString(),
      dateStr,
      marketDateStr: ny.dateStr,
      marketTimezone: 'America/New_York',
      minutesOfDay: ny.minutesOfDay,
    };
  }

  return {
    market,
    isOpen,
    state: isOpen ? 'open' : 'closed',
    reasonCode: holiday ? 'holiday' : isOpen ? 'kis_market_open' : 'kis_market_closed',
    nextAction: isOpen ? 'allow' : 'defer_until_open',
    kst: kst.toISOString(),
    dateStr,
    minutesOfDay: mins,
  };
}

/**
 * 다음 개장 시각 반환 (KST Date 기준 UTC Date 반환).
 * 현재 개장 중이면 now를 그대로 반환.
 */
export function getNextOpenTime({ market = 'domestic', now = new Date() } = {}) {
  const check = evaluateKisMarketHours({ market, now });
  if (check.isOpen) return { nextOpen: now, alreadyOpen: true, market };

  let candidate = new Date(now);
  candidate.setSeconds(0, 0);

  // 최대 7일 앞을 UTC 기준으로 탐색한다. 국내장은 KST, 해외장은 ET 기준
  // 판정 함수가 자체 time zone을 적용하므로 후보 Date를 변환하지 않는다.
  for (let i = 0; i < 7 * 24 * 60; i += 1) {
    candidate = new Date(candidate.getTime() + 60_000);
    const evalResult = evaluateKisMarketHours({ market, now: candidate });
    if (evalResult.isOpen) {
      return {
        nextOpen: candidate,
        alreadyOpen: false,
        market,
        kst: toKst(candidate).toISOString(),
        minutesUntilOpen: Math.round((candidate.getTime() - now.getTime()) / 60_000),
      };
    }
  }
  return { nextOpen: null, alreadyOpen: false, market, reasonCode: 'no_open_found_in_7d' };
}

// ── Deferred Signal Queue ─────────────────────────────────────────────────────

const _deferredQueue = new Map(); // key: signal.id → { signal, market, deferredAt, nextOpen }

export function deferSignal(signal, market = 'domestic', now = new Date()) {
  const next = getNextOpenTime({ market, now });
  const key = String(signal.id ?? signal.signal_id ?? `${signal.symbol}:${Date.now()}`);
  _deferredQueue.set(key, {
    signal,
    market,
    deferredAt: now.toISOString(),
    nextOpen: next.nextOpen?.toISOString() ?? null,
    minutesUntilOpen: next.minutesUntilOpen ?? null,
  });
  return {
    ok: true,
    key,
    market,
    deferredAt: now.toISOString(),
    nextOpen: next.nextOpen?.toISOString() ?? null,
    minutesUntilOpen: next.minutesUntilOpen ?? null,
  };
}

export function getDeferredSignals(market = null) {
  const entries = Array.from(_deferredQueue.values());
  if (market) return entries.filter((e) => e.market === market);
  return entries;
}

export function flushDeferredSignals(market = null, now = new Date()) {
  const ready = [];
  const still = [];
  for (const [key, entry] of _deferredQueue.entries()) {
    if (market && entry.market !== market) continue;
    const check = evaluateKisMarketHours({ market: entry.market, now });
    if (check.isOpen) {
      ready.push(entry);
      _deferredQueue.delete(key);
    } else {
      still.push(entry);
    }
  }
  return { ready, still, readyCount: ready.length, stillCount: still.length };
}

// ── KIS 시간대 우선순위 정책 ────────────────────────────────────────────────
// 데이터 기반: 33 LIVE 거래 분석 (2026-05-12)
// 09시: 13건 15.4% 승률 -$186 → 차단
// 12-13시: 7건 42.9% 승률 +$18 → 우선
// 15시: 5건 0% 승률 -$110 → 차단

export interface KisTimeSlotPolicy {
  hour: number;
  allow: boolean;
  priority: 'high' | 'medium' | 'low' | 'avoid';
  rationale: string;
}

export const KIS_TIME_SLOT_POLICY: KisTimeSlotPolicy[] = [
  { hour: 9,  allow: false, priority: 'avoid',  rationale: '장시작 변동성 15.4% 승률 -$186' },
  { hour: 10, allow: true,  priority: 'medium', rationale: '안정 시작' },
  { hour: 11, allow: true,  priority: 'medium', rationale: '오전 중반' },
  { hour: 12, allow: true,  priority: 'high',   rationale: '점심 안정 42.9% 승률 +$18' },
  { hour: 13, allow: true,  priority: 'high',   rationale: '점심 안정 42.9% 승률 +$18' },
  { hour: 14, allow: true,  priority: 'medium', rationale: '오후 안정' },
  { hour: 15, allow: false, priority: 'avoid',  rationale: '마감 임박 0% 승률 -$110' },
];

export function getKisTimeSlotPolicy(now: Date = new Date()): KisTimeSlotPolicy {
  const kstHour = parseInt(
    now.toLocaleString('en-US', { timeZone: 'Asia/Seoul', hour: 'numeric', hour12: false })
  );
  return KIS_TIME_SLOT_POLICY.find((p) => p.hour === kstHour) ?? {
    hour: kstHour,
    allow: false,
    priority: 'avoid',
    rationale: '거래 시간 외',
  };
}

export function isKisBlockedHour(now: Date = new Date()): boolean {
  const policy = getKisTimeSlotPolicy(now);
  return !policy.allow;
}

export function isKisAllowedTime(now: Date = new Date()): boolean {
  return !isKisBlockedHour(now);
}

export function isKisPreferredHour(now: Date = new Date()): boolean {
  const policy = getKisTimeSlotPolicy(now);
  return policy.priority === 'high';
}

export function evaluateKisTimeSlotPolicy(now: Date = new Date()) {
  const policy = getKisTimeSlotPolicy(now);
  return {
    ...policy,
    allowed: policy.allow,
    blocked: !policy.allow,
    preferred: policy.priority === 'high',
    shadowOnly: true,
  };
}

export default {
  evaluateKisMarketHours,
  getNextOpenTime,
  deferSignal,
  getDeferredSignals,
  flushDeferredSignals,
  getKisTimeSlotPolicy,
  isKisBlockedHour,
  isKisAllowedTime,
  isKisPreferredHour,
  evaluateKisTimeSlotPolicy,
  KIS_TIME_SLOT_POLICY,
};
