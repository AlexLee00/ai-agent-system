// @ts-nocheck
// ta-chart-patterns.ts — 차트 패턴 인식 모듈 (Phase τ2)
// 캔들스틱 패턴 + 차트 패턴 (다이버전스와 독립)

function boolEnv(name, fallback = true) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

// ─── 캔들스틱 패턴 ──────────────────────────────────────────────────

export function detectHammer(opens, highs, lows, closes, idx = -1) {
  const i = idx < 0 ? closes.length + idx : idx;
  if (i < 1 || i >= closes.length) return { detected: false };
  const o = opens[i], h = highs[i], l = lows[i], c = closes[i];
  const body    = Math.abs(c - o);
  const lowerWick = Math.min(c, o) - l;
  const upperWick = h - Math.max(c, o);
  const totalRange = h - l;
  if (totalRange === 0) return { detected: false };

  // 망치: 하단 꼬리가 몸통 2배 이상, 상단 꼬리 짧음, 하락 추세 후
  const isHammer = lowerWick >= body * 2 && upperWick <= body * 0.5 && c > o;
  if (!isHammer) return { detected: false };

  const prevCloses = closes.slice(Math.max(0, i - 5), i);
  const downtrend  = prevCloses.length >= 3 && prevCloses[0] > prevCloses[prevCloses.length - 1];
  return { detected: true, type: 'hammer', bullish: true, strength: downtrend ? 0.8 : 0.5 };
}

export function detectBullishEngulfing(opens, highs, lows, closes, idx = -1) {
  const i = idx < 0 ? closes.length + idx : idx;
  if (i < 1 || i >= closes.length) return { detected: false };
  const prev = { o: opens[i - 1], c: closes[i - 1] };
  const curr = { o: opens[i], c: closes[i] };

  // 현재 양봉이 이전 음봉을 완전히 감싸야 함
  const prevBearish = prev.c < prev.o;
  const currBullish = curr.c > curr.o;
  const engulfs     = currBullish && prevBearish && curr.o <= prev.c && curr.c >= prev.o;

  if (!engulfs) return { detected: false };
  const strength = Math.min(1, (curr.c - curr.o) / (prev.o - prev.c));
  return { detected: true, type: 'bullish_engulfing', bullish: true, strength };
}

export function detectBearishEngulfing(opens, highs, lows, closes, idx = -1) {
  const i = idx < 0 ? closes.length + idx : idx;
  if (i < 1 || i >= closes.length) return { detected: false };
  const prev = { o: opens[i - 1], c: closes[i - 1] };
  const curr = { o: opens[i], c: closes[i] };

  const prevBullish = prev.c > prev.o;
  const currBearish = curr.c < curr.o;
  const engulfs     = currBearish && prevBullish && curr.o >= prev.c && curr.c <= prev.o;

  if (!engulfs) return { detected: false };
  const strength = Math.min(1, (curr.o - curr.c) / (prev.c - prev.o));
  return { detected: true, type: 'bearish_engulfing', bullish: false, strength };
}

export function detectMorningStar(opens, highs, lows, closes, idx = -1) {
  const i = idx < 0 ? closes.length + idx : idx;
  if (i < 2 || i >= closes.length) return { detected: false };
  const [c1, c2, c3] = [closes[i - 2], closes[i - 1], closes[i]];
  const [o1, o2, o3] = [opens[i - 2], opens[i - 1], opens[i]];

  const firstBearish = c1 < o1;
  const dojiSmall    = Math.abs(c2 - o2) < (Math.abs(c1 - o1) * 0.3);
  const thirdBullish = c3 > o3 && c3 > (o1 + c1) / 2;

  if (!(firstBearish && dojiSmall && thirdBullish)) return { detected: false };
  return { detected: true, type: 'morning_star', bullish: true, strength: 0.8 };
}

export function detectEveningStar(opens, highs, lows, closes, idx = -1) {
  const i = idx < 0 ? closes.length + idx : idx;
  if (i < 2 || i >= closes.length) return { detected: false };
  const [c1, c2, c3] = [closes[i - 2], closes[i - 1], closes[i]];
  const [o1, o2, o3] = [opens[i - 2], opens[i - 1], opens[i]];

  const firstBullish = c1 > o1;
  const dojiSmall    = Math.abs(c2 - o2) < (Math.abs(c1 - o1) * 0.3);
  const thirdBearish = c3 < o3 && c3 < (o1 + c1) / 2;

  if (!(firstBullish && dojiSmall && thirdBearish)) return { detected: false };
  return { detected: true, type: 'evening_star', bullish: false, strength: 0.8 };
}

// ─── 차트 패턴 — 극값 유틸 ────────────────────────────────────────

function findLocalHighs(data, window = 5) {
  const result = [];
  for (let i = window; i < data.length - window; i++) {
    const slice = data.slice(i - window, i + window + 1);
    if (data[i] >= Math.max(...slice)) result.push({ idx: i, value: data[i] });
  }
  return result;
}

