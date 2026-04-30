// @ts-nocheck
// ta-weight-adaptive-tuner.ts — 피드백 루프 기반 가중치 적응 (Phase τ7)
// 포스트트레이드 결과 → 지표 가중치 자동 조정
// 수익 거래에서 사용된 지표는 가중치 ↑, 손실 거래는 ↓

function boolEnv(name, fallback = true) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function numEnv(name, fallback = 0) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
}

// ─── 기본 가중치 (ta-weighted-voting과 동기화) ───────────────────────

const DEFAULT_WEIGHTS = {
  TRENDING_BULL: {
    macd: 0.25, golden_cross: 0.20, divergence: 0.15,
    bollinger: 0.10, rsi: 0.10, volume: 0.10, pattern: 0.10,
    death_cross: 0.00, stochastic: 0.00, atr: 0.00, support_resistance: 0.00,
  },
  TRENDING_BEAR: {
    macd: 0.25, death_cross: 0.20, divergence: 0.15,
    bollinger: 0.10, rsi: 0.10, volume: 0.10, pattern: 0.10,
    golden_cross: 0.00, stochastic: 0.00, atr: 0.00, support_resistance: 0.00,
  },
  VOLATILE: {
    bollinger: 0.30, rsi: 0.20, atr: 0.20, volume: 0.15,
    macd: 0.10, pattern: 0.05,
    golden_cross: 0.00, death_cross: 0.00, divergence: 0.00, stochastic: 0.00, support_resistance: 0.00,
  },
  RANGING: {
    rsi: 0.25, stochastic: 0.20, support_resistance: 0.20,
    bollinger: 0.15, macd: 0.10, volume: 0.10,
    golden_cross: 0.00, death_cross: 0.00, divergence: 0.00, atr: 0.00, pattern: 0.00,
  },
};

// ─── 인메모리 가중치 저장소 ──────────────────────────────────────────
// OPS 무중단 운영 중 런타임 적응 (재시작 시 기본값으로 리셋)

const adaptedWeightStore = {
  TRENDING_BULL: null,
  TRENDING_BEAR: null,
  VOLATILE:      null,
  RANGING:       null,
};

const tradeHistory = [];   // 최근 50 트레이드 누적
const MAX_HISTORY  = 50;

// ─── 가중치 정규화 (합 = 1.0) ────────────────────────────────────────

function normalizeWeights(weights) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (total <= 0) return { ...weights };
  const result = {};
  for (const [k, v] of Object.entries(weights)) {
    result[k] = v / total;
  }
  return result;
}

// ─── regime 정규화 ───────────────────────────────────────────────────

function normalizeRegime(regime = 'RANGING') {
  const r = String(regime).toUpperCase();
  if (r.includes('BULL'))  return 'TRENDING_BULL';
  if (r.includes('BEAR'))  return 'TRENDING_BEAR';
  if (r.includes('VOLAT')) return 'VOLATILE';
  return 'RANGING';
}

// ─── 현재 가중치 조회 ────────────────────────────────────────────────

export function retrieveAdaptedWeights(regime = 'RANGING') {
  const key = normalizeRegime(regime);
  return adaptedWeightStore[key]
    ? { ...adaptedWeightStore[key] }
    : { ...(DEFAULT_WEIGHTS[key] ?? DEFAULT_WEIGHTS.RANGING) };
}

// ─── 가중치 저장 ─────────────────────────────────────────────────────

export function persistAdaptedWeights(weights, regime = 'RANGING') {
  const key = normalizeRegime(regime);
  adaptedWeightStore[key] = { ...normalizeWeights(weights), _updatedAt: new Date().toISOString() };
  console.log(`  [가중치적응] ${key} 가중치 업데이트: ${JSON.stringify(Object.fromEntries(Object.entries(adaptedWeightStore[key]).filter(([k]) => !k.startsWith('_')).slice(0, 4)))}`);
}

// ─── 포스트트레이드 기반 가중치 조정 ────────────────────────────────

