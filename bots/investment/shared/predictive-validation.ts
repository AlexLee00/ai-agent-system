// @ts-nocheck

const DEFAULT_WEIGHTS = {
  backtest: 0.30,
  prediction: 0.30,
  analyst: 0.20,
  setupOutcome: 0.20,
};

const REGIME_WEIGHT_OVERRIDES = {
  trending_bull: { backtest: 0.20, prediction: 0.40, analyst: 0.20, setupOutcome: 0.20 },
  trending_bear: { backtest: 0.40, prediction: 0.20, analyst: 0.20, setupOutcome: 0.20 },
  ranging: { backtest: 0.30, prediction: 0.20, analyst: 0.20, setupOutcome: 0.30 },
  volatile: { backtest: 0.40, prediction: 0.30, analyst: 0.20, setupOutcome: 0.10 },
  high_volatility: { backtest: 0.40, prediction: 0.30, analyst: 0.20, setupOutcome: 0.10 },
  low_volatility: { backtest: 0.25, prediction: 0.30, analyst: 0.20, setupOutcome: 0.25 },
};

function finiteNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(value, fallback = 0.5) {
  const n = finiteNumber(value, fallback);
  return Math.max(0, Math.min(1, n));
}

function normalizeRegime(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function normalizeWeights(weights = DEFAULT_WEIGHTS) {
  const entries = Object.entries({
    backtest: finiteNumber(weights.backtest, DEFAULT_WEIGHTS.backtest),
    prediction: finiteNumber(weights.prediction, DEFAULT_WEIGHTS.prediction),
    analyst: finiteNumber(weights.analyst, DEFAULT_WEIGHTS.analyst),
    setupOutcome: finiteNumber(weights.setupOutcome, DEFAULT_WEIGHTS.setupOutcome),
  }).filter(([, value]) => Number(value) > 0);
  const total = entries.reduce((sum, [, value]) => sum + Number(value), 0);
  if (!(total > 0)) return { ...DEFAULT_WEIGHTS };
  return Object.fromEntries(entries.map(([key, value]) => [key, Number((Number(value) / total).toFixed(4))]));
}

function resolveWeights(config = {}, regime = '') {
  const regimeKey = normalizeRegime(regime);
  const preset = REGIME_WEIGHT_OVERRIDES[regimeKey] || DEFAULT_WEIGHTS;
  return normalizeWeights({
    ...preset,
    ...(config?.weights || {}),
  });
}

function scorePnl(value, fallback = 0.5) {
  const pnl = finiteNumber(value, null);
  if (pnl == null) return fallback;
  // -5% 이하는 0, +5% 이상은 1 근처로 압축한다.
  return clamp01((pnl + 5) / 10, fallback);
}

function avgObjectNumbers(value = {}) {
  const nums = Object.values(value || {})
    .map((item) => finiteNumber(item, null))
    .filter((item) => item != null);
  if (!nums.length) return null;
  return nums.reduce((sum, item) => sum + item, 0) / nums.length;
}

function extractBacktestComponent(candidate = {}, context = {}) {
  const source =
    candidate?.backtest
    || candidate?.block_meta?.backtest
    || candidate?.block_meta?.backtestData
    || context?.backtest
    || context?.backtestData
    || {};
  const direct = finiteNumber(
    candidate?.backtestScore
      ?? candidate?.backtest_score
      ?? source?.score
      ?? source?.qualityScore,
    null,
  );
  if (direct != null) return { score: clamp01(direct), source: 'score' };

  const winRate = finiteNumber(
    candidate?.backtestWinRate
      ?? candidate?.backtest_win_rate
      ?? source?.winRate
      ?? source?.win_rate,
    null,
  );
  const avgPnl = finiteNumber(source?.avgPnlPercent ?? source?.avg_pnl_percent ?? source?.avgPnl ?? source?.avg_pnl, null);
  const sharpe = finiteNumber(source?.sharpe, null);
  const parts = [];
  if (winRate != null) parts.push(clamp01(winRate));
  if (avgPnl != null) parts.push(scorePnl(avgPnl));
  if (sharpe != null) parts.push(clamp01((sharpe + 1) / 3));
  if (!parts.length) return null;
  return {
    score: clamp01(parts.reduce((sum, item) => sum + item, 0) / parts.length),
    source: 'backtest_metrics',
    metrics: { winRate, avgPnl, sharpe },
  };
}

function extractPredictionComponent(candidate = {}, context = {}) {
  const source =
    candidate?.prediction
    || candidate?.block_meta?.prediction
    || candidate?.block_meta?.predictionEngine
    || context?.prediction
    || context?.predictionEngine
    || {};
  const direct = finiteNumber(
    source?.score
      ?? source?.predictionScore
      ?? source?.predictiveScore
      ?? candidate?.predictionScore
      ?? candidate?.predictiveScore
      ?? candidate?.strategy_route?.predictiveScore
      ?? candidate?.strategyRoute?.predictiveScore,
    null,
  );
  if (direct != null) return { score: clamp01(direct), source: 'score' };
  const probabilities = [
    source?.breakout_probability,
    source?.breakoutProbability,
    source?.trend_cont_probability,
    source?.trendContinuationProbability,
    source?.mean_rev_signal,
    source?.meanReversionSignal,
  ].map((item) => finiteNumber(item, null)).filter((item) => item != null);
  if (!probabilities.length) return null;
  return {
    score: clamp01(probabilities.reduce((sum, item) => sum + item, 0) / probabilities.length),
    source: 'prediction_probabilities',
  };
}

function extractAnalystComponent(candidate = {}, context = {}) {
  const source =
    candidate?.analystAccuracy
    || candidate?.analyst_accuracy
    || candidate?.block_meta?.analystAccuracy
    || context?.analystAccuracy
    || context?.analyst_accuracy
    || null;
  const direct = finiteNumber(source, null);
  if (direct != null) return { score: clamp01(direct), source: 'score' };
  const avg = avgObjectNumbers(source || {});
  if (avg != null) return { score: clamp01(avg), source: 'analyst_accuracy_average' };
  const confidence = finiteNumber(candidate?.confidence, null);
  if (confidence != null) return { score: clamp01(confidence), source: 'candidate_confidence_fallback', fallback: true };
  return null;
}

function extractSetupOutcomeComponent(candidate = {}, context = {}) {
  const source =
    candidate?.setupOutcome
    || candidate?.setup_outcome
    || candidate?.block_meta?.setupOutcome
    || context?.setupOutcome
    || context?.setup_outcome
    || {};
  const direct = finiteNumber(source?.score ?? source?.setupScore, null);
  if (direct != null) return { score: clamp01(direct), source: 'score' };
  const winRate = finiteNumber(source?.winRate ?? source?.win_rate, null);
  const avgPnl = finiteNumber(source?.avgPnlPercent ?? source?.avg_pnl_percent ?? source?.avgPnl ?? source?.avg_pnl, null);
  const parts = [];
  if (winRate != null) parts.push(clamp01(winRate));
  if (avgPnl != null) parts.push(scorePnl(avgPnl));
  if (!parts.length) return null;
  return {
    score: clamp01(parts.reduce((sum, item) => sum + item, 0) / parts.length),
    source: 'setup_outcome_metrics',
    metrics: { winRate, avgPnl },
  };
}

export function buildPredictiveValidationEvidence(candidate = {}, context = {}, config = {}) {
  const threshold = clamp01(config?.threshold ?? config?.fireThreshold ?? 0.55, 0.55);
  const holdThreshold = clamp01(config?.holdThreshold ?? 0.40, 0.40);
  const discardThreshold = clamp01(config?.discardThreshold ?? holdThreshold, holdThreshold);
  const regime = candidate?.regime || candidate?.market_regime || context?.regime || context?.marketRegime || '';
  const weights = resolveWeights(config, regime);
  const componentExtractors = {
    backtest: extractBacktestComponent,
    prediction: extractPredictionComponent,
    analyst: extractAnalystComponent,
    setupOutcome: extractSetupOutcomeComponent,
  };
  const components = {};
  const missingComponents = [];
  let weighted = 0;
  let usedWeight = 0;
  for (const [key, weight] of Object.entries(weights)) {
    const component = componentExtractors[key]?.(candidate, context);
    if (!component) {
      missingComponents.push(key);
      continue;
    }
    components[key] = { ...component, weight };
    weighted += Number(component.score) * Number(weight);
    usedWeight += Number(weight);
  }

  const fallbackScore = clamp01(candidate?.predictiveScore ?? candidate?.confidence ?? context?.predictiveScore ?? 0.5, 0.5);
  const score = usedWeight > 0 ? clamp01(weighted / usedWeight, fallbackScore) : fallbackScore;
  const decision = score >= threshold
    ? 'fire'
    : score < discardThreshold
      ? 'discard'
      : 'hold';
  return {
    score: Number(score.toFixed(4)),
    threshold,
    holdThreshold,
    discardThreshold,
    decision,
    blocked: decision !== 'fire',
    components,
    missingComponents,
    componentCoverage: Number((Object.keys(components).length / Math.max(1, Object.keys(weights).length)).toFixed(4)),
    weights,
    regime: normalizeRegime(regime) || null,
    reason: `predictive_${decision}:${score.toFixed(2)} threshold=${threshold.toFixed(2)}`,
  };
}

export default buildPredictiveValidationEvidence;
