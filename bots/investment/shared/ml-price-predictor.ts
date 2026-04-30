// @ts-nocheck
// ml-price-predictor.ts — ML 기반 가격 예측 모듈 (Phase τ5)
// 외부 ML 라이브러리 없이 순수 JS로 구현:
//   - 선형 회귀 (로그 수익률 추세)
//   - Holt's 이중 지수 평활 (단기 예측)
//   - 앙상블 (두 방법 평균)
// Kill Switch: LUNA_ML_PRICE_PREDICTOR_ENABLED=false (default)
// Shadow Mode: LUNA_ML_PRICE_PREDICTOR_SHADOW_MODE=true (default, 실거래 영향 없음)

function boolEnv(name, fallback = false) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function numEnv(name, fallback = 0) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
}

// ─── 선형 회귀 ──────────────────────────────────────────────────────

function linearRegression(values) {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: values[0] ?? 0, r2: 0 };
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((a, b) => a + b, 0) / n;
  const ssxy  = values.reduce((acc, y, i) => acc + (i - xMean) * (y - yMean), 0);
  const ssxx  = values.reduce((acc, _, i) => acc + (i - xMean) ** 2, 0);
  const ssyy  = values.reduce((acc, y) => acc + (y - yMean) ** 2, 0);
  const slope     = ssxx === 0 ? 0 : ssxy / ssxx;
  const intercept = yMean - slope * xMean;
  const r2        = ssyy === 0 ? 0 : (ssxy ** 2) / (ssxx * ssyy);
  return { slope, intercept, r2 };
}

// ─── Holt's 이중 지수 평활 (레벨 + 추세) ────────────────────────────

function holtsSmoothing(values, alpha = 0.3, beta = 0.1, horizon = 5) {
  if (values.length < 2) return null;
  let level = values[0];
  let trend = values[1] - values[0];

  for (let i = 1; i < values.length; i++) {
    const prevLevel = level;
    level = alpha * values[i] + (1 - alpha) * (level + trend);
    trend = beta  * (level - prevLevel) + (1 - beta) * trend;
  }

  return Array.from({ length: horizon }, (_, h) => level + (h + 1) * trend);
}

// ─── 추세 일관성 계산 (신뢰도 기반) ─────────────────────────────────

function calcTrendConsistency(logReturns, direction) {
  if (!logReturns.length) return 0;
  const matching = logReturns.filter(r => direction > 0 ? r > 0 : r < 0).length;
  return matching / logReturns.length;
}

// ─── 변동성 계산 (예측 불확실성) ─────────────────────────────────────

function calcVolatility(logReturns) {
  if (logReturns.length < 2) return 0;
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / logReturns.length;
  return Math.sqrt(variance);
}

// ─── 메인 예측 함수 ──────────────────────────────────────────────────

export function predictPrice(closes, horizon = 5) {
  const enabled    = boolEnv('LUNA_ML_PRICE_PREDICTOR_ENABLED', false);
  const shadowMode = boolEnv('LUNA_ML_PRICE_PREDICTOR_SHADOW_MODE', true);
  const minConf    = numEnv('LUNA_ML_PRICE_PREDICTOR_CONFIDENCE_MIN', 0.7);

  const result = {
    enabled,
    shadowMode,
    horizon,
    currentPrice:  null,
    predictions:   null,
    direction:     'neutral',
    expectedReturn: 0,
    confidence:     0,
    usable:         false,
    r2:             0,
    volatility:     0,
  };

  if (!closes?.length || closes.length < 30) return result;

  result.currentPrice = closes[closes.length - 1];

  // 로그 수익률
  const logReturns = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const recentReturns = logReturns.slice(-30);

  // 선형 회귀 (추세 방향)
  const linReg = linearRegression(recentReturns);
  const linRegPredPrice = result.currentPrice * Math.exp(linReg.slope * horizon);

  // Holt's 평활 (단기 가격 예측)
  const holtsPredictions = holtsSmoothing(closes.slice(-60), 0.25, 0.08, horizon);
  const holtsPredPrice   = holtsPredictions ? holtsPredictions[horizon - 1] : result.currentPrice;

  // 앙상블 (선형 40% + Holt's 60%)
  const ensemblePrice = linRegPredPrice * 0.4 + holtsPredPrice * 0.6;
  const expectedReturn = (ensemblePrice - result.currentPrice) / result.currentPrice;

  // 신뢰도: 추세 일관성 × R² × (1 - 변동성 가중)
  const volatility        = calcVolatility(recentReturns);
  const trendConsistency  = calcTrendConsistency(recentReturns, linReg.slope);
  const r2                = linReg.r2;
  const volPenalty        = Math.min(0.5, volatility * 20);
  const confidence        = Math.min(1, Math.max(0, trendConsistency * 0.6 + r2 * 0.4 - volPenalty));

  result.predictions    = holtsPredictions;
  result.expectedReturn = expectedReturn;
  result.direction      = expectedReturn > 0.01 ? 'up' : expectedReturn < -0.01 ? 'down' : 'neutral';
  result.confidence     = confidence;
  result.r2             = r2;
  result.volatility     = volatility;
  result.usable         = enabled && !shadowMode && confidence >= minConf;

  if (!enabled) return result;

  console.log(`  [ML예측] 방향: ${result.direction} | 신뢰도: ${(confidence * 100).toFixed(0)}% | 예상수익: ${(expectedReturn * 100).toFixed(2)}% | 모드: ${shadowMode ? 'SHADOW' : 'ACTIVE'}`);

  return result;
}

// ─── 멀티심볼 배치 예측 ──────────────────────────────────────────────

export async function predictPriceBatch(symbolOhlcvMap, horizon = 5) {
  const results = {};
  for (const [symbol, closes] of Object.entries(symbolOhlcvMap)) {
    results[symbol] = predictPrice(closes, horizon);
  }
  return results;
}

// ─── 예측 신호 → 투표 변환 ───────────────────────────────────────────

export function predictionToVote(prediction) {
  if (!prediction?.enabled || !prediction.usable) return { name: 'ml_prediction', vote: 0, confidence: 0 };
  const vote = prediction.direction === 'up' ? 1 : prediction.direction === 'down' ? -1 : 0;
  return { name: 'ml_prediction', vote, confidence: prediction.confidence };
}

export default { predictPrice, predictPriceBatch, predictionToVote };
