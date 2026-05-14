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

function resolveFreshBacktestStatus(candidate = {}, context = {}) {
  const source =
    candidate?.candidateBacktestStatus
    || candidate?.block_meta?.candidateBacktestStatus
    || candidate?.block_meta?.candidate_backtest_status
    || candidate?.backtestStatus
    || context?.candidateBacktestStatus
    || context?.backtestStatus
    || {};
  if (source.fresh === true || String(source.fresh).toLowerCase() === 'true') {
    return { known: true, fresh: true, source };
  }
  if (source.fresh === false || String(source.fresh).toLowerCase() === 'false') {
    return { known: true, fresh: false, source };
  }
  const lastBacktestAt = source.last_backtest_at || source.lastBacktestAt || candidate?.backtest?.lastBacktestAt || candidate?.backtest?.last_backtest_at;
  if (lastBacktestAt) {
    const ageMs = Date.now() - new Date(lastBacktestAt).getTime();
    const staleHours = Number(context?.backtestStaleHours || candidate?.backtestStaleHours || process.env.LUNA_BACKTEST_STALE_HOURS || 24);
    return { known: true, fresh: ageMs <= staleHours * 3600 * 1000, source: { ...source, lastBacktestAt } };
  }
  return { known: false, fresh: false, source: null };
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

// ─── Hardening checks (config.hardeningEnabled = true 로 명시 활성화) ─────────
const COVERAGE_REQUIRED = 0.75;

function checkHardening(components, missingComponents, score, config = {}, context = {}) {
  const hardeningEnabled = config?.hardeningEnabled === true || config?.requireComponents === true;
  if (!hardeningEnabled) {
    return { coverageBlocked: false, predictionBlocked: false, fallbackAnalyst: false, backtestBlocked: false, anyBlocked: false, enforce: false };
  }

  const coverage = Object.keys(components).length / Math.max(1, Object.keys(components).length + (missingComponents?.length || 0));
  const coverageBlocked = coverage < COVERAGE_REQUIRED;

  // prediction 컴포넌트 없거나 0이면 차단
  const predictionBlocked = !components?.prediction;

  // analyst가 fallback confidence로 채워진 경우 (실 데이터 없음)
  const fallbackAnalyst = components?.analyst?.source === 'candidate_confidence_fallback';

  const backtestStatus = context?.freshBacktestStatus || null;
  const backtestBlocked = context?.hasFreshBacktest === false || backtestStatus?.fresh === false;

  const anyBlocked = coverageBlocked || predictionBlocked || backtestBlocked;

  return {
    coverageBlocked,
    predictionBlocked,
    fallbackAnalyst,
    backtestBlocked: backtestBlocked || false,
    anyBlocked,
    enforce: config?.hardeningEnforce === true,
    backtestStatus,
  };
}

export function buildPredictiveValidationEvidence(candidate = {}, context = {}, config = {}) {
  const threshold = clamp01(config?.threshold ?? config?.fireThreshold ?? 0.55, 0.55);
  const holdThreshold = clamp01(config?.holdThreshold ?? 0.40, 0.40);
  const discardThreshold = clamp01(config?.discardThreshold ?? holdThreshold, holdThreshold);
  const regime = candidate?.regime || candidate?.market_regime || context?.regime || context?.marketRegime || '';
  const weights = resolveWeights(config, regime);
  const freshBacktestStatus = resolveFreshBacktestStatus(candidate, context);
  const hardeningContext = {
    ...context,
    freshBacktestStatus,
    hasFreshBacktest: freshBacktestStatus.known ? freshBacktestStatus.fresh : context?.hasFreshBacktest,
  };
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

  const componentCoverage = Number((Object.keys(components).length / Math.max(1, Object.keys(weights).length)).toFixed(4));
  const fallbackScore = clamp01(candidate?.predictiveScore ?? candidate?.confidence ?? context?.predictiveScore ?? 0.5, 0.5);
  let score = usedWeight > 0 ? clamp01(weighted / usedWeight, fallbackScore) : fallbackScore;

  const hardening = checkHardening(components, missingComponents, score, config, hardeningContext);

  // Phase 1 기본값은 Shadow hardening이다. hardeningEnforce=true일 때만 score를 강제로 낮춘다.
  if (hardening.anyBlocked && hardening.enforce) score = 0;

  const baseDecision = score >= threshold
    ? 'fire'
    : score < discardThreshold
      ? 'discard'
      : 'hold';

  const decision = hardening.enforce && hardening.coverageBlocked
    ? 'block_coverage'
    : hardening.enforce && hardening.predictionBlocked
      ? 'block_no_prediction'
      : hardening.enforce && hardening.backtestBlocked
        ? 'block_stale_backtest'
        : baseDecision;

  const reasonParts = [`predictive_${decision}:${score.toFixed(2)}`, `threshold=${threshold.toFixed(2)}`];
  if (hardening.coverageBlocked) reasonParts.push(`coverage=${componentCoverage.toFixed(2)}<${COVERAGE_REQUIRED}`);
  if (hardening.backtestBlocked) reasonParts.push('fresh_backtest_missing_or_stale');
  if (hardening.predictionBlocked) reasonParts.push('prediction_missing');
  if (hardening.fallbackAnalyst) reasonParts.push('analyst_fallback_only');

  return {
    score: Number(score.toFixed(4)),
    threshold,
    holdThreshold,
    discardThreshold,
    decision,
    blocked: decision !== 'fire',
    components,
    missingComponents,
    componentCoverage,
    weights,
    regime: normalizeRegime(regime) || null,
    reason: reasonParts.join(' '),
    hardening,
    wouldBlock: hardening.anyBlocked,
    promotion: {
      requiredConsecutivePasses: 3,
      pass: !hardening.anyBlocked && score >= threshold,
      reason: hardening.anyBlocked ? 'phase1_hardening_would_block' : 'phase1_hardening_clear',
    },
  };
}

// ─── 감사 로그 (async, 호출자가 선택적으로 사용) ──────────────────────────────
export async function logPredictiveValidation(
  evidence: any,
  { symbol = null, market = null, candidateSnapshot = {} } = {},
): Promise<void> {
  try {
    const { query: dbQuery, run: dbRun } = await import('./db/core.ts');
    await dbRun(`
      INSERT INTO predictive_validation_log
        (symbol, market, decision, score, threshold, component_coverage,
         blocked_reason, components, missing_components, candidate_snapshot)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb)
    `, [
      symbol || null,
      market || null,
      evidence?.decision || 'unknown',
      evidence?.score ?? null,
      evidence?.threshold ?? null,
      evidence?.componentCoverage ?? null,
      evidence?.blocked ? evidence?.reason || null : null,
      JSON.stringify(evidence?.components || {}),
      JSON.stringify(evidence?.missingComponents || []),
      JSON.stringify(candidateSnapshot || {}),
    ]);
  } catch {
    // 감사 로그 실패는 조용히 무시 (주 흐름 방해 금지)
  }
}

export default buildPredictiveValidationEvidence;