/**
 * @param {Object} posttradeResult
 * @param {number}   posttradeResult.pnl             - 손익 (양수=수익, 음수=손실)
 * @param {number}   posttradeResult.pnlPct           - 손익률 (-1~1)
 * @param {string[]} posttradeResult.usedIndicators   - 사용된 지표 이름 배열
 * @param {string}   posttradeResult.regime           - 진입 시 regime
 * @param {string}   posttradeResult.symbol           - 종목
 * @returns {Object} 조정된 가중치
 */
export function tuneIndicatorWeights(posttradeResult) {
  const enabled    = boolEnv('LUNA_TA_WEIGHT_ADAPTIVE_TUNER_ENABLED', true);
  if (!enabled) return null;

  const learnRate  = Math.min(0.3, Math.max(0.01, numEnv('LUNA_TA_WEIGHT_ADAPTIVE_LEARN_RATE', 0.10)));
  const { pnl = 0, pnlPct = 0, usedIndicators = [], regime = 'RANGING', symbol = '' } = posttradeResult ?? {};

  const regimeKey     = normalizeRegime(regime);
  const currentWeights = retrieveAdaptedWeights(regimeKey);
  const profitable     = pnl > 0 || pnlPct > 0.005;
  const adjustFactor   = profitable
    ? 1 + learnRate * Math.min(2, Math.abs(pnlPct) * 10)  // 수익 시 상향
    : 1 - learnRate * 0.5;                                  // 손실 시 하향 (보수적)

  // 트레이드 히스토리 누적
  tradeHistory.push({ symbol, regime: regimeKey, usedIndicators, profitable, pnlPct, at: Date.now() });
  if (tradeHistory.length > MAX_HISTORY) tradeHistory.shift();

  const newWeights = { ...currentWeights };
  const usedSet    = new Set(usedIndicators);

  for (const indicator of Object.keys(newWeights)) {
    if (indicator.startsWith('_')) continue;
    if (!usedSet.has(indicator)) continue;

    if (profitable) {
      newWeights[indicator] = Math.min(0.50, newWeights[indicator] * adjustFactor);
    } else {
      newWeights[indicator] = Math.max(0.01, newWeights[indicator] * adjustFactor);
    }
  }

  const normalized = normalizeWeights(
    Object.fromEntries(Object.entries(newWeights).filter(([k]) => !k.startsWith('_')))
  );

  persistAdaptedWeights(normalized, regimeKey);
  console.log(`  [가중치적응] ${symbol} ${regimeKey} | ${profitable ? '수익' : '손실'} (${(pnlPct * 100).toFixed(1)}%) | 지표: ${usedIndicators.join(', ')}`);

  return normalized;
}

// ─── 지표별 누적 성과 요약 ───────────────────────────────────────────

export function getIndicatorPerformanceSummary(regime = 'RANGING') {
  const regimeKey = normalizeRegime(regime);
  const relevant  = tradeHistory.filter(t => t.regime === regimeKey);

  if (!relevant.length) return { regime: regimeKey, totalTrades: 0, indicators: {} };

  const indicatorStats = {};
  for (const trade of relevant) {
    for (const ind of trade.usedIndicators) {
      if (!indicatorStats[ind]) indicatorStats[ind] = { wins: 0, losses: 0, total: 0 };
      indicatorStats[ind].total++;
      if (trade.profitable) indicatorStats[ind].wins++;
      else indicatorStats[ind].losses++;
    }
  }

  for (const stats of Object.values(indicatorStats)) {
    stats.winRate = stats.total > 0 ? stats.wins / stats.total : 0;
  }

  return { regime: regimeKey, totalTrades: relevant.length, indicators: indicatorStats };
}

// ─── 가중치 초기화 (테스트/재시작용) ────────────────────────────────

export function resetAdaptedWeights(regime = null) {
  if (regime) {
    const key = normalizeRegime(regime);
    adaptedWeightStore[key] = null;
  } else {
    for (const key of Object.keys(adaptedWeightStore)) adaptedWeightStore[key] = null;
  }
}

export default { tuneIndicatorWeights, retrieveAdaptedWeights, persistAdaptedWeights, getIndicatorPerformanceSummary, resetAdaptedWeights };
