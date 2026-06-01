// @ts-nocheck

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const MARKET_DEFAULTS = ['crypto', 'domestic', 'overseas'];

function safeNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  const n = safeNumber(value, min);
  return Math.min(max, Math.max(min, n));
}

function round(value, digits = 6) {
  const n = safeNumber(value);
  if (n == null) return null;
  const scale = 10 ** digits;
  return Math.round(n * scale) / scale;
}

function mean(values = []) {
  const nums = values.map((value) => safeNumber(value)).filter((value) => value != null);
  if (nums.length === 0) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseList(value, fallback = []) {
  const list = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length ? [...new Set(list)] : fallback;
}

function parseNumberList(value, fallback = []) {
  const nums = parseList(value, [])
    .map((item) => Number(item))
    .filter(Number.isFinite);
  return nums.length ? [...new Set(nums)] : fallback;
}

function parseIntList(value, fallback = []) {
  const nums = parseNumberList(value, fallback)
    .map((item) => Math.max(1, Math.round(item)));
  return nums.length ? [...new Set(nums)] : fallback;
}

export function isSignalLearningEnabled(env = process.env) {
  return TRUE_VALUES.has(String(env.LUNA_SIGNAL_LEARNING_ENABLED || 'false').trim().toLowerCase());
}

export function signalPolicyConfigFromEnv(env = process.env) {
  return {
    markets: parseList(env.LUNA_SIGNAL_POLICY_MARKETS, MARKET_DEFAULTS),
    ensembleSizes: parseIntList(env.LUNA_SIGNAL_ENSEMBLE_SIZES, [1, 3, 5]),
    gapPenaltyWeights: parseNumberList(env.LUNA_SIGNAL_GAP_PENALTY_WEIGHTS, [0, 0.25, 0.5]),
    regimeModes: parseList(env.LUNA_SIGNAL_REGIME_MODES, ['none', 'trend_filter']),
    regimeConfidenceThreshold: clamp(env.LUNA_SIGNAL_REGIME_CONFIDENCE_THRESHOLD ?? 0.55, 0, 1),
    learningRate: clamp(env.LUNA_SIGNAL_POLICY_LEARNING_RATE ?? 0.2, 0, 1),
    epsilon: clamp(env.LUNA_SIGNAL_POLICY_EPSILON ?? 0.05, 0, 1),
    positiveRateWeight: safeNumber(env.LUNA_SIGNAL_POSITIVE_RATE_WEIGHT, 0.25),
    wfPassWeight: safeNumber(env.LUNA_SIGNAL_WF_PASS_WEIGHT, 0.25),
    maxVariants: Math.max(1, Math.round(safeNumber(env.LUNA_SIGNAL_POLICY_MAX_VARIANTS, 18))),
    minSamples: Math.max(1, Math.round(safeNumber(env.LUNA_SIGNAL_POLICY_MIN_SAMPLES, 3))),
  };
}

export function buildSignalPolicyCandidates(config = signalPolicyConfigFromEnv()) {
  const policies = [];
  for (const ensembleSize of config.ensembleSizes) {
    for (const gapPenaltyWeight of config.gapPenaltyWeights) {
      for (const regimeMode of config.regimeModes) {
        const policy = {
          ensembleSize,
          gapPenaltyWeight,
          regimeMode,
          regimeConfidenceThreshold: config.regimeConfidenceThreshold,
          positiveRateWeight: config.positiveRateWeight,
          wfPassWeight: config.wfPassWeight,
          learningRate: config.learningRate,
          epsilon: config.epsilon,
        };
        policies.push({
          name: `ensemble${ensembleSize}_gap${String(gapPenaltyWeight).replace('.', 'p')}_${regimeMode}`,
          config: policy,
        });
      }
    }
  }
  return policies.slice(0, config.maxVariants);
}

function trialSharpes(row = {}) {
  const raw = parseJson(row.trial_sharpes, row.trial_sharpes || []);
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => safeNumber(item)).filter((item) => item != null);
}

function ensembleIsSharpe(row = {}, ensembleSize = 1) {
  const trials = trialSharpes(row);
  if (trials.length === 0 || Number(ensembleSize) <= 1) {
    return safeNumber(row.sharpe_is ?? row.sharpe);
  }
  const top = [...trials].sort((a, b) => b - a).slice(0, Math.max(1, Number(ensembleSize)));
  return mean(top);
}

function normalizeRegime(row = {}) {
  const regime = String(row.llm_regime || row.rule_regime || row.regime || 'unknown').trim().toLowerCase();
  const confidence = safeNumber(row.llm_confidence ?? row.rule_confidence ?? row.confidence, 0);
  return { regime, confidence };
}

function trendRegimePass(regimeInfo = {}, threshold = 0.55) {
  const regime = String(regimeInfo.regime || '').toLowerCase();
  const confidence = safeNumber(regimeInfo.confidence, 0);
  if (confidence < threshold) return false;
  return /(trend|bull|up|momentum)/.test(regime);
}