function findLocalLows(data, window = 5) {
  const result = [];
  for (let i = window; i < data.length - window; i++) {
    const slice = data.slice(i - window, i + window + 1);
    if (data[i] <= Math.min(...slice)) result.push({ idx: i, value: data[i] });
  }
  return result;
}

// ─── 더블 탑 / 더블 바텀 ────────────────────────────────────────────

export function detectDoubleTop(highs, closes, lookback = 30) {
  if (highs.length < lookback) return { detected: false };
  const slice  = highs.slice(-lookback);
  const peaks  = findLocalHighs(slice, 3).slice(-3);
  if (peaks.length < 2) return { detected: false };

  const [p1, p2] = peaks.slice(-2);
  const similarity = 1 - Math.abs(p1.value - p2.value) / ((p1.value + p2.value) / 2);
  if (similarity < 0.97) return { detected: false };

  // 가격이 두 고점 사이 저점 아래로 내려왔는지 (돌파 확인)
  const between    = slice.slice(p1.idx + 1, p2.idx);
  const valleyLow  = Math.min(...between.map((_, j) => closes[closes.length - lookback + p1.idx + 1 + j] ?? Infinity));
  const lastClose  = closes[closes.length - 1];
  const breakout   = lastClose < valleyLow;

  return { detected: true, type: 'double_top', bullish: false, strength: similarity * (breakout ? 0.9 : 0.5), breakoutConfirmed: breakout };
}

export function detectDoubleBottom(lows, closes, lookback = 30) {
  if (lows.length < lookback) return { detected: false };
  const slice   = lows.slice(-lookback);
  const valleys = findLocalLows(slice, 3).slice(-3);
  if (valleys.length < 2) return { detected: false };

  const [v1, v2] = valleys.slice(-2);
  const similarity = 1 - Math.abs(v1.value - v2.value) / ((v1.value + v2.value) / 2 + 1e-8);
  if (similarity < 0.97) return { detected: false };

  const between   = slice.slice(v1.idx + 1, v2.idx);
  const peakHigh  = Math.max(...between.map((_, j) => closes[closes.length - lookback + v1.idx + 1 + j] ?? -Infinity));
  const lastClose = closes[closes.length - 1];
  const breakout  = lastClose > peakHigh;

  return { detected: true, type: 'double_bottom', bullish: true, strength: similarity * (breakout ? 0.9 : 0.5), breakoutConfirmed: breakout };
}

// ─── 헤드 앤 숄더 / 역 헤드 앤 숄더 ────────────────────────────────

export function detectHeadAndShoulders(highs, lows, closes, lookback = 50) {
  if (highs.length < lookback) return { detected: false };
  const sliceH = highs.slice(-lookback);
  const peaks  = findLocalHighs(sliceH, 4).slice(-4);
  if (peaks.length < 3) return { detected: false };

  // 왼 어깨, 헤드, 오른 어깨 패턴
  for (let i = 0; i <= peaks.length - 3; i++) {
    const [ls, head, rs] = peaks.slice(i, i + 3);
    if (head.value <= ls.value || head.value <= rs.value) continue;
    const shoulderSimilarity = 1 - Math.abs(ls.value - rs.value) / ((ls.value + rs.value) / 2);
    if (shoulderSimilarity < 0.92) continue;
    const lastClose = closes[closes.length - 1];
    const neckline  = (ls.value + rs.value) / 2 * 0.97; // 근사
    const breakout  = lastClose < neckline;
    return { detected: true, type: 'head_and_shoulders', bullish: false, strength: shoulderSimilarity * 0.85, breakoutConfirmed: breakout };
  }
  return { detected: false };
}

export function detectInverseHeadAndShoulders(highs, lows, closes, lookback = 50) {
  if (lows.length < lookback) return { detected: false };
  const sliceL  = lows.slice(-lookback);
  const valleys = findLocalLows(sliceL, 4).slice(-4);
  if (valleys.length < 3) return { detected: false };

  for (let i = 0; i <= valleys.length - 3; i++) {
    const [ls, head, rs] = valleys.slice(i, i + 3);
    if (head.value >= ls.value || head.value >= rs.value) continue;
    const shoulderSimilarity = 1 - Math.abs(ls.value - rs.value) / ((ls.value + rs.value) / 2 + 1e-8);
    if (shoulderSimilarity < 0.92) continue;
    const lastClose = closes[closes.length - 1];
    const neckline  = (ls.value + rs.value) / 2 * 1.03;
    const breakout  = lastClose > neckline;
    return { detected: true, type: 'inverse_head_and_shoulders', bullish: true, strength: shoulderSimilarity * 0.85, breakoutConfirmed: breakout };
  }
  return { detected: false };
}

// ─── 어센딩 / 디센딩 삼각형 ─────────────────────────────────────────

