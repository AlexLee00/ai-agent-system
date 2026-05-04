// @ts-nocheck
// ta-bullish-entry-conditions.ts — 차트 상승패턴 진입 조건 (Phase τ6)
// 여러 TA 조건을 가중치로 평가해 매수 진입 적합성 판단

function boolEnv(name, fallback = true) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function numEnv(name, fallback = 0) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
}

// ─── 조건별 가중치 ───────────────────────────────────────────────────

const CONDITION_WEIGHTS = {
  // 강력 신호 (2.0)
  rsi_oversold:         2.0,  // RSI < 30 강한 과매도
  macd_bullish_cross:   2.0,  // MACD 골든크로스

  // 중요 신호 (1.5)
  rsi_recovery:         1.5,  // RSI 과매도 반등 (30→45)
  bollinger_bounce:     1.5,  // BB 하단 반등
  full_golden_ma:       1.5,  // MA 5>20>60 정배열
  bullish_divergence:   1.5,  // RSI/MACD 상승 다이버전스

  // 보조 신호 (1.0)
  macd_bullish_momentum: 1.0, // MACD 히스토그램 양수
  golden_cross_short:   1.0,  // 단기 골든크로스 (5/20)
  at_support:           1.0,  // 지지선 근처

  // 약한 신호 (0.5)
  bollinger_lower:      0.5,  // BB 하단 (반등 예비)
  golden_cross_mid:     0.5,  // 중기 골든크로스 (20/50)
  volume_surge:         0.5,  // 거래량 급증
  bullish_pattern:      0.5,  // 상승 캔들스틱 패턴
};

// ─── 진입 조건 평가 ──────────────────────────────────────────────────

/**
 * @param {Object} opts
 * @param {number[]} opts.closes
 * @param {number[]} opts.highs
 * @param {number[]} opts.lows
 * @param {number[]} opts.volumes
 * @param {Object}   opts.indicators  - { rsi, macd, bb, mas, stoch, atr }
 * @param {Object}   opts.divergence  - analyzeDivergences 결과
 * @param {Object}   opts.crossSignals - getActiveCrossSignals 결과
 * @param {Object}   opts.patterns    - analyzeChartPatterns 결과
 * @param {Object}   opts.supportResistance - analyzeSupportResistance 결과
 * @returns {{ entry:boolean, score:number, conditions:Object, reasoning:string }}
 */
export function evaluateBullishEntry({ closes, highs, lows, volumes, indicators, divergence, crossSignals, patterns, supportResistance } = {}) {
  const enabled = boolEnv('LUNA_TA_BULLISH_ENTRY_CONDITIONS_ENABLED', true);
  const minScore = numEnv('LUNA_TA_BULLISH_ENTRY_SCORE_MIN', 0.60);

  if (!enabled || !closes?.length) {
    return { entry: false, score: 0, conditions: {}, reasoning: '비활성화' };
  }

  const { rsi, macd, bb, mas } = indicators ?? {};
  const currentPrice = closes[closes.length - 1];
  const prevPrice    = closes[closes.length - 2] ?? currentPrice;

  // ─ 조건 평가 ─
  const conditions = {
    rsi_oversold:          rsi != null && rsi < 30,
    rsi_recovery:          rsi != null && rsi >= 30 && rsi < 45,
    macd_bullish_cross:    macd != null && macd.histogram > 0 && macd.macd > macd.signal,
    macd_bullish_momentum: macd != null && macd.histogram > 0,
    bollinger_bounce:      bb != null && currentPrice > bb.lower && prevPrice <= bb.lower * 1.01,
    bollinger_lower:       bb != null && currentPrice <= bb.lower * 1.02,
    full_golden_ma:        mas?.ma5 && mas?.ma20 && mas?.ma60 && mas.ma5 > mas.ma20 && mas.ma20 > mas.ma60,
    bullish_divergence:    divergence?.overall === 'bullish' && (divergence.bullishScore ?? 0) > 0.25,
    golden_cross_short:    crossSignals?.some(s => s.type === 'golden_cross' && s.fastPeriod === 5) ?? false,
    golden_cross_mid:      crossSignals?.some(s => s.type === 'golden_cross' && s.fastPeriod === 20) ?? false,
    at_support:            supportResistance?.atSupport === true,
    volume_surge:          false, // 아래에서 계산
    bullish_pattern:       (patterns?.bullishScore ?? 0) > 0.3,
  };

  // 거래량 급증 계산
  if (volumes?.length >= 21) {
    const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    conditions.volume_surge = avgVol > 0 && volumes[volumes.length - 1] > avgVol * 1.5;
  }

  // ─ 가중치 합산 ─
  let totalWeight = 0;
  let totalScore  = 0;

  for (const [key, active] of Object.entries(conditions)) {
    const w = CONDITION_WEIGHTS[key] ?? 0;
    totalWeight += w;
    if (active) totalScore += w;
  }

  const score = totalWeight > 0 ? totalScore / totalWeight : 0;

  // 활성화된 조건 목록
  const activeConditions = Object.entries(conditions)
    .filter(([, v]) => v)
    .map(([k]) => k);

  const reasoning = activeConditions.length > 0
    ? activeConditions.map(k => conditionLabel(k)).join(' + ')
    : '조건 미충족';

  console.log(`  [진입조건] 점수: ${(score * 100).toFixed(0)}% | ${reasoning}`);

  return { entry: score >= minScore, score, conditions, activeConditions, reasoning };
}