export function evaluatePolicyForRow(row = {}, policy = {}, regimeInfo = {}) {
  const oosSharpe = safeNumber(row.sharpe_oos);
  if (oosSharpe == null) {
    return { ok: false, reason: 'missing_oos_sharpe' };
  }
  if (policy.regimeMode === 'trend_filter' && !trendRegimePass(regimeInfo, policy.regimeConfidenceThreshold)) {
    return { ok: false, reason: 'regime_filter_no_pass' };
  }

  const isSharpe = ensembleIsSharpe(row, policy.ensembleSize);
  const rawGap = safeNumber(row.overfit_gap, isSharpe == null ? 0 : isSharpe - oosSharpe);
  const effectiveGap = Math.max(0, safeNumber(rawGap, 0));
  const adjustedGap = isSharpe == null ? effectiveGap : Math.max(0, isSharpe - oosSharpe);
  const gapForPenalty = policy.ensembleSize > 1 ? Math.min(effectiveGap, adjustedGap) : effectiveGap;
  const gapPenalty = safeNumber(policy.gapPenaltyWeight, 0) * gapForPenalty;
  const adjustedScore = oosSharpe - gapPenalty;
  return {
    ok: true,
    oosSharpe,
    isSharpe,
    overfitGap: effectiveGap,
    gapForPenalty,
    adjustedScore,
    wfPass: String(row.selection_method || '').trim() === 'walk_forward' && String(row.oos_status || '').trim() === 'ok',
    oosPositive: oosSharpe > 0,
    verifiedHealthy: row.healthy === true && String(row.oos_status || '').trim() === 'ok',
  };
}

function previousScoreFor(policyName, market, previousScores = []) {
  const found = previousScores.find((row) => row.policy_name === policyName && row.market === market);
  return safeNumber(found?.score);
}

export function evaluateSignalPolicyShadow({
  rows = [],
  policies = buildSignalPolicyCandidates(),
  regimeByMarket = {},
  previousScores = [],
  config = signalPolicyConfigFromEnv(),
  observedAt = new Date(),
} = {}) {
  const results = [];
  const markets = [...new Set(rows.map((row) => String(row.market || 'unknown')).filter(Boolean))].sort();

  for (const market of markets) {
    const marketRows = rows.filter((row) => String(row.market || 'unknown') === market);
    const regimeInfo = normalizeRegime(regimeByMarket[market] || {});
    const baselineRaw = mean(marketRows.map((row) => safeNumber(row.sharpe_oos)).filter((value) => value != null));

    for (const policy of policies) {
      const evaluated = [];
      const skipped = [];
      for (const row of marketRows) {
        const result = evaluatePolicyForRow(row, policy.config, regimeInfo);
        if (result.ok) evaluated.push(result);
        else skipped.push(result.reason);
      }
      const sampleCount = evaluated.length;
      const oosSharpe = mean(evaluated.map((row) => row.adjustedScore));
      const avgRawOos = mean(evaluated.map((row) => row.oosSharpe));
      const avgGap = mean(evaluated.map((row) => row.overfitGap));
      const wfPassRate = sampleCount > 0 ? evaluated.filter((row) => row.wfPass).length / sampleCount : null;
      const oosPositiveRate = sampleCount > 0 ? evaluated.filter((row) => row.oosPositive).length / sampleCount : null;
      const verifiedHealthyCount = evaluated.filter((row) => row.verifiedHealthy).length;
      const rawScore = sampleCount > 0
        ? (safeNumber(oosSharpe, 0)
          + safeNumber(policy.config.positiveRateWeight, 0) * safeNumber(oosPositiveRate, 0)
          + safeNumber(policy.config.wfPassWeight, 0) * safeNumber(wfPassRate, 0))
        : null;
      const priorScore = previousScoreFor(policy.name, market, previousScores);
      const learningRate = safeNumber(policy.config.learningRate, config.learningRate);
      const score = rawScore == null
        ? priorScore
        : priorScore == null
          ? rawScore
          : priorScore + learningRate * (rawScore - priorScore);
      const scoreDelta = rawScore == null || priorScore == null ? null : score - priorScore;

      results.push({
        policyName: policy.name,
        policyConfig: policy.config,
        market,
        sampleCount,
        skippedCount: skipped.length,
        oosPositiveRate: round(oosPositiveRate),
        oosSharpe: round(avgRawOos),
        overfitGap: round(avgGap),
        wfPassRate: round(wfPassRate),
        verifiedHealthyCount,
        baselineScore: round(baselineRaw),
        rawScore: round(rawScore),
        score: round(score, 6) ?? 0,
        scoreDelta: round(scoreDelta),
        dataHealth: sampleCount >= config.minSamples ? 'ready' : sampleCount > 0 ? 'low_sample' : 'insufficient',
        componentScores: {
          adjustedOosSharpe: round(oosSharpe),
          avgRawOosSharpe: round(avgRawOos),
          avgOverfitGap: round(avgGap),
          oosPositiveRate: round(oosPositiveRate),
          wfPassRate: round(wfPassRate),
          regime: regimeInfo.regime,
          regimeConfidence: round(regimeInfo.confidence),
          skippedReasons: skipped.reduce((acc, reason) => {
            acc[reason] = (acc[reason] || 0) + 1;
            return acc;
          }, {}),
        },
        shadowOnly: true,
        observedAt,
      });
    }
  }
  return results.sort((a, b) => String(a.market).localeCompare(String(b.market)) || b.score - a.score);
}

export default {
  isSignalLearningEnabled,
  signalPolicyConfigFromEnv,
  buildSignalPolicyCandidates,
  evaluatePolicyForRow,
  evaluateSignalPolicyShadow,
};
