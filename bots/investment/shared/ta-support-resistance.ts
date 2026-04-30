// @ts-nocheck
// ta-support-resistance.ts — 지지/저항선 감지 모듈 (Phase τ2)
// Pivot Points (Classic) + Fibonacci Retracement + 가격 클러스터링

function boolEnv(name, fallback = true) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

// ─── 클래식 피벗 포인트 ──────────────────────────────────────────────
// 전일 OHLC 기반 계산

export function calcPivotPoints(high, low, close) {
  if (!high || !low || !close) return null;
  const pp = (high + low + close) / 3;
  const r1 = 2 * pp - low;
  const r2 = pp + (high - low);
  const r3 = high + 2 * (pp - low);
  const s1 = 2 * pp - high;
  const s2 = pp - (high - low);
  const s3 = low - 2 * (high - pp);
  return { pp, r1, r2, r3, s1, s2, s3 };
}

// 캔들 배열에서 최근 N봉의 피벗 계산 (배열 기반 편의 함수)
export function calcPivotPointsFromOHLCV(highs, lows, closes, n = 1) {
  if (highs.length < n + 1) return null;
  const sliceIdx = highs.length - 1 - n;
  const h = Math.max(...highs.slice(sliceIdx, highs.length - 1));
  const l = Math.min(...lows.slice(sliceIdx, lows.length - 1));
  const c = closes[closes.length - 2]; // 전봉 종가
  return calcPivotPoints(h, l, c);
}

// ─── 피보나치 되돌림 ─────────────────────────────────────────────────

export function calcFibonacciRetracement(swingHigh, swingLow) {
  if (swingHigh <= swingLow) return null;
  const diff = swingHigh - swingLow;
  return {
    level_0:    swingLow,
    level_236:  swingLow + diff * 0.236,
    level_382:  swingLow + diff * 0.382,
    level_50:   swingLow + diff * 0.500,
    level_618:  swingLow + diff * 0.618,
    level_786:  swingLow + diff * 0.786,
    level_100:  swingHigh,
    swingHigh,
    swingLow,
  };
}

// 최근 N봉에서 자동으로 스윙 고/저 탐지 후 피보나치 계산
export function calcFibFromOHLCV(highs, lows, lookback = 50) {
  if (highs.length < lookback) return null;
  const sliceH = highs.slice(-lookback);
  const sliceL = lows.slice(-lookback);
  const swingHigh = Math.max(...sliceH);
  const swingLow  = Math.min(...sliceL);
  return calcFibonacciRetracement(swingHigh, swingLow);
}

// ─── 가격 클러스터링 기반 지지/저항 ─────────────────────────────────

function roundToSignificant(value, digits = 3) {
  if (value === 0) return 0;
  const mag = Math.floor(Math.log10(Math.abs(value)));
  const factor = Math.pow(10, digits - 1 - mag);
  return Math.round(value * factor) / factor;
}

export function findSupportLevels(closes, lookback = 100, tolerance = 0.015) {
  if (closes.length < 10) return [];
  const slice = closes.slice(-lookback);
  const clusters = [];

  for (const price of slice) {
    const existing = clusters.find(c => Math.abs(c.level - price) / (c.level + 1e-8) <= tolerance);
    if (existing) {
      existing.count++;
      existing.level = (existing.level * (existing.count - 1) + price) / existing.count;
    } else {
      clusters.push({ level: price, count: 1 });
    }
  }

  return clusters
    .filter(c => c.count >= 3)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map(c => ({ level: roundToSignificant(c.level, 4), count: c.count, strength: Math.min(1, c.count / 10) }))
    .filter(c => c.level < closes[closes.length - 1]); // 현재가 아래 = 지지
}

export function findResistanceLevels(closes, lookback = 100, tolerance = 0.015) {
  if (closes.length < 10) return [];
  const slice = closes.slice(-lookback);
  const clusters = [];

  for (const price of slice) {
    const existing = clusters.find(c => Math.abs(c.level - price) / (c.level + 1e-8) <= tolerance);
    if (existing) {
      existing.count++;
      existing.level = (existing.level * (existing.count - 1) + price) / existing.count;
    } else {
      clusters.push({ level: price, count: 1 });
    }
  }

  return clusters
    .filter(c => c.count >= 3)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map(c => ({ level: roundToSignificant(c.level, 4), count: c.count, strength: Math.min(1, c.count / 10) }))
    .filter(c => c.level > closes[closes.length - 1]); // 현재가 위 = 저항
}

// ─── 현재가가 레벨 근처인지 확인 ────────────────────────────────────

export function isPriceNearLevel(price, level, tolerancePct = 0.02) {
  if (!price || !level) return false;
  return Math.abs(price - level) / (level + 1e-8) <= tolerancePct;
}

// 피벗 레벨 중 현재가에서 가장 가까운 지지/저항 반환
export function nearestPivotLevels(currentPrice, pivots) {
  if (!pivots) return { nearestSupport: null, nearestResistance: null };
  const levels = [pivots.pp, pivots.r1, pivots.r2, pivots.s1, pivots.s2].filter(Boolean);
  const supports    = levels.filter(l => l < currentPrice).sort((a, b) => b - a);
  const resistances = levels.filter(l => l > currentPrice).sort((a, b) => a - b);
  return {
    nearestSupport:    supports[0] ?? null,
    nearestResistance: resistances[0] ?? null,
    supportDistance:   supports[0] ? (currentPrice - supports[0]) / currentPrice : null,
    resistanceDistance: resistances[0] ? (resistances[0] - currentPrice) / currentPrice : null,
  };
}

// ─── 통합 지지/저항 분석 ─────────────────────────────────────────────

export function analyzeSupportResistance(highs, lows, closes) {
  const enabled = boolEnv('LUNA_TA_SUPPORT_RESISTANCE_ENABLED', true);
  if (!enabled || closes.length < 20) {
    return { pivots: null, fibonacci: null, supports: [], resistances: [], nearestPivots: null };
  }

  const currentPrice = closes[closes.length - 1];
  const pivots       = calcPivotPointsFromOHLCV(highs, lows, closes, Math.min(20, highs.length - 1));
  const fibonacci    = calcFibFromOHLCV(highs, lows, Math.min(50, highs.length));
  const supports     = findSupportLevels(closes, 100);
  const resistances  = findResistanceLevels(closes, 100);
  const nearestPivots = nearestPivotLevels(currentPrice, pivots);

  // 현재가가 지지선 근처인지 (매수 가능성)
  const atSupport    = supports.some(s => isPriceNearLevel(currentPrice, s.level, 0.02));
  const atResistance = resistances.some(r => isPriceNearLevel(currentPrice, r.level, 0.02));

  return { pivots, fibonacci, supports, resistances, nearestPivots, currentPrice, atSupport, atResistance };
}

export default { calcPivotPoints, calcPivotPointsFromOHLCV, calcFibonacciRetracement, calcFibFromOHLCV, findSupportLevels, findResistanceLevels, isPriceNearLevel, nearestPivotLevels, analyzeSupportResistance };