// ─── 매도 조건 평가 (대칭 구조) ──────────────────────────────────────

export function evaluateBearishExit({ closes, highs, lows, volumes, indicators, divergence, crossSignals, patterns, supportResistance } = {}) {
  const enabled = boolEnv('LUNA_TA_BULLISH_ENTRY_CONDITIONS_ENABLED', true);
  if (!enabled || !closes?.length) return { exit: false, score: 0, reasoning: '비활성화' };

  const { rsi, macd, bb } = indicators ?? {};
  const currentPrice = closes[closes.length - 1];
  const prevPrice    = closes[closes.length - 2] ?? currentPrice;

  const conditions = {
    rsi_overbought:       rsi != null && rsi > 70,
    macd_bearish_cross:   macd != null && macd.histogram < 0 && macd.macd < macd.signal,
    bollinger_upper:      bb != null && currentPrice >= bb.upper * 0.98,
    bearish_divergence:   divergence?.overall === 'bearish' && (divergence.bearishScore ?? 0) > 0.25,
    death_cross:          crossSignals?.some(s => s.type === 'death_cross') ?? false,
    at_resistance:        supportResistance?.atResistance === true,
    bearish_pattern:      (patterns?.bearishScore ?? 0) > 0.3,
  };

  const exitWeights = {
    rsi_overbought: 2.0, macd_bearish_cross: 2.0, bollinger_upper: 1.5,
    bearish_divergence: 1.5, death_cross: 1.0, at_resistance: 1.0, bearish_pattern: 0.5,
  };

  let totalWeight = 0;
  let totalScore  = 0;
  for (const [key, active] of Object.entries(conditions)) {
    const w = exitWeights[key] ?? 0;
    totalWeight += w;
    if (active) totalScore += w;
  }

  const score = totalWeight > 0 ? totalScore / totalWeight : 0;
  const activeConditions = Object.entries(conditions).filter(([, v]) => v).map(([k]) => k);
  const reasoning = activeConditions.join(' + ') || '조건 미충족';

  return { exit: score >= 0.35, score, conditions, activeConditions, reasoning };
}

// ─── 조건 레이블 ─────────────────────────────────────────────────────

function conditionLabel(key) {
  const labels = {
    rsi_oversold: 'RSI 과매도',
    rsi_recovery: 'RSI 회복',
    macd_bullish_cross: 'MACD 골든크로스',
    macd_bullish_momentum: 'MACD 상승',
    bollinger_bounce: 'BB 하단 반등',
    bollinger_lower: 'BB 하단',
    full_golden_ma: 'MA 정배열',
    bullish_divergence: '상승 다이버전스',
    golden_cross_short: '단기 골든크로스(5/20)',
    golden_cross_mid: '중기 골든크로스(20/50)',
    at_support: '지지선 근처',
    volume_surge: '거래량 급증',
    bullish_pattern: '상승 패턴',
  };
  return labels[key] ?? key;
}

export default { evaluateBullishEntry, evaluateBearishExit };
