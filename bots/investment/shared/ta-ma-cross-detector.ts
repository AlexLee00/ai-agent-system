// @ts-nocheck
// ta-ma-cross-detector.ts — 골든크로스/데드크로스 감지 모듈 (Phase τ3)
// MA 5/20 (단기) / MA 20/50 (중기) / MA 50/200 (장기) 교차 감지

function boolEnv(name, fallback = true) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function calcSMA(values, period) {
  if (!values || values.length < period) return null;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── 단일 MA 교차 감지 ──────────────────────────────────────────────

export function detectMaCrossover(closes, fastPeriod, slowPeriod) {
  const base = { type: 'none', confirmed: false, freshCross: false, strength: 0, fastPeriod, slowPeriod };
  if (!closes || closes.length < slowPeriod + 2) return base;

  const fastCurrent = calcSMA(closes, fastPeriod);
  const slowCurrent = calcSMA(closes, slowPeriod);
  const fastPrev    = calcSMA(closes.slice(0, -1), fastPeriod);
  const slowPrev    = calcSMA(closes.slice(0, -1), slowPeriod);

  if (fastCurrent == null || slowCurrent == null || fastPrev == null || slowPrev == null) return base;

  const gapRatio = Math.abs(fastCurrent - slowCurrent) / (slowCurrent + 1e-8);

  // 신선한 교차 (이번 봉)
  const freshGolden = fastPrev <= slowPrev && fastCurrent > slowCurrent;
  const freshDeath  = fastPrev >= slowPrev && fastCurrent < slowCurrent;

  if (freshGolden) {
    return { type: 'golden_cross', confirmed: true, freshCross: true, strength: Math.min(1, gapRatio * 200), fastPeriod, slowPeriod };
  }
  if (freshDeath) {
    return { type: 'death_cross', confirmed: true, freshCross: true, strength: Math.min(1, gapRatio * 200), fastPeriod, slowPeriod };
  }

  // 이미 교차 상태 유지 중
  if (fastCurrent > slowCurrent) {
    return { type: 'golden_cross', confirmed: false, freshCross: false, strength: Math.min(1, gapRatio * 100), fastPeriod, slowPeriod };
  }
  if (fastCurrent < slowCurrent) {
    return { type: 'death_cross', confirmed: false, freshCross: false, strength: Math.min(1, gapRatio * 100), fastPeriod, slowPeriod };
  }

  return base;
}

// ─── 3개 시간대 교차 신호 ───────────────────────────────────────────

export function getActiveCrossSignals(closes) {
  const enabled = boolEnv('LUNA_TA_MA_CROSS_DETECTOR_ENABLED', true);
  if (!enabled || !closes?.length) {
    return [
      { type: 'none', confirmed: false, freshCross: false, strength: 0, fastPeriod: 5,  slowPeriod: 20,  label: '단기' },
      { type: 'none', confirmed: false, freshCross: false, strength: 0, fastPeriod: 20, slowPeriod: 50,  label: '중기' },
      { type: 'none', confirmed: false, freshCross: false, strength: 0, fastPeriod: 50, slowPeriod: 200, label: '장기' },
    ];
  }

  const pairs = [
    { fast: 5,  slow: 20,  label: '단기' },
    { fast: 20, slow: 50,  label: '중기' },
    { fast: 50, slow: 200, label: '장기' },
  ];

  return pairs.map(({ fast, slow, label }) => ({
    ...detectMaCrossover(closes, fast, slow),
    label,
  }));
}

// ─── 교차 강도 측정 ──────────────────────────────────────────────────
// 교차 타입 + 거래량 + ATR 기반 강도 점수

export function measureCrossStrength(crossSignal, volume = null, atr = null, currentPrice = null) {
  if (!crossSignal || crossSignal.type === 'none') return 0;

  let strength = crossSignal.strength ?? 0;

  // 신선한 교차 보너스
  if (crossSignal.freshCross) strength = Math.min(1, strength * 1.3);

  // 장기 교차가 더 강한 신호
  const periodBonus = crossSignal.slowPeriod >= 200 ? 0.3 : crossSignal.slowPeriod >= 50 ? 0.15 : 0;
  strength = Math.min(1, strength + periodBonus);

  // 거래량 강화 (ATR 대비 거래량)
  if (volume && atr && currentPrice) {
    const atrPct = atr / currentPrice;
    if (atrPct > 0.02) strength = Math.min(1, strength * 1.1);
  }

  return strength;
}

// ─── 요약 리포트 ─────────────────────────────────────────────────────

export function summarizeCrossSignals(signals) {
  if (!signals?.length) return { goldenCount: 0, deathCount: 0, freshGolden: false, freshDeath: false, overallBias: 'neutral', summary: '교차 없음' };

  const goldens   = signals.filter(s => s.type === 'golden_cross');
  const deaths    = signals.filter(s => s.type === 'death_cross');
  const freshGolden = goldens.some(s => s.freshCross);
  const freshDeath  = deaths.some(s => s.freshCross);

  let overallBias = 'neutral';
  if (goldens.length > deaths.length)       overallBias = 'bullish';
  else if (deaths.length > goldens.length)  overallBias = 'bearish';
  else if (freshGolden)                     overallBias = 'bullish';
  else if (freshDeath)                      overallBias = 'bearish';

  const summaryParts = signals.map(s => `[${s.label}] ${s.type === 'golden_cross' ? '골든크로스' : s.type === 'death_cross' ? '데드크로스' : '교차없음'} ${s.freshCross ? '(신선)' : ''}`);

  return {
    goldenCount: goldens.length,
    deathCount:  deaths.length,
    freshGolden,
    freshDeath,
    overallBias,
    signals,
    summary: summaryParts.join(' | '),
  };
}

export default { detectMaCrossover, getActiveCrossSignals, measureCrossStrength, summarizeCrossSignals };
