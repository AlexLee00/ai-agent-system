// @ts-nocheck

import { get, query, run } from './db/core.ts';
import { buildLunaDeploymentDecisionSpec } from './luna-deployment-spec.ts';
import {
  DEFAULT_LUNA_WEIGHT_POLICY,
  normalizeLunaWeightPolicy,
} from './luna-autonomous-weight-feedback.ts';

const VALID_MARKETS = new Set(['crypto', 'domestic', 'overseas']);

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min = 0, max = 1, fallback = 0) {
  return Math.max(min, Math.min(max, finiteNumber(value, fallback)));
}

function round(value, digits = 6) {
  return Number(Number(value || 0).toFixed(digits));
}

function timeMs(value) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function ageHoursAt(value, asOf = new Date()) {
  const observed = timeMs(value);
  const asOfMs = timeMs(asOf);
  if (observed == null || asOfMs == null) return Infinity;
  return Math.max(0, (asOfMs - observed) / 3600_000);
}

function parseJsonMaybe(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function listMaybe(value = []) {
  const parsed = Array.isArray(value) ? value : parseJsonMaybe(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function roundWeightMap(weights = {}) {
  return Object.fromEntries(
    Object.entries(weights || {}).map(([key, value]) => [key, round(value, 6)]),
  );
}

function normalizeBottleneck(bottleneck = {}) {
  const action = String(bottleneck?.recommended_action || bottleneck?.recommendedAction || '').trim();
  const severity = String(bottleneck?.severity || '').trim();
  const parsedReasons = Array.isArray(bottleneck?.reasons)
    ? bottleneck.reasons
    : parseJsonMaybe(bottleneck?.reasons, []);
  const reasons = Array.isArray(parsedReasons) ? parsedReasons : [];
  const penalty = clamp(
    bottleneck?.candidate_selection_penalty ?? bottleneck?.candidateSelectionPenalty,
    0,
    0.85,
    0,
  );
  const hardHold = action === 'quarantine_candidate_shadow' || severity === 'blocker';
  return {
    present: Boolean(action || severity || penalty > 0 || reasons.length > 0),
    action: action || null,
    severity: severity || null,
    reasons,
    penalty,
    hardHold,
    observedAt: bottleneck?.observed_at || bottleneck?.observedAt || null,
    raw: bottleneck || null,
  };
}

function normalizeStrategyQuality(strategyQuality = {}) {
  const reasons = listMaybe(strategyQuality?.reasons);
  const enhancementStatus = String(strategyQuality?.enhancement_status ?? strategyQuality?.enhancementStatus ?? '').trim();
  const hyperoptStatus = String(strategyQuality?.hyperopt_status ?? strategyQuality?.hyperoptStatus ?? '').trim();
  const maxDrawdownGuard = String(strategyQuality?.max_drawdown_guard ?? strategyQuality?.maxDrawdownGuard ?? '').trim();
  const providerStatus = String(strategyQuality?.provider_status ?? strategyQuality?.providerStatus ?? '').trim();
  const hasIndicatorScore = strategyQuality?.indicator_score != null || strategyQuality?.indicatorScore != null;
  const indicatorScore = clamp(strategyQuality?.indicator_score ?? strategyQuality?.indicatorScore, 0, 1, 0);
  const evidence = parseJsonMaybe(strategyQuality?.evidence, {});
  const remediation = strategyQuality?.strategyRemediation || evidence?.strategyRemediation || {};
  const formulationPlan = remediation?.strategyFormulationPlan || {};
  const remediationBlockers = listMaybe(remediation?.blockers);
  const remediationWatchSignals = listMaybe(remediation?.watchSignals);
  const recommendedActions = listMaybe(remediation?.recommendedActions);
  const formulationExitCriteria = listMaybe(formulationPlan?.blockerExitCriteria);
  const formulationAllowedExperiments = listMaybe(formulationPlan?.allowedExperiments);
  const remediationStatus = String(remediation?.status || '').trim();
  const formulationMode = String(formulationPlan?.mode || '').trim();
  const formulationPrimaryFamily = String(formulationPlan?.primaryExperimentFamily || '').trim();
  const present = Boolean(enhancementStatus || hyperoptStatus || maxDrawdownGuard || providerStatus || hasIndicatorScore || reasons.length > 0);
  const readyStatus = ['shadow_ready', 'shadow_ready_with_risk_tightening', 'shadow_probation_with_risk_tightening', 'shadow_tuned', 'shadow_evaluated']
    .includes(enhancementStatus);
  const strategyNotReady = present && enhancementStatus && !readyStatus;
  const hardHold = maxDrawdownGuard === 'block_live_forward' || strategyNotReady;
  const hardHoldReason = maxDrawdownGuard === 'block_live_forward'
    ? 'strategy_quality_block_live_forward'
    : strategyNotReady
      ? 'strategy_quality_not_shadow_ready'
      : null;
  const statusPenalty = enhancementStatus && !readyStatus ? 0.18 : 0;
  const probationPenalty = enhancementStatus === 'shadow_probation_with_risk_tightening' ? 0.35 : 0;
  const hyperoptPenalty = hyperoptStatus === 'planned' ? 0.12 : 0;
  const drawdownPenalty = hardHold ? 0.85 : maxDrawdownGuard === 'tighten_risk' ? 0.22 : 0;
  const indicatorPenalty = hasIndicatorScore ? clamp((0.55 - indicatorScore) * 0.30, 0, 0.25, 0) : 0;
  const penalty = present
    ? clamp(
      strategyQuality?.strategy_quality_penalty ?? strategyQuality?.strategyQualityPenalty,
      0,
      0.85,
      Math.max(statusPenalty, probationPenalty, hyperoptPenalty, drawdownPenalty, indicatorPenalty),
    )
    : 0;
  const operatingState = !present
    ? 'missing'
    : hardHold
      ? 'hard_hold'
      : remediationStatus === 'paper_only_probation' || enhancementStatus === 'shadow_probation_with_risk_tightening'
        ? 'paper_probation'
        : remediationStatus === 'risk_tightened_monitor' || maxDrawdownGuard === 'tighten_risk'
          ? 'risk_tightened_monitor'
          : 'ready_monitor';
  return {
    present,
    enhancementStatus: enhancementStatus || null,
    hyperoptStatus: hyperoptStatus || null,
    maxDrawdownGuard: maxDrawdownGuard || null,
    indicatorScore,
    providerStatus: providerStatus || null,
    remediationStatus: remediationStatus || null,
    formulationMode: formulationMode || null,
    formulationPrimaryFamily: formulationPrimaryFamily || null,
    formulationAllowedFamilies: formulationAllowedExperiments.map((experiment) => experiment?.family).filter(Boolean),
    formulationExitCriteria,
    formulationQualityGaps: formulationPlan?.qualityGaps || {},
    remediationBlockers,
    remediationWatchSignals,
    recommendedActions,
    operatingState,
    reasons,
    penalty,
    hardHold,
    hardHoldReason,
    observedAt: strategyQuality?.observed_at || strategyQuality?.observedAt || null,
    raw: strategyQuality || null,
  };
}

export function normalizeLunaPhase2Market(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'binance') return 'crypto';
  if (raw === 'kis') return 'domestic';
  if (raw === 'kis_overseas') return 'overseas';
  return VALID_MARKETS.has(raw) ? raw : 'crypto';
}

export function exchangeForLunaPhase2Market(market = 'crypto') {
  const normalized = normalizeLunaPhase2Market(market);
  if (normalized === 'domestic') return 'kis';
  if (normalized === 'overseas') return 'kis_overseas';
  return 'binance';
}

export function normalizeLunaPhase2Symbol(symbol = '') {
  return String(symbol || '').trim().toUpperCase();
}

export function normalizeLunaPhase2Symbols(symbols = []) {
  const values = Array.isArray(symbols)
    ? symbols
    : String(symbols || '').split(',');
  return [...new Set(values.map((symbol) => normalizeLunaPhase2Symbol(symbol)).filter(Boolean))];
}

export async function ensureLunaPhase2Schema() {
  await run(`
    CREATE TABLE IF NOT EXISTS luna_weight_vector_shadow (
      id                  BIGSERIAL PRIMARY KEY,
      symbol              TEXT NOT NULL,
      market              TEXT NOT NULL,
      exchange            TEXT NOT NULL,
      candidate_score     DOUBLE PRECISION DEFAULT 0,
      backtest_score      DOUBLE PRECISION DEFAULT 0,
      predictive_score    DOUBLE PRECISION DEFAULT 0,
      community_score     DOUBLE PRECISION DEFAULT 0,
      target_weight       DOUBLE PRECISION DEFAULT 0,
      confidence          DOUBLE PRECISION DEFAULT 0,
      risk_budget_usdt    DOUBLE PRECISION DEFAULT 0,
      signal              TEXT NOT NULL DEFAULT 'hold',
      gate_status         TEXT NOT NULL DEFAULT 'shadow',
      no_lookahead_ok     BOOLEAN DEFAULT TRUE,
      shadow_only         BOOLEAN DEFAULT TRUE,
      evidence            JSONB DEFAULT '{}'::jsonb,
      observed_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_weight_vector_shadow_symbol ON luna_weight_vector_shadow(symbol, market, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_weight_vector_shadow_signal ON luna_weight_vector_shadow(signal, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_weight_vector_shadow_observed ON luna_weight_vector_shadow(observed_at DESC)`);

  await run(`
    CREATE TABLE IF NOT EXISTS luna_paper_trading_shadow (
      id                   BIGSERIAL PRIMARY KEY,
      symbol               TEXT NOT NULL,
      market               TEXT NOT NULL,
      exchange             TEXT NOT NULL,
      target_weight        DOUBLE PRECISION DEFAULT 0,
      current_weight       DOUBLE PRECISION DEFAULT 0,
      delta_weight         DOUBLE PRECISION DEFAULT 0,
      paper_side           TEXT NOT NULL DEFAULT 'HOLD',
      paper_notional_usdt  DOUBLE PRECISION DEFAULT 0,
      paper_quantity       DOUBLE PRECISION DEFAULT 0,
      reference_price      DOUBLE PRECISION DEFAULT 0,
      confidence           DOUBLE PRECISION DEFAULT 0,
      status               TEXT NOT NULL DEFAULT 'planned',
      shadow_only          BOOLEAN DEFAULT TRUE,
      evidence             JSONB DEFAULT '{}'::jsonb,
      observed_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_paper_trading_shadow_symbol ON luna_paper_trading_shadow(symbol, market, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_paper_trading_shadow_side ON luna_paper_trading_shadow(paper_side, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_paper_trading_shadow_observed ON luna_paper_trading_shadow(observed_at DESC)`);

  await run(`
    CREATE TABLE IF NOT EXISTS luna_paper_promotion_gate_shadow (
      id                         BIGSERIAL PRIMARY KEY,
      symbol                     TEXT NOT NULL,
      market                     TEXT NOT NULL,
      exchange                   TEXT NOT NULL,
      decision                   TEXT NOT NULL DEFAULT 'shadow_promotion_blocked',
      promotion_candidate        BOOLEAN DEFAULT FALSE,
      cycle_count                INTEGER DEFAULT 0,
      pass_count                 INTEGER DEFAULT 0,
      consecutive_passes         INTEGER DEFAULT 0,
      avg_confidence             DOUBLE PRECISION DEFAULT 0,
      total_paper_notional_usdt  DOUBLE PRECISION DEFAULT 0,
      block_reasons              JSONB DEFAULT '[]'::jsonb,
      shadow_only                BOOLEAN DEFAULT TRUE,
      evidence                   JSONB DEFAULT '{}'::jsonb,
      observed_at                TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_paper_promotion_gate_symbol ON luna_paper_promotion_gate_shadow(symbol, market, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_paper_promotion_gate_decision ON luna_paper_promotion_gate_shadow(decision, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_paper_promotion_gate_candidate ON luna_paper_promotion_gate_shadow(promotion_candidate, observed_at DESC)`);
}

export function evaluateNoLookaheadContract({ asOf = new Date(), sources = [] } = {}) {
  const asOfTime = new Date(asOf).getTime();
  const violations = [];
  for (const source of sources || []) {
    const observedAt = source?.observedAt || source?.observed_at || source?.created_at || source?.createdAt || null;
    if (!observedAt) continue;
    const observedTime = new Date(observedAt).getTime();
    if (Number.isFinite(observedTime) && observedTime > asOfTime + 1000) {
      violations.push({
        source: source?.source || source?.name || 'unknown',
        observedAt: new Date(observedTime).toISOString(),
        asOf: new Date(asOfTime).toISOString(),
      });
    }
  }
  return {
    ok: violations.length === 0,
    violations,
  };
}

function scoreBacktest(backtest = {}) {
  const fresh = backtest?.fresh === true || String(backtest?.fresh).toLowerCase() === 'true';
  const healthy = backtest?.healthy === true || String(backtest?.healthy).toLowerCase() === 'true';
  const wouldBlock = backtest?.would_block === true || backtest?.wouldBlock === true || String(backtest?.would_block).toLowerCase() === 'true';
  const drawdown = Math.abs(finiteNumber(backtest?.max_drawdown ?? backtest?.maxDrawdown, 30));
  const drawdownTooHigh = drawdown > 30;
  if (!fresh || !healthy || wouldBlock || drawdownTooHigh) {
    return {
      score: 0,
      pass: false,
      reasons: [
        !fresh ? 'backtest_stale_or_missing' : null,
        !healthy ? 'backtest_unhealthy' : null,
        wouldBlock ? 'backtest_would_block' : null,
        drawdownTooHigh ? 'backtest_drawdown_high' : null,
      ].filter(Boolean),
    };
  }

  const sharpeScore = clamp((finiteNumber(backtest?.sharpe, 0) + 1) / 3, 0, 1, 0);
  const winRateRaw = finiteNumber(backtest?.win_rate ?? backtest?.winRate, 0);
  const winRateScore = clamp(winRateRaw > 1 ? winRateRaw / 100 : winRateRaw, 0, 1, 0);
  const drawdownScore = clamp(1 - drawdown / 30, 0, 1, 0);
  return {
    score: round(sharpeScore * 0.45 + winRateScore * 0.35 + drawdownScore * 0.20, 4),
    pass: true,
    reasons: [],
  };
}

function scorePredictive(predictive = {}) {
  const decision = String(predictive?.decision || '').toLowerCase();
  const score = clamp(predictive?.score, 0, 1, 0);
  const componentCoverage = clamp(predictive?.component_coverage ?? predictive?.componentCoverage, 0, 1, 0);
  const pass = ['fire', 'pass', 'pass_prediction'].includes(decision);
  return {
    score: pass ? score : round(score * 0.35, 4),
    pass,
    decision: predictive?.decision || null,
    componentCoverage,
    createdAt: predictive?.created_at || predictive?.createdAt || null,
  };
}

function scoreCommunity(community = {}) {
  const hasSymbolScore = community?.avg_score != null || community?.score != null;
  const avg = finiteNumber(community?.avg_score ?? community?.score, 0);
  const marketAvg = finiteNumber(community?.market_avg_score ?? community?.marketAvgScore, 0);
  const marketContext = community?.market_avg_score != null || community?.marketAvgScore != null
    ? clamp((marketAvg + 1) / 2, 0, 1, 0.5) - 0.5
    : 0;
  const normalized = hasSymbolScore
    ? clamp((avg + 1) / 2, 0, 1, 0.5)
    : clamp(0.5 + marketContext * 0.35, 0, 1, 0.5);
  const sourceCount = finiteNumber(community?.source_count ?? community?.sourceCount, 0);
  const marketSourceCount = finiteNumber(community?.market_source_count ?? community?.marketSourceCount, 0);
  const diversityBonus = Math.min(0.08, Math.max(0, sourceCount - 1) * 0.025);
  const marketContextBonus = hasSymbolScore ? Math.min(0.025, marketSourceCount * 0.006) : Math.min(0.04, marketSourceCount * 0.008);
  const sourceQuality = clamp(
    community?.avg_source_quality ?? community?.avgSourceQuality ?? community?.market_avg_quality ?? community?.marketAvgQuality,
    0,
    1,
    hasSymbolScore ? 0.45 : 0.35,
  );
  const qualityAdjustment = clamp((sourceQuality - 0.40) * 0.16, -0.06, 0.08, 0);
  const botNoise = clamp(community?.bot_noise_score ?? community?.botNoiseScore, 0, 1, 0);
  const hypeSpike = community?.hype_spike === true || community?.hypeSpike === true;
  const penalty = Math.min(0.20, botNoise * 0.15 + (hypeSpike ? 0.05 : 0));
  return {
    score: round(clamp(normalized + diversityBonus + marketContextBonus + qualityAdjustment - penalty, 0, 1, 0.5), 4),
    sourceCount,
    marketSourceCount,
    sourceQuality,
    marketContextScore: round(marketContext, 4),
    botNoise,
    hypeSpike,
  };
}

function uniqueList(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function buildQualityActionPlan(context = {}) {
  const {
    symbol,
    market,
    signal,
    confidence,
    eligible,
    hardReasons = [],
    bottleneck = {},
    strategyQuality = {},
    backtest = {},
    predictive = {},
    noLookahead = {},
  } = context;
  const blockedComponents = uniqueList([
    bottleneck.hardHold || hardReasons.some((reason) => String(reason).startsWith('candidate_bottleneck_')) ? 'candidate_bottleneck' : null,
    strategyQuality.hardHold || hardReasons.some((reason) => String(reason).startsWith('strategy_quality_')) ? 'strategy_quality' : null,
    !backtest.pass ? 'backtest' : null,
    !predictive.decision || !predictive.pass ? 'predictive' : null,
    !noLookahead.ok ? 'no_lookahead' : null,
  ]);
  const monitorComponents = uniqueList([
    strategyQuality.operatingState === 'paper_probation' ? 'strategy_quality_probation' : null,
    strategyQuality.operatingState === 'risk_tightened_monitor' ? 'strategy_quality_monitor' : null,
  ]);
  const requiredConditions = [];
  const nextShadowCommands = [];
  const addCommand = (script) => {
    if (!nextShadowCommands.includes(script)) nextShadowCommands.push(script);
  };
  const scopedArgs = `--dry-run --market=${market || 'all'} --symbols=${symbol} --limit=20`;

  let primaryAction = 'shadow_monitor';
  let priority = 'p3';

  if (!noLookahead.ok) {
    primaryAction = 'repair_source_timestamp_contract';
    priority = 'p0';
    requiredConditions.push('all source timestamps must be <= asOf before any shadow allocation can be trusted');
    addCommand(`npm --prefix bots/investment run -s runtime:luna-weight-vector-shadow -- --json ${scopedArgs}`);
  } else if (strategyQuality.hardHold) {
    primaryAction = 'strategy_reformulation_shadow_required';
    priority = 'p0';
    requiredConditions.push('strategy quality must leave hard_hold');
    requiredConditions.push('max_drawdown_guard must not be block_live_forward');
    requiredConditions.push('indicator recovery or explicit paper-probation evidence is required');
    addCommand(`npm --prefix bots/investment run -s runtime:luna-phase4-strategy-enhancement-shadow -- --json ${scopedArgs}`);
  } else if (bottleneck.hardHold) {
    primaryAction = 'candidate_bottleneck_remediation_required';
    priority = 'p0';
    requiredConditions.push('candidate bottleneck severity must clear blocker/quarantine state');
    requiredConditions.push('bottleneck reasons must be reduced before allocation is reconsidered');
    addCommand(`npm --prefix bots/investment run -s runtime:luna-candidate-bottleneck-diagnostics -- --json ${scopedArgs}`);
    addCommand(`npm --prefix bots/investment run -s runtime:luna-candidate-quality-remediation -- --json ${scopedArgs}`);
  } else if (!backtest.pass) {
    primaryAction = 'backtest_refresh_required';
    priority = 'p1';
    requiredConditions.push('backtest must be fresh and healthy');
    requiredConditions.push('max drawdown must remain within the backtest guard');
    addCommand(`npm --prefix bots/investment run -s runtime:luna-candidate-backtest-refresh -- --json ${scopedArgs}`);
  } else if (!predictive.decision || !predictive.pass) {
    primaryAction = 'predictive_refresh_required';
    priority = 'p1';
    requiredConditions.push('predictive decision must pass with sufficient component coverage');
    requiredConditions.push('candidate bottleneck predictive coverage reason must clear');
    addCommand(`npm --prefix bots/investment run -s runtime:luna-predictive-evidence-refresh -- --json ${scopedArgs}`);
    addCommand(`npm --prefix bots/investment run -s runtime:luna-candidate-bottleneck-diagnostics -- --json ${scopedArgs}`);
  } else if (strategyQuality.operatingState === 'paper_probation') {
    primaryAction = 'paper_probation_shadow_required';
    priority = 'p2';
    requiredConditions.push('paper-probation must remain shadow-only until consecutive evidence clears promotion gate');
    addCommand(`npm --prefix bots/investment run -s runtime:luna-phase4-strategy-enhancement-shadow -- --json ${scopedArgs}`);
  } else if (strategyQuality.operatingState === 'risk_tightened_monitor') {
    primaryAction = 'risk_tightened_shadow_monitor';
    priority = 'p2';
    requiredConditions.push('risk-tightened monitor must keep drawdown and indicator guards stable');
    addCommand(`npm --prefix bots/investment run -s runtime:luna-weight-vector-shadow -- --json ${scopedArgs}`);
  } else if (eligible && signal === 'hold') {
    primaryAction = 'confidence_below_allocation_floor';
    priority = 'p2';
    requiredConditions.push('confidence must reach watch/increase threshold without weakening hard gates');
    addCommand(`npm --prefix bots/investment run -s runtime:luna-weight-vector-shadow -- --json ${scopedArgs}`);
  } else if (eligible && signal === 'watch') {
    primaryAction = 'watchlist_shadow_monitor';
    priority = 'p3';
    requiredConditions.push('continue shadow monitoring before any promotion decision');
    addCommand(`npm --prefix bots/investment run -s runtime:luna-weight-vector-shadow -- --json ${scopedArgs}`);
  } else if (eligible && signal === 'increase') {
    primaryAction = 'allocation_candidate_shadow_ready';
    priority = 'p3';
    requiredConditions.push('shadow allocation candidate only; live promotion still requires explicit gate and approval');
    addCommand(`npm --prefix bots/investment run -s runtime:luna-weight-vector-shadow -- --json ${scopedArgs}`);
  }

  return {
    primaryAction,
    priority,
    blockedComponents,
    monitorComponents,
    requiredConditions,
    hardReasons,
    confidence: round(confidence, 4),
    signal,
    shadowOnly: true,
    liveMutation: false,
    nextShadowCommands,
  };
}

function reconcileBottleneckWithCurrentEvidence(bottleneck = {}, evidence = {}, options = {}) {
  const predictive = evidence.predictive || {};
  const originalReasons = Array.isArray(bottleneck.reasons) ? bottleneck.reasons : [];
  const resolvedReasons = [];
  const stalePredictiveHours = finiteNumber(options.stalePredictiveHours, 24 * 7);
  const predictiveObservedAt = predictive.createdAt || predictive.created_at || null;
  const predictiveObservedMs = timeMs(predictiveObservedAt);
  const bottleneckObservedMs = timeMs(bottleneck.observedAt);
  const predictiveFresh = ageHoursAt(predictiveObservedAt, options.asOf || new Date()) <= stalePredictiveHours;
  const predictiveNewerThanBottleneck = bottleneckObservedMs == null
    || (predictiveObservedMs != null && predictiveObservedMs >= bottleneckObservedMs - 1000);
  const predictiveCanResolve = predictiveFresh && predictiveNewerThanBottleneck;
  const predictiveCoverageOk = predictiveCanResolve && predictive.pass === true && Number(predictive.componentCoverage || 0) >= 0.75;
  const predictivePass = predictiveCanResolve && predictive.pass === true && Boolean(predictive.decision);
  const reasons = originalReasons.filter((reason) => {
    const value = String(reason || '');
    if (value === 'predictive_coverage_low' && predictiveCoverageOk) {
      resolvedReasons.push(value);
      return false;
    }
    if ((value === 'predictive_blocked' || value === 'predictive_missing_or_stale') && predictivePass) {
      resolvedReasons.push(value);
      return false;
    }
    return true;
  });
  const predictiveActionResolved = bottleneck.action === 'predictive_refresh'
    && originalReasons.some((reason) => String(reason || '').startsWith('predictive_'))
    && !reasons.some((reason) => String(reason || '').startsWith('predictive_'));
  const fullyResolved = predictiveActionResolved && reasons.length === 0;
  return {
    ...bottleneck,
    present: fullyResolved ? false : bottleneck.present,
    action: fullyResolved ? null : bottleneck.action,
    severity: fullyResolved ? null : bottleneck.severity,
    reasons,
    penalty: fullyResolved ? 0 : bottleneck.penalty,
    hardHold: fullyResolved ? false : (bottleneck.hardHold && reasons.length > 0),
    resolvedReasons,
    resolvedByCurrentEvidence: resolvedReasons.length > 0,
  };
}

export function buildLunaWeightVector(input = {}, config = {}) {
  const candidate = input.candidate || input;
  const symbol = normalizeLunaPhase2Symbol(candidate?.symbol);
  const market = normalizeLunaPhase2Market(candidate?.market || input?.market);
  const exchange = candidate?.exchange || exchangeForLunaPhase2Market(market);
  const asOf = input.asOf || new Date().toISOString();
  const rawCandidateScore = clamp(candidate?.score ?? candidate?.candidate_score, 0, 1, 0.5);
  const strategyQuality = normalizeStrategyQuality(input.strategyQuality || input.strategy_quality || candidate?.strategyQuality || candidate?.strategy_quality || {});
  const backtest = scoreBacktest(input.backtest || candidate?.backtest || {});
  const predictive = scorePredictive(input.predictive || candidate?.predictive || {});
  const community = scoreCommunity(input.community || candidate?.community || {});
  const bottleneck = reconcileBottleneckWithCurrentEvidence(
    normalizeBottleneck(input.bottleneck || candidate?.bottleneck || {}),
    { predictive, backtest, community },
    { asOf, stalePredictiveHours: config?.stalePredictiveHours || config?.stalePredictiveEvidenceHours || 24 * 7 },
  );
  const bottleneckAdjustedCandidateScore = rawCandidateScore * (1 - bottleneck.penalty);
  const candidateScore = round(bottleneckAdjustedCandidateScore * (1 - strategyQuality.penalty), 4);
  const decisionSpec = buildLunaDeploymentDecisionSpec({
    ...input,
    candidate,
    asOf,
    mode: 'weight-vector-shadow',
    exchange,
  });
  const noLookahead = evaluateNoLookaheadContract({
    asOf,
    sources: [
      { source: 'candidate', observedAt: candidate?.discovered_at || candidate?.discoveredAt },
      { source: 'backtest', observedAt: input.backtest?.last_backtest_at || input.backtest?.lastBacktestAt },
      { source: 'predictive', observedAt: input.predictive?.created_at || input.predictive?.createdAt },
      { source: 'community', observedAt: input.community?.last_seen_at || input.community?.lastSeenAt },
      { source: 'strategy_quality', observedAt: strategyQuality.observedAt },
    ],
  });

  const weightFeedback = config?.autonomousWeightFeedback || config?.weightFeedback || null;
  const weights = normalizeLunaWeightPolicy(
    config?.weights || weightFeedback?.weights || DEFAULT_LUNA_WEIGHT_POLICY,
    DEFAULT_LUNA_WEIGHT_POLICY,
  );
  const weightTotal = Object.values(weights).reduce((sum, value) => sum + Math.max(0, value), 0) || 1;
  const confidence = clamp(
    (candidateScore * weights.candidate
      + backtest.score * weights.backtest
      + predictive.score * weights.predictive
      + community.score * weights.community) / weightTotal,
    0,
    1,
    0,
  );
  const counterfactualConfidence = clamp(
    (rawCandidateScore * weights.candidate
      + backtest.score * weights.backtest
      + predictive.score * weights.predictive
      + community.score * weights.community) / weightTotal,
    0,
    1,
    0,
  );

  const maxTargetWeightByMarket = {
    crypto: finiteNumber(config?.maxTargetWeightCrypto, 0.10),
    domestic: finiteNumber(config?.maxTargetWeightDomestic, 0.08),
    overseas: finiteNumber(config?.maxTargetWeightOverseas, 0.08),
  };
  const hardReasons = [
    bottleneck.hardHold ? 'candidate_bottleneck_quarantine' : null,
    strategyQuality.hardHold ? strategyQuality.hardHoldReason || 'strategy_quality_hard_hold' : null,
    ...((bottleneck.reasons || []).map((reason) => `candidate_bottleneck_${reason}`)),
    ...((strategyQuality.hardHold ? strategyQuality.reasons : []).map((reason) => `strategy_quality_${reason}`)),
    ...backtest.reasons,
    !predictive.decision ? 'predictive_missing' : null,
    !predictive.pass ? 'predictive_blocked' : null,
    !noLookahead.ok ? 'no_lookahead_violation' : null,
  ].filter(Boolean);
  const eligible = !bottleneck.hardHold && !strategyQuality.hardHold && backtest.pass && predictive.pass && Boolean(predictive.decision) && noLookahead.ok;
  const signal = !eligible ? 'hold' : confidence >= 0.72 ? 'increase' : confidence >= 0.55 ? 'watch' : 'hold';
  const cap = maxTargetWeightByMarket[market] ?? 0.08;
  const counterfactualEligible = backtest.pass && predictive.pass && Boolean(predictive.decision) && noLookahead.ok;
  const strategyCounterfactualConfidence = clamp(
    (bottleneckAdjustedCandidateScore * weights.candidate
      + backtest.score * weights.backtest
      + predictive.score * weights.predictive
      + community.score * weights.community) / weightTotal,
    0,
    1,
    0,
  );
  const counterfactualSignal = !counterfactualEligible
    ? 'hold'
    : counterfactualConfidence >= 0.72
      ? 'increase'
      : counterfactualConfidence >= 0.55
        ? 'watch'
        : 'hold';
  const targetWeight = signal === 'increase'
    ? cap * confidence
    : signal === 'watch'
      ? cap * confidence * 0.35
      : 0;
  const counterfactualTargetWeight = counterfactualSignal === 'increase'
    ? cap * counterfactualConfidence
    : counterfactualSignal === 'watch'
      ? cap * counterfactualConfidence * 0.35
      : 0;
  const riskBudgetUsdt = finiteNumber(config?.riskBudgetUsdt, 50);
  const qualityActionPlan = buildQualityActionPlan({
    symbol,
    market,
    signal,
    confidence,
    eligible,
    hardReasons,
    bottleneck,
    strategyQuality,
    backtest,
    predictive,
    noLookahead,
  });

  return {
    ok: true,
    symbol,
    market,
    exchange,
    candidateScore: round(candidateScore, 4),
    backtestScore: round(backtest.score, 4),
    predictiveScore: round(predictive.score, 4),
    communityScore: round(community.score, 4),
    targetWeight: round(targetWeight, 6),
    confidence: round(confidence, 4),
    riskBudgetUsdt: round(riskBudgetUsdt * clamp(confidence, 0, 1, 0), 4),
    signal,
    gateStatus: eligible ? 'shadow_pass' : 'shadow_would_block',
    noLookaheadOk: noLookahead.ok,
    shadowOnly: true,
    evidence: {
      phase: 'luna_phase2_finrlx',
      source: 'weight_vector_shadow',
      decisionSpecVersion: decisionSpec.specVersion,
      decisionSpecHash: decisionSpec.specHash,
      decisionSpec,
      components: {
        candidate: {
          score: round(candidateScore, 4),
          rawScore: round(rawCandidateScore, 4),
          bottleneckPenalty: round(bottleneck.penalty, 4),
          strategyQualityPenalty: round(strategyQuality.penalty, 4),
          raw: candidate,
        },
        backtest: { score: round(backtest.score, 4), pass: backtest.pass, raw: input.backtest || null },
        predictive: {
          score: round(predictive.score, 4),
          pass: predictive.pass,
          decision: predictive.decision,
          componentCoverage: round(predictive.componentCoverage, 4),
          createdAt: predictive.createdAt,
          raw: input.predictive || null,
        },
        community: { score: round(community.score, 4), ...community, raw: input.community || null },
      },
      bottleneck: {
        present: bottleneck.present,
        action: bottleneck.action,
        severity: bottleneck.severity,
        reasons: bottleneck.reasons,
        resolvedReasons: bottleneck.resolvedReasons || [],
        resolvedByCurrentEvidence: bottleneck.resolvedByCurrentEvidence === true,
        penalty: round(bottleneck.penalty, 4),
        hardHold: bottleneck.hardHold,
        observedAt: bottleneck.observedAt,
        counterfactual: {
          eligible: counterfactualEligible,
          signal: counterfactualSignal,
          confidence: round(counterfactualConfidence, 4),
          targetWeight: round(counterfactualTargetWeight, 6),
          confidenceDelta: round(counterfactualConfidence - confidence, 4),
          targetWeightDelta: round(counterfactualTargetWeight - targetWeight, 6),
        },
        shadowOnly: true,
        liveMutation: false,
        raw: bottleneck.raw,
      },
      strategyQuality: {
        present: strategyQuality.present,
        enhancementStatus: strategyQuality.enhancementStatus,
        hyperoptStatus: strategyQuality.hyperoptStatus,
        maxDrawdownGuard: strategyQuality.maxDrawdownGuard,
        indicatorScore: round(strategyQuality.indicatorScore, 4),
        providerStatus: strategyQuality.providerStatus,
        remediationStatus: strategyQuality.remediationStatus,
        formulationMode: strategyQuality.formulationMode,
        formulationPrimaryFamily: strategyQuality.formulationPrimaryFamily,
        formulationAllowedFamilies: strategyQuality.formulationAllowedFamilies,
        formulationExitCriteria: strategyQuality.formulationExitCriteria,
        formulationQualityGaps: strategyQuality.formulationQualityGaps,
        remediationBlockers: strategyQuality.remediationBlockers,
        remediationWatchSignals: strategyQuality.remediationWatchSignals,
        recommendedActions: strategyQuality.recommendedActions,
        operatingState: strategyQuality.operatingState,
        reasons: strategyQuality.reasons,
        penalty: round(strategyQuality.penalty, 4),
        hardHold: strategyQuality.hardHold,
        hardHoldReason: strategyQuality.hardHoldReason || null,
        observedAt: strategyQuality.observedAt,
        counterfactual: {
          eligible: !bottleneck.hardHold && backtest.pass && predictive.pass && Boolean(predictive.decision) && noLookahead.ok,
          confidence: round(strategyCounterfactualConfidence, 4),
          confidenceDelta: round(strategyCounterfactualConfidence - confidence, 4),
        },
        shadowOnly: true,
        liveMutation: false,
        raw: strategyQuality.raw,
      },
      weights: {
        source: weightFeedback?.source || (config?.weights ? 'config_weights' : 'static_default'),
        status: weightFeedback?.status || null,
        applied: roundWeightMap(weights),
        base: roundWeightMap(weightFeedback?.baseWeights || DEFAULT_LUNA_WEIGHT_POLICY),
        deltas: roundWeightMap(weightFeedback?.deltas || {}),
        reasons: weightFeedback?.reasons || [],
        metrics: weightFeedback?.metrics || null,
        shadowOnly: true,
        liveMutation: false,
      },
      noLookahead,
      hardReasons,
      qualityActionPlan,
      liveMutation: false,
    },
  };
}

export function buildLunaPaperTradingPlan(weightVector = {}, context = {}) {
  const equityUsdt = Math.max(1, finiteNumber(context?.equityUsdt, 1000));
  const maxOrderUsdt = Math.max(0, finiteNumber(context?.maxOrderUsdt, 50));
  const current = context?.position || {};
  const referencePrice = Math.max(0, finiteNumber(current?.avg_price ?? current?.avgPrice ?? context?.referencePrice, 0));
  const currentNotional = Math.max(0, finiteNumber(current?.amount, 0) * referencePrice);
  const currentWeight = clamp(currentNotional / equityUsdt, 0, 1, 0);
  const targetWeight = clamp(weightVector?.targetWeight, 0, 1, 0);
  const deltaWeight = targetWeight - currentWeight;
  const rawNotional = Math.abs(deltaWeight) * equityUsdt;
  const notional = Math.min(rawNotional, maxOrderUsdt || rawNotional);
  const minNotional = finiteNumber(context?.minNotionalUsdt, 5);
  const paperSide = Math.abs(deltaWeight) < 0.001 || notional < minNotional
    ? 'HOLD'
    : deltaWeight > 0
      ? 'BUY'
      : 'SELL';
  const bottleneck = weightVector?.evidence?.bottleneck || {};
  const strategyQuality = weightVector?.evidence?.strategyQuality || {};
  const counterfactual = bottleneck?.counterfactual || {};
  const counterfactualTargetWeight = clamp(counterfactual.targetWeight, 0, 1, targetWeight);
  const counterfactualDeltaWeight = counterfactualTargetWeight - currentWeight;
  const counterfactualRawNotional = Math.abs(counterfactualDeltaWeight) * equityUsdt;
  const counterfactualNotional = Math.min(counterfactualRawNotional, maxOrderUsdt || counterfactualRawNotional);
  const counterfactualPaperSide = Math.abs(counterfactualDeltaWeight) < 0.001 || counterfactualNotional < minNotional
    ? 'HOLD'
    : counterfactualDeltaWeight > 0
      ? 'BUY'
      : 'SELL';
  const bottleneckPreventedOrder = Boolean(bottleneck?.present)
    && paperSide === 'HOLD'
    && counterfactualPaperSide !== 'HOLD';
  const safePrice = referencePrice > 0 ? referencePrice : finiteNumber(context?.fallbackPrice, 1);

  return {
    ok: true,
    symbol: weightVector?.symbol,
    market: normalizeLunaPhase2Market(weightVector?.market),
    exchange: weightVector?.exchange || exchangeForLunaPhase2Market(weightVector?.market),
    targetWeight: round(targetWeight, 6),
    currentWeight: round(currentWeight, 6),
    deltaWeight: round(deltaWeight, 6),
    paperSide,
    paperNotionalUsdt: paperSide === 'HOLD' ? 0 : round(notional, 4),
    paperQuantity: paperSide === 'HOLD' ? 0 : round(notional / Math.max(safePrice, 0.00000001), 8),
    referencePrice: round(safePrice, 8),
    confidence: round(weightVector?.confidence, 4),
    status: paperSide === 'HOLD' ? 'no_action' : 'planned',
    shadowOnly: true,
    evidence: {
      phase: 'luna_phase2_finrlx',
      source: 'paper_trading_shadow',
      decisionSpecVersion: weightVector?.evidence?.decisionSpecVersion || weightVector?.evidence?.decisionSpec?.specVersion || null,
      decisionSpecHash: weightVector?.evidence?.decisionSpecHash || weightVector?.evidence?.decisionSpec?.specHash || null,
      decisionSpec: weightVector?.evidence?.decisionSpec || null,
      weightVector,
      equityUsdt,
      maxOrderUsdt,
      minNotionalUsdt: minNotional,
      bottleneckAvoidance: {
        present: Boolean(bottleneck?.present),
        action: bottleneck?.action || null,
        severity: bottleneck?.severity || null,
        hardHold: bottleneck?.hardHold === true,
        penalty: round(bottleneck?.penalty || 0, 4),
        preventedOrder: bottleneckPreventedOrder,
        counterfactualSignal: counterfactual?.signal || null,
        counterfactualTargetWeight: round(counterfactualTargetWeight, 6),
        counterfactualDeltaWeight: round(counterfactualDeltaWeight, 6),
        counterfactualPaperSide,
        avoidedNotionalUsdt: bottleneckPreventedOrder ? round(counterfactualNotional, 4) : 0,
        shadowOnly: true,
        liveMutation: false,
      },
      strategyQualityAudit: {
        present: Boolean(strategyQuality?.present),
        enhancementStatus: strategyQuality?.enhancementStatus || null,
        hyperoptStatus: strategyQuality?.hyperoptStatus || null,
        maxDrawdownGuard: strategyQuality?.maxDrawdownGuard || null,
        indicatorScore: round(strategyQuality?.indicatorScore || 0, 4),
        remediationStatus: strategyQuality?.remediationStatus || null,
        formulationMode: strategyQuality?.formulationMode || null,
        operatingState: strategyQuality?.operatingState || null,
        hardHold: strategyQuality?.hardHold === true,
        hardHoldReason: strategyQuality?.hardHoldReason || null,
        penalty: round(strategyQuality?.penalty || 0, 4),
        reasons: strategyQuality?.reasons || [],
        observedAt: strategyQuality?.observedAt || null,
        shadowOnly: true,
        liveMutation: false,
      },
      liveMutation: false,
    },
  };
}

async function loadLatestCandidateBottleneckMap(rows = []) {
  const symbols = [...new Set((rows || []).map((row) => normalizeLunaPhase2Symbol(row.symbol)).filter(Boolean))];
  const markets = [...new Set((rows || []).map((row) => normalizeLunaPhase2Market(row.market)).filter(Boolean))];
  if (symbols.length === 0 || markets.length === 0) return new Map();
  const table = await get(`SELECT to_regclass('investment.luna_candidate_bottleneck_shadow') AS table_name`).catch(() => null);
  if (!table?.table_name) return new Map();
  const bottlenecks = await query(`
    SELECT DISTINCT ON (symbol, market)
           symbol, market, severity, recommended_action, candidate_selection_penalty,
           reasons, evidence, observed_at
      FROM investment.luna_candidate_bottleneck_shadow
     WHERE symbol = ANY($1::text[])
       AND market = ANY($2::text[])
       AND observed_at >= NOW() - INTERVAL '24 hours'
       AND shadow_only IS TRUE
     ORDER BY symbol, market, observed_at DESC
  `, [symbols, markets]).catch(() => []);
  return new Map((bottlenecks || []).map((row) => [`${normalizeLunaPhase2Symbol(row.symbol)}|${normalizeLunaPhase2Market(row.market)}`, row]));
}

async function loadLatestStrategyQualityMap(rows = []) {
  const symbols = [...new Set((rows || []).map((row) => normalizeLunaPhase2Symbol(row.symbol)).filter(Boolean))];
  const markets = [...new Set((rows || []).map((row) => normalizeLunaPhase2Market(row.market)).filter(Boolean))];
  if (symbols.length === 0 || markets.length === 0) return new Map();
  const table = await get(`SELECT to_regclass('investment.luna_phase4_strategy_enhancement_shadow') AS table_name`).catch(() => null);
  if (!table?.table_name) return new Map();
  const strategyRows = await query(`
    SELECT DISTINCT ON (symbol, market)
           id, symbol, market, exchange, enhancement_status, hyperopt_status, best_params,
           max_drawdown_guard, indicator_score, provider_status, reasons, evidence, observed_at
      FROM investment.luna_phase4_strategy_enhancement_shadow
     WHERE symbol = ANY($1::text[])
       AND market = ANY($2::text[])
       AND observed_at >= NOW() - INTERVAL '24 hours'
       AND shadow_only IS TRUE
     ORDER BY symbol, market, observed_at DESC, id DESC
  `, [symbols, markets]).catch(() => []);
  return new Map((strategyRows || []).map((row) => [`${normalizeLunaPhase2Symbol(row.symbol)}|${normalizeLunaPhase2Market(row.market)}`, row]));
}

export async function loadLunaPhase2CandidateInputs({ limit = 50, market = null, symbols = [] } = {}) {
  const params = [];
  const requestedMarket = String(market || '').trim().toLowerCase();
  const normalizedMarket = requestedMarket && requestedMarket !== 'all'
    ? normalizeLunaPhase2Market(requestedMarket)
    : null;
  const requestedSymbols = normalizeLunaPhase2Symbols(symbols);
  const marketWhere = normalizedMarket ? `AND market = $${params.push(normalizedMarket)}` : '';
  const symbolWhere = requestedSymbols.length ? `AND symbol = ANY($${params.push(requestedSymbols)}::text[])` : '';
  const perMarketLimit = Math.max(1, Math.ceil(Number(limit || 50) / 3));
  const marketRankWhere = normalizedMarket || requestedSymbols.length
    ? ''
    : `WHERE market_rank <= $${params.push(perMarketLimit)}`;
  params.push(limit);
  const rows = await query(`
    WITH symbol_community AS (
      SELECT symbol, market,
             (SUM(score * GREATEST(0.05, COALESCE(source_quality, 0.5)) * GREATEST(0.2, COALESCE(freshness_score, 1.0)))
              / NULLIF(SUM(GREATEST(0.05, COALESCE(source_quality, 0.5)) * GREATEST(0.2, COALESCE(freshness_score, 1.0))), 0))::double precision AS avg_score,
             COUNT(DISTINCT source_name)::int AS source_count,
             AVG(source_quality)::double precision AS avg_source_quality,
             MAX(created_at) AS last_seen_at,
             MAX(CASE WHEN COALESCE((raw_ref->'botNoise'->>'score')::double precision, 0) > 0.5 THEN 1 ELSE 0 END)::int AS bot_noise_flag,
             MAX(CASE WHEN COALESCE((raw_ref->'hypeSpike'->>'detected')::boolean, false) THEN 1 ELSE 0 END)::int AS hype_spike_flag
       FROM external_evidence_events
       WHERE source_type = 'community'
         AND created_at >= NOW() - INTERVAL '24 hours'
         AND symbol IS NOT NULL
         AND source_name <> 'community_candidate_gap'
         AND COALESCE((raw_ref->>'missing_data')::boolean, false) = false
       GROUP BY symbol, market
    ),
    market_community AS (
      SELECT market,
             (SUM(score * GREATEST(0.05, COALESCE(source_quality, 0.5)) * GREATEST(0.2, COALESCE(freshness_score, 1.0)))
              / NULLIF(SUM(GREATEST(0.05, COALESCE(source_quality, 0.5)) * GREATEST(0.2, COALESCE(freshness_score, 1.0))), 0))::double precision AS market_avg_score,
             COUNT(DISTINCT source_name)::int AS market_source_count,
             AVG(source_quality)::double precision AS market_avg_quality,
             MAX(created_at) AS market_last_seen_at
       FROM external_evidence_events
       WHERE source_type = 'community'
         AND created_at >= NOW() - INTERVAL '24 hours'
         AND symbol IS NULL
         AND source_name <> 'community_candidate_gap'
         AND COALESCE((raw_ref->>'missing_data')::boolean, false) = false
       GROUP BY market
    ),
    latest_predictive AS (
      SELECT DISTINCT ON (symbol, market)
             symbol, market, decision, score, threshold, component_coverage, created_at
        FROM predictive_validation_log
       WHERE created_at >= NOW() - INTERVAL '7 days'
       ORDER BY symbol, market, created_at DESC
    ),
    active_candidates AS (
      SELECT DISTINCT ON (symbol, market)
             symbol, market, score, source, discovered_at, expires_at, reason, raw_data
       FROM candidate_universe
       WHERE expires_at > NOW()
         ${marketWhere}
         ${symbolWhere}
       ORDER BY symbol, market, score DESC, discovered_at DESC
    ),
    balanced_candidates AS (
      SELECT *,
             ROW_NUMBER() OVER (PARTITION BY market ORDER BY score DESC, discovered_at DESC) AS market_rank
        FROM active_candidates
    ),
    selected_candidates AS (
      SELECT *
        FROM balanced_candidates
        ${marketRankWhere}
    )
    SELECT cu.symbol, cu.market, cu.score::double precision AS candidate_score, cu.source,
           cu.discovered_at, cu.expires_at, cu.reason, cu.raw_data,
           cbs.fresh, cbs.healthy, cbs.sharpe, cbs.max_drawdown, cbs.win_rate,
           cbs.last_backtest_at, cbs.gate_status, cbs.would_block, cbs.block_reasons,
           lp.decision AS predictive_decision, lp.score AS predictive_score,
           lp.threshold AS predictive_threshold, lp.component_coverage, lp.created_at AS predictive_created_at,
           symbol_community.avg_score AS community_avg_score,
           symbol_community.source_count AS community_source_count,
           symbol_community.avg_source_quality AS community_avg_source_quality,
           symbol_community.last_seen_at AS community_last_seen_at,
           symbol_community.bot_noise_flag AS community_bot_noise_flag,
           symbol_community.hype_spike_flag AS community_hype_spike_flag,
           market_community.market_avg_score AS community_market_avg_score,
           market_community.market_source_count AS community_market_source_count,
           market_community.market_avg_quality AS community_market_avg_quality,
           market_community.market_last_seen_at AS community_market_last_seen_at
      FROM selected_candidates cu
      LEFT JOIN candidate_backtest_status cbs
        ON cbs.symbol = cu.symbol AND cbs.market = cu.market
      LEFT JOIN latest_predictive lp
        ON lp.symbol = cu.symbol AND lp.market = cu.market
      LEFT JOIN symbol_community
        ON symbol_community.symbol = cu.symbol AND symbol_community.market = cu.market
      LEFT JOIN market_community
        ON market_community.market = cu.market
     ORDER BY cu.score DESC, cu.discovered_at DESC
     LIMIT $${params.length}
  `, params).catch(() => []);

  const bottleneckMap = await loadLatestCandidateBottleneckMap(rows);
  const strategyQualityMap = await loadLatestStrategyQualityMap(rows);

  return rows.map((row) => ({
    candidate: {
      symbol: row.symbol,
      market: row.market,
      score: row.candidate_score,
      source: row.source,
      discovered_at: row.discovered_at,
      expires_at: row.expires_at,
      reason: row.reason,
      raw_data: parseJsonMaybe(row.raw_data, {}),
    },
    backtest: {
      fresh: row.fresh,
      healthy: row.healthy,
      sharpe: row.sharpe,
      max_drawdown: row.max_drawdown,
      win_rate: row.win_rate,
      last_backtest_at: row.last_backtest_at,
      gate_status: row.gate_status,
      would_block: row.would_block,
      block_reasons: parseJsonMaybe(row.block_reasons, []),
    },
    predictive: {
      decision: row.predictive_decision,
      score: row.predictive_score,
      threshold: row.predictive_threshold,
      component_coverage: row.component_coverage,
      created_at: row.predictive_created_at,
    },
    community: {
      avg_score: row.community_avg_score,
      source_count: row.community_source_count,
      avg_source_quality: row.community_avg_source_quality,
      last_seen_at: row.community_last_seen_at,
      market_avg_score: row.community_market_avg_score,
      market_source_count: row.community_market_source_count,
      market_avg_quality: row.community_market_avg_quality,
      market_last_seen_at: row.community_market_last_seen_at,
      bot_noise_score: row.community_bot_noise_flag ? 0.6 : 0,
      hype_spike: row.community_hype_spike_flag === 1,
    },
    bottleneck: bottleneckMap.get(`${normalizeLunaPhase2Symbol(row.symbol)}|${normalizeLunaPhase2Market(row.market)}`) || null,
    strategyQuality: strategyQualityMap.get(`${normalizeLunaPhase2Symbol(row.symbol)}|${normalizeLunaPhase2Market(row.market)}`) || null,
  }));
}

export async function insertLunaWeightVectorShadow(row = {}) {
  await run(`
    INSERT INTO luna_weight_vector_shadow
      (symbol, market, exchange, candidate_score, backtest_score, predictive_score,
       community_score, target_weight, confidence, risk_budget_usdt, signal,
       gate_status, no_lookahead_ok, shadow_only, evidence)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$14::jsonb)
  `, [
    row.symbol,
    row.market,
    row.exchange,
    row.candidateScore,
    row.backtestScore,
    row.predictiveScore,
    row.communityScore,
    row.targetWeight,
    row.confidence,
    row.riskBudgetUsdt,
    row.signal,
    row.gateStatus,
    row.noLookaheadOk,
    JSON.stringify(row.evidence || {}),
  ]);
}

export async function loadLatestLunaWeightVectors({ limit = 50, hours = 24, market = null, symbols = [] } = {}) {
  const requestedMarket = String(market || '').trim().toLowerCase();
  const normalizedMarket = requestedMarket && requestedMarket !== 'all'
    ? normalizeLunaPhase2Market(requestedMarket)
    : null;
  const requestedSymbols = normalizeLunaPhase2Symbols(symbols);
  const params = [Number(hours)];
  const marketWhere = normalizedMarket ? `AND market = $${params.push(normalizedMarket)}` : '';
  const symbolWhere = requestedSymbols.length ? `AND symbol = ANY($${params.push(requestedSymbols)}::text[])` : '';
  const perMarketLimit = Math.max(1, Math.ceil(Number(limit || 50) / 3));
  const marketRankWhere = normalizedMarket || requestedSymbols.length
    ? ''
    : `WHERE market_rank <= $${params.push(perMarketLimit)}`;
  params.push(Number(limit));
  return query(`
    WITH latest_weights AS (
      SELECT DISTINCT ON (symbol, market)
             symbol, market, exchange, target_weight, confidence, signal, shadow_only, evidence, observed_at
        FROM luna_weight_vector_shadow
       WHERE observed_at >= NOW() - ($1::int * INTERVAL '1 hour')
         AND shadow_only = true
         ${marketWhere}
         ${symbolWhere}
       ORDER BY symbol, market, observed_at DESC
    ),
    balanced_weights AS (
      SELECT *,
             ROW_NUMBER() OVER (PARTITION BY market ORDER BY observed_at DESC, confidence DESC) AS market_rank
        FROM latest_weights
    ),
    selected_weights AS (
      SELECT *
        FROM balanced_weights
        ${marketRankWhere}
    )
    SELECT symbol, market, exchange, target_weight, confidence, signal, shadow_only, evidence, observed_at
      FROM selected_weights
     ORDER BY observed_at DESC, confidence DESC
     LIMIT $${params.length}
  `, params).catch(() => []);
}

export async function loadCurrentPositionForWeightVector(row = {}) {
  const symbol = normalizeLunaPhase2Symbol(row.symbol);
  const exchange = row.exchange || exchangeForLunaPhase2Market(row.market);
  return get(
    `SELECT symbol, amount, avg_price, unrealized_pnl, paper, exchange, trade_mode, updated_at
       FROM positions
      WHERE symbol = $1 AND exchange = $2 AND paper = false
      ORDER BY updated_at DESC
      LIMIT 1`,
    [symbol, exchange],
  ).catch(() => null);
}

export async function insertLunaPaperTradingShadow(row = {}) {
  await run(`
    INSERT INTO luna_paper_trading_shadow
      (symbol, market, exchange, target_weight, current_weight, delta_weight,
       paper_side, paper_notional_usdt, paper_quantity, reference_price,
       confidence, status, shadow_only, evidence)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13::jsonb)
  `, [
    row.symbol,
    row.market,
    row.exchange,
    row.targetWeight,
    row.currentWeight,
    row.deltaWeight,
    row.paperSide,
    row.paperNotionalUsdt,
    row.paperQuantity,
    row.referencePrice,
    row.confidence,
    row.status,
    JSON.stringify(row.evidence || {}),
  ]);
}
