// @ts-nocheck

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function slope(values = []) {
  if (values.length < 2) return 0;
  const first = toNum(values[0], 0);
  const last = toNum(values[values.length - 1], 0);
  if (first === 0) return 0;
  return (last - first) / Math.abs(first);
}

function avg(values = []) {
  if (!Array.isArray(values) || values.length <= 0) return 0;
  return values.reduce((sum, v) => sum + toNum(v, 0), 0) / values.length;
}

export function detectWyckoffPhase(candles = []) {
  if (!Array.isArray(candles) || candles.length < 30) {
    return {
      phase: 'unknown',
      confidence: 0.4,
      evidence: ['insufficient_candles'],
      metrics: {},
    };
  }
  const recent = candles.slice(-40);
  const closes = recent.map((c) => toNum(c.close ?? c[4], 0));
  const highs = recent.map((c) => toNum(c.high ?? c[2], 0));
  const lows = recent.map((c) => toNum(c.low ?? c[3], 0));
  const volumes = recent.map((c) => toNum(c.volume ?? c[5], 0));

  const closeSlope = slope(closes);
  const highSlope = slope(highs);
  const lowSlope = slope(lows);
  const rangePct = avg(highs.map((h, idx) => {
    const l = lows[idx] || 0;
    if (l <= 0) return 0;
    return (h - l) / l;
  }));
  const volumeSlope = slope(volumes);

  let phase = 'accumulation';
  const evidence = [];
  if (closeSlope > 0.05 && lowSlope > 0.03) {
    phase = 'markup';
    evidence.push('higher_high_low');
  } else if (closeSlope < -0.05 && highSlope < -0.03) {
    phase = 'markdown';
    evidence.push('lower_high_low');
  } else if (Math.abs(closeSlope) < 0.02 && rangePct < 0.08 && volumeSlope > 0.04) {
    phase = 'accumulation';
    evidence.push('tight_range_rising_volume');
  } else {
    phase = 'distribution';
    evidence.push('sideways_with_supply');
  }

  let confidence = 0.62;
  if (phase === 'markup' || phase === 'markdown') confidence += 0.12;
  if (Math.abs(closeSlope) > 0.1) confidence += 0.08;
  if (rangePct > 0.12) confidence -= 0.1;
  confidence = Math.max(0.35, Math.min(0.92, confidence));

  return {
    phase,
    confidence: Number(confidence.toFixed(4)),
    evidence,
    metrics: {
      closeSlope: Number(closeSlope.toFixed(4)),
      highSlope: Number(highSlope.toFixed(4)),
      lowSlope: Number(lowSlope.toFixed(4)),
      volumeSlope: Number(volumeSlope.toFixed(4)),
      rangePct: Number(rangePct.toFixed(4)),
    },
  };
}

export default detectWyckoffPhase;
