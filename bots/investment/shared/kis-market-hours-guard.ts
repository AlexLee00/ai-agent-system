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

function isKrHoliday(kstDate) {
  return KR_HOLIDAYS_2026.has(yyyymmdd(kstDate));
}

function isUsHoliday(kstDate) {
  // US 날짜는 KST - 14~15시간 → 대략 KST 날짜 기준으로 체크 (보수적)
  return US_HOLIDAYS_2026.has(yyyymmdd(kstDate));
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
    // 서머타임(EDT): KST 22:30~05:00, 표준시(EST): KST 23:30~06:00
    const dst = isDst(now);
    openMins = dst ? 22 * 60 + 30 : 23 * 60 + 30;
    closeMins = dst ? 5 * 60 : 6 * 60;
    holiday = isUsHoliday(kst);
    // 야간 세션: 개장이 closeMins보다 큼 → wrap-around
    const inWindow = mins >= openMins || mins <= closeMins;
    isOpen = weekday && !holiday && inWindow;
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

  const isDomestic = String(market).toLowerCase().includes('domestic') ||
                     String(market).toLowerCase() === 'kis';
  const isOverseas = !isDomestic;

  const kst = toKst(now);
  let candidate = new Date(kst);
  candidate.setSeconds(0, 0);

  // 최대 7일 앞을 탐색 (주말 + 공휴일 연속)
  for (let i = 0; i < 7 * 24 * 60; i += 1) {
    candidate = new Date(candidate.getTime() + 60_000); // 1분씩 전진
    const c = evaluateKisMarketHours({ market, now: new Date(candidate.getTime() - (9 * 3600_000)) });
    // candidate는 이미 KST이므로 UTC 변환 없이 넘기면 안됨 — 재계산
    const evalResult = evaluateKisMarketHours({
      market,
      now: new Date(candidate.getTime() - (9 * 60 * 60 * 1000)),
    });
    if (evalResult.isOpen) {
      return {
        nextOpen: new Date(candidate.getTime() - (9 * 60 * 60 * 1000)),
        alreadyOpen: false,
        market,
        kst: candidate.toISOString(),
        minutesUntilOpen: Math.round((candidate.getTime() - kst.getTime()) / 60_000),
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

export default {
  evaluateKisMarketHours,
  getNextOpenTime,
  deferSignal,
  getDeferredSignals,
  flushDeferredSignals,
};