export function detectAscendingTriangle(highs, lows, closes, lookback = 30) {
  if (closes.length < lookback) return { detected: false };
  const sliceH = highs.slice(-lookback);
  const sliceL = lows.slice(-lookback);

  // 고점이 수평 (저항선 일정), 저점이 상승
  const recentHighs = sliceH.slice(-10);
  const recentLows  = sliceL.slice(-10);
  const highStd     = std(recentHighs);
  const highMean    = mean(recentHighs);
  const highFlat    = highStd / (highMean + 1e-8) < 0.015;

  const lowSlope = linearSlope(recentLows);
  const lowRising = lowSlope > 0;

  if (!(highFlat && lowRising)) return { detected: false };
  const lastClose = closes[closes.length - 1];
  const resistance = highMean;
  const breakout   = lastClose > resistance;
  return { detected: true, type: 'ascending_triangle', bullish: true, strength: breakout ? 0.85 : 0.55, breakoutConfirmed: breakout };
}

export function detectDescendingTriangle(highs, lows, closes, lookback = 30) {
  if (closes.length < lookback) return { detected: false };
  const sliceH = highs.slice(-lookback);
  const sliceL = lows.slice(-lookback);

  const recentHighs = sliceH.slice(-10);
  const recentLows  = sliceL.slice(-10);
  const lowStd      = std(recentLows);
  const lowMean     = mean(recentLows);
  const lowFlat     = lowStd / (lowMean + 1e-8) < 0.015;

  const highSlope  = linearSlope(recentHighs);
  const highFalling = highSlope < 0;

  if (!(lowFlat && highFalling)) return { detected: false };
  const lastClose = closes[closes.length - 1];
  const support   = lowMean;
  const breakout  = lastClose < support;
  return { detected: true, type: 'descending_triangle', bullish: false, strength: breakout ? 0.85 : 0.55, breakoutConfirmed: breakout };
}

// ─── 통계 유틸 ──────────────────────────────────────────────────────

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function std(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}
function linearSlope(arr) {
  const n = arr.length;
  const xm = (n - 1) / 2;
  const ym = mean(arr);
  const ssxy = arr.reduce((acc, y, i) => acc + (i - xm) * (y - ym), 0);
  const ssxx = arr.reduce((acc, _, i) => acc + (i - xm) ** 2, 0);
  return ssxx === 0 ? 0 : ssxy / ssxx;
}

// ─── 통합 패턴 분석 ──────────────────────────────────────────────────

export function analyzeChartPatterns(opens, highs, lows, closes) {
  const enabled = boolEnv('LUNA_TA_CHART_PATTERN_ENABLED', true);
  if (!enabled || closes.length < 10) {
    return { candlestick: null, chart: null, bullishSignals: [], bearishSignals: [], bullishScore: 0, bearishScore: 0 };
  }

  // 캔들스틱 패턴 (최근 3봉)
  const candlestickChecks = [
    detectHammer(opens, highs, lows, closes),
    detectBullishEngulfing(opens, highs, lows, closes),
    detectBearishEngulfing(opens, highs, lows, closes),
    detectMorningStar(opens, highs, lows, closes),
    detectEveningStar(opens, highs, lows, closes),
  ];
  const candlestick = candlestickChecks.find(r => r.detected) ?? { detected: false };

  // 차트 패턴
  const chartChecks = [
    detectDoubleBottom(lows, closes),
    detectDoubleTop(highs, closes),
    detectInverseHeadAndShoulders(highs, lows, closes),
    detectHeadAndShoulders(highs, lows, closes),
    detectAscendingTriangle(highs, lows, closes),
    detectDescendingTriangle(highs, lows, closes),
  ];
  const chart = chartChecks.find(r => r.detected) ?? { detected: false };

  const bullishSignals = [];
  const bearishSignals = [];

  if (candlestick.detected && candlestick.bullish)  bullishSignals.push(candlestick.type);
  if (candlestick.detected && !candlestick.bullish) bearishSignals.push(candlestick.type);
  if (chart.detected && chart.bullish)              bullishSignals.push(chart.type);
  if (chart.detected && !chart.bullish)             bearishSignals.push(chart.type);

  const bullishScore = bullishSignals.length > 0
    ? Math.min(1, [candlestick, chart].filter(r => r.detected && r.bullish).reduce((s, r) => s + (r.strength ?? 0.5), 0) / 2)
    : 0;
  const bearishScore = bearishSignals.length > 0
    ? Math.min(1, [candlestick, chart].filter(r => r.detected && !r.bullish).reduce((s, r) => s + (r.strength ?? 0.5), 0) / 2)
    : 0;

  return { candlestick, chart, bullishSignals, bearishSignals, bullishScore, bearishScore };
}

export default {
  detectHammer, detectBullishEngulfing, detectBearishEngulfing,
  detectMorningStar, detectEveningStar,
  detectDoubleTop, detectDoubleBottom,
  detectHeadAndShoulders, detectInverseHeadAndShoulders,
  detectAscendingTriangle, detectDescendingTriangle,
  analyzeChartPatterns,
};
