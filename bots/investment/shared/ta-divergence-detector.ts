// @ts-nocheck
// ta-divergence-detector.ts — 다이버전스 감지 모듈 (Phase τ2)
// RSI / MACD / Volume 다이버전스 감지
// 일반 다이버전스: 가격↓↓ RSI↑↑ → 상승 신호 (저점 불일치)
// 히든 다이버전스: 가격↑↑ RSI↓↓ → 추세 지속 신호

function boolEnv(name, fallback = true) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

// ─── RSI 히스토리 계산 ──────────────────────────────────────────────

function calcRsiHistory(closes, period = 14) {
  if (closes.length < period + 1) return [];
  const changes = closes.slice(1).map((v, i) => v - closes[i]);
  const gains   = changes.map(c => c > 0 ? c : 0);
  const losses  = changes.map(c => c < 0 ? -c : 0);
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b) / period;
  const rsiValues = [];
  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    rsiValues.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return rsiValues;
}

// ─── MACD 히스토그램 히스토리 계산 ──────────────────────────────────

function calcEmaSeq(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b) / period;
  const result = [ema];
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function calcMacdHistogramHistory(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (closes.length < slow + signalPeriod) return [];
  const macdLine = [];
  for (let i = slow - 1; i < closes.length; i++) {
    const fastEma = calcEmaSeq(closes.slice(0, i + 1), fast);
    const slowEma = calcEmaSeq(closes.slice(0, i + 1), slow);
    if (!fastEma.length || !slowEma.length) continue;
    macdLine.push(fastEma[fastEma.length - 1] - slowEma[slowEma.length - 1]);
  }
  if (macdLine.length < signalPeriod) return [];
  const signalEmaSeq = calcEmaSeq(macdLine, signalPeriod);
  const offset = macdLine.length - signalEmaSeq.length;
  return signalEmaSeq.map((s, i) => macdLine[i + offset] - s);
}

// ─── 로컬 극값 탐색 ──────────────────────────────────────────────────

function findLocalLows(data, window = 5) {
  const result = [];
  for (let i = window; i < data.length - window; i++) {
    const slice = data.slice(i - window, i + window + 1);
    if (data[i] <= Math.min(...slice)) result.push({ idx: i, value: data[i] });
  }
  return result;
}

function findLocalHighs(data, window = 5) {
  const result = [];
  for (let i = window; i < data.length - window; i++) {
    const slice = data.slice(i - window, i + window + 1);
    if (data[i] >= Math.max(...slice)) result.push({ idx: i, value: data[i] });
  }
  return result;
}

function nearestExtreme(extremes, targetIdx, tolerance = 8) {
  return extremes
    .filter(e => Math.abs(e.idx - targetIdx) <= tolerance)
    .sort((a, b) => Math.abs(a.idx - targetIdx) - Math.abs(b.idx - targetIdx))[0] ?? null;
}

// ─── RSI 다이버전스 감지 ─────────────────────────────────────────────

export function detectRsiDivergence(closes, rsiValues, lookback = 14) {
  if (!closes?.length || !rsiValues?.length) return { type: 'none', strength: 0 };
  if (closes.length < lookback * 2 || rsiValues.length < lookback) return { type: 'none', strength: 0 };

  // closes와 rsiValues 길이 정렬 (rsiValues = closes.length - period)
  const offset = closes.length - rsiValues.length;
  const alignedCloses = closes.slice(offset);

  const window = Math.min(5, Math.floor(lookback / 3));
  const priceLows  = findLocalLows(alignedCloses, window).slice(-4);
  const priceHighs = findLocalHighs(alignedCloses, window).slice(-4);
  const rsiLows    = findLocalLows(rsiValues, window);
  const rsiHighs   = findLocalHighs(rsiValues, window);

  // 상승 다이버전스: 가격 저저점, RSI 고저점 (매수 신호)
  if (priceLows.length >= 2) {
    const [p1, p2] = priceLows.slice(-2);
    const r1 = nearestExtreme(rsiLows, p1.idx);
    const r2 = nearestExtreme(rsiLows, p2.idx);
    if (r1 && r2 && p1.idx !== p2.idx) {
      if (p2.value < p1.value * 0.999 && r2.value > r1.value * 1.001) {
        const strength = Math.min(1, Math.max(0.3, ((r2.value - r1.value) / (Math.abs(r1.value) + 1)) * 3));
        return { type: 'bullish_divergence', strength, pivot1: p1, pivot2: p2 };
      }
      if (p2.value > p1.value * 1.001 && r2.value < r1.value * 0.999) {
        const strength = Math.min(1, Math.max(0.2, ((r1.value - r2.value) / (Math.abs(r1.value) + 1)) * 2));
        return { type: 'hidden_bullish', strength, pivot1: p1, pivot2: p2 };
      }
    }
  }

  // 하락 다이버전스: 가격 고고점, RSI 저고점 (매도 신호)
  if (priceHighs.length >= 2) {
    const [h1, h2] = priceHighs.slice(-2);
    const r1 = nearestExtreme(rsiHighs, h1.idx);
    const r2 = nearestExtreme(rsiHighs, h2.idx);
    if (r1 && r2 && h1.idx !== h2.idx) {
      if (h2.value > h1.value * 1.001 && r2.value < r1.value * 0.999) {
        const strength = Math.min(1, Math.max(0.3, ((r1.value - r2.value) / (Math.abs(r1.value) + 1)) * 3));
        return { type: 'bearish_divergence', strength, pivot1: h1, pivot2: h2 };
      }
      if (h2.value < h1.value * 0.999 && r2.value > r1.value * 1.001) {
        const strength = Math.min(1, Math.max(0.2, ((r2.value - r1.value) / (Math.abs(r1.value) + 1)) * 2));
        return { type: 'hidden_bearish', strength, pivot1: h1, pivot2: h2 };
      }
    }
  }

  return { type: 'none', strength: 0 };
}

// ─── MACD 다이버전스 감지 ─────────────────────────────────────────────

export function detectMacdDivergence(closes, macdHistograms, lookback = 14) {
  if (!closes?.length || !macdHistograms?.length) return { type: 'none', strength: 0 };
  if (closes.length < lookback * 2 || macdHistograms.length < lookback) return { type: 'none', strength: 0 };

  const offset = closes.length - macdHistograms.length;
  const alignedCloses = closes.slice(offset);

  const window = Math.min(5, Math.floor(lookback / 3));
  const priceLows  = findLocalLows(alignedCloses, window).slice(-4);
  const priceHighs = findLocalHighs(alignedCloses, window).slice(-4);
  const macdLows   = findLocalLows(macdHistograms, window);
  const macdHighs  = findLocalHighs(macdHistograms, window);

  if (priceLows.length >= 2) {
    const [p1, p2] = priceLows.slice(-2);
    const m1 = nearestExtreme(macdLows, p1.idx);
    const m2 = nearestExtreme(macdLows, p2.idx);
    if (m1 && m2 && p1.idx !== p2.idx) {
      if (p2.value < p1.value * 0.999 && m2.value > m1.value + 1e-8) {
        return { type: 'bullish_divergence', strength: 0.6, pivot1: p1, pivot2: p2 };
      }
    }
  }

  if (priceHighs.length >= 2) {
    const [h1, h2] = priceHighs.slice(-2);
    const m1 = nearestExtreme(macdHighs, h1.idx);
    const m2 = nearestExtreme(macdHighs, h2.idx);
    if (m1 && m2 && h1.idx !== h2.idx) {
      if (h2.value > h1.value * 1.001 && m2.value < m1.value - 1e-8) {
        return { type: 'bearish_divergence', strength: 0.6, pivot1: h1, pivot2: h2 };
      }
    }
  }

  return { type: 'none', strength: 0 };
}

// ─── 거래량 다이버전스 감지 ──────────────────────────────────────────

export function detectVolumeDivergence(closes, volumes, lookback = 14) {
  if (!closes?.length || !volumes?.length || closes.length < lookback + 1) return { type: 'none', strength: 0 };

  const recent = closes.length - 1;
  const prevClose = closes[recent - 1];
  const currClose = closes[recent];
  const currVol   = volumes[recent];
  const avgVol    = volumes.slice(-lookback - 1, -1).reduce((a, b) => a + b, 0) / lookback;

  if (avgVol === 0) return { type: 'none', strength: 0 };

  const volRatio    = currVol / avgVol;
  const priceChange = Math.abs((currClose - prevClose) / (prevClose || 1));

  if (volRatio > 1.8 && priceChange < 0.005) {
    return { type: 'effort_no_result', strength: Math.min(1, (volRatio - 1.8) * 0.5) };
  }
  if (volRatio < 0.7 && priceChange > 0.01) {
    return { type: 'result_no_effort', strength: Math.min(1, priceChange * 20) };
  }

  return { type: 'none', strength: 0 };
}

// ─── 통합 다이버전스 분석 ────────────────────────────────────────────

export function analyzeDivergences(closes, highs, lows, volumes) {
  const enabled = boolEnv('LUNA_TA_DIVERGENCE_DETECTOR_ENABLED', true);
  const empty = { rsi: { type: 'none', strength: 0 }, macd: { type: 'none', strength: 0 }, volume: { type: 'none', strength: 0 }, overall: 'neutral', bullishScore: 0, bearishScore: 0 };
  if (!enabled || !closes?.length || closes.length < 30) return empty;

  const rsiHistory  = calcRsiHistory(closes);
  const macdHistory = calcMacdHistogramHistory(closes);

  const rsi    = detectRsiDivergence(closes, rsiHistory);
  const macd   = detectMacdDivergence(closes, macdHistory);
  const volume = detectVolumeDivergence(closes, volumes ?? []);

  let bullishScore = 0;
  let bearishScore = 0;

  if (rsi.type === 'bullish_divergence') bullishScore += rsi.strength * 0.5;
  if (rsi.type === 'hidden_bullish')      bullishScore += rsi.strength * 0.3;
  if (rsi.type === 'bearish_divergence')  bearishScore += rsi.strength * 0.5;
  if (rsi.type === 'hidden_bearish')      bearishScore += rsi.strength * 0.3;

  if (macd.type === 'bullish_divergence') bullishScore += macd.strength * 0.35;
  if (macd.type === 'bearish_divergence') bearishScore += macd.strength * 0.35;

  if (volume.type === 'effort_no_result') bearishScore += volume.strength * 0.15;

  const overall = bullishScore > 0.3 ? 'bullish' : bearishScore > 0.3 ? 'bearish' : 'neutral';

  return { rsi, macd, volume, overall, bullishScore: Math.min(1, bullishScore), bearishScore: Math.min(1, bearishScore) };
}

export default { detectRsiDivergence, detectMacdDivergence, detectVolumeDivergence, analyzeDivergences };
