// @ts-nocheck

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeString(value, fallback = null) {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function cloneObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value }
    : { ...fallback };
}

export function getPositionRuntimeMarket(exchange = 'binance') {
  if (exchange === 'binance') return 'crypto';
  if (exchange === 'kis') return 'domestic';
  if (exchange === 'kis_overseas') return 'overseas';
  return 'unknown';
}

export function getPositionRuntimeRegime(regimeSnapshot = null, exchange = 'binance') {
  const market = getPositionRuntimeMarket(exchange);
  const regime = normalizeString(regimeSnapshot?.regime, market === 'crypto' ? 'volatile' : 'ranging');
  const confidence = safeNumber(regimeSnapshot?.confidence, 0.5);
  const capturedAt = regimeSnapshot?.captured_at || regimeSnapshot?.capturedAt || null;
  return {
    market,
    regime,
    confidence,
    capturedAt,
    indicators: regimeSnapshot?.indicators || {},
  };
}

export function buildRegimeAwareMonitoringPolicy({
  exchange = 'binance',
  recommendation = 'HOLD',
  reasonCode = null,
  attentionType = null,
  regime = null,
  setupType = null,
} = {}) {
  const market = getPositionRuntimeMarket(exchange);
  const normalizedRegime = normalizeString(regime?.regime, market === 'crypto' ? 'volatile' : 'ranging');
  const normalizedSetupType = normalizeString(setupType, 'unknown');
  const normalizedRecommendation = normalizeString(recommendation, 'HOLD');
  const normalizedAttentionType = normalizeString(attentionType, null);

  let cadenceMs = market === 'crypto' ? 15_000 : 15_000;
  let lane = market === 'crypto' ? 'crypto_realtime' : 'stock_realtime';
  let reevaluationWindowMinutes = market === 'crypto' ? 45 : 120;
  let backgroundBacktestWindowDays = market === 'crypto' ? 21 : 120;
  let profile = 'balanced_monitor';

  if (normalizedRegime === 'trending_bear' || normalizedRecommendation === 'EXIT') {
    cadenceMs = market === 'crypto' ? 10_000 : 12_000;
    reevaluationWindowMinutes = market === 'crypto' ? 20 : 45;
    backgroundBacktestWindowDays = market === 'crypto' ? 30 : 180;
    profile = 'defensive_watch';
  } else if (normalizedRegime === 'trending_bull') {
    cadenceMs = market === 'crypto' ? 15_000 : 20_000;
    reevaluationWindowMinutes = market === 'crypto' ? 30 : 60;
    backgroundBacktestWindowDays = market === 'crypto' ? 21 : 120;
    profile = 'trend_follow_watch';
  } else if (normalizedRegime === 'volatile') {
    cadenceMs = market === 'crypto' ? 12_000 : 15_000;
    reevaluationWindowMinutes = market === 'crypto' ? 25 : 45;
    backgroundBacktestWindowDays = market === 'crypto' ? 28 : 150;
    profile = 'volatility_watch';
  }

  if (normalizedAttentionType === 'tv_bar_stale') {
    cadenceMs = Math.max(cadenceMs, market === 'crypto' ? 30_000 : 60_000);
    lane = 'stale_recovery';
  } else if (normalizedAttentionType || normalizedRecommendation !== 'HOLD') {
    cadenceMs = Math.min(cadenceMs, market === 'crypto' ? 10_000 : 12_000);
    lane = 'attention_fast_lane';
  }

  if (normalizedSetupType === 'mean_reversion') {
    reevaluationWindowMinutes = Math.min(reevaluationWindowMinutes, market === 'crypto' ? 20 : 45);
  } else if (normalizedSetupType === 'trend_following' || normalizedSetupType === 'momentum_rotation') {
    reevaluationWindowMinutes = Math.max(reevaluationWindowMinutes, market === 'crypto' ? 30 : 90);
  }

  return {
    lane,
    profile,
    cadenceMs,
    reevaluationWindowMinutes,
    backgroundBacktestWindowDays,
    recommendedEventSource: normalizedAttentionType ? 'position_watch' : 'runtime_loop',
    reasonCode: normalizeString(reasonCode, null),
  };
}

export function buildRegimeAwarePolicyMatrix({
  exchange = 'binance',
  strategyProfile = null,
  pnlPct = 0,
  recommendation = 'HOLD',
  regime = null,
  analysisSummary = null,
  driftContext = null,
} = {}) {
  const market = getPositionRuntimeMarket(exchange);
  const setupType = normalizeString(strategyProfile?.setup_type || strategyProfile?.setupType, 'unknown');
  const normalizedRegime = normalizeString(regime?.regime, market === 'crypto' ? 'volatile' : 'ranging');
  const sellCount = safeNumber(analysisSummary?.sell, 0);
  const buyCount = safeNumber(analysisSummary?.buy, 0);
  const weightedBias = safeNumber(analysisSummary?.liveIndicator?.weightedBias, 0);

  let stopLossPct = market === 'crypto' ? 0.05 : 0.04;
  let profitLockPct = market === 'crypto' ? 0.10 : 0.08;
  let partialAdjustBias = 1.0;
  let riskGate = normalizedRegime === 'trending_bear' ? 'strict_risk_gate' : 'execution_safeguard';
  let policyMode = normalizedRegime === 'trending_bear' ? 'defensive' : normalizedRegime === 'trending_bull' ? 'aggressive' : 'balanced';

  if (setupType === 'mean_reversion') {
    stopLossPct *= 0.9;
    profitLockPct *= 0.75;
    partialAdjustBias = 1.2;
    policyMode = 'mean_reversion_control';
  } else if (setupType === 'trend_following' || setupType === 'momentum_rotation') {
    stopLossPct *= 1.1;
    profitLockPct *= 1.25;
    partialAdjustBias = 0.85;
    policyMode = 'trend_follow_control';
  } else if (setupType === 'breakout') {
    stopLossPct *= 1.0;
    profitLockPct *= 1.05;
    partialAdjustBias = 0.95;
    policyMode = 'breakout_control';
  }

  if (normalizedRegime === 'trending_bear') {
    stopLossPct *= 0.8;
    profitLockPct *= 0.8;
    partialAdjustBias += 0.15;
  } else if (normalizedRegime === 'trending_bull') {
    stopLossPct *= 1.05;
    profitLockPct *= 1.15;
    partialAdjustBias -= 0.05;
  } else if (normalizedRegime === 'volatile') {
    stopLossPct *= 0.85;
    partialAdjustBias += 0.1;
  }

  if (safeNumber(driftContext?.sharpeDrop, 0) > 0 || safeNumber(driftContext?.returnDropPct, 0) > 0) {
    partialAdjustBias += 0.1;
  }

  const reevaluationBias = {
    weightedBias,
    sellPressure: sellCount - buyCount,
    pnlPct: safeNumber(pnlPct),
    recommendation,
  };

  return {
    market,
    setupType,
    regime: normalizedRegime,
    policyMode,
    riskGate,
    stopLossPct: Number(stopLossPct.toFixed(4)),
    profitLockPct: Number(profitLockPct.toFixed(4)),
    partialAdjustBias: Number(partialAdjustBias.toFixed(4)),
    reevaluationBias,
  };
}

export function buildOnlineValidationState({
  latestBacktest = null,
  driftContext = null,
  monitoringPolicy = null,
  recommendation = 'HOLD',
} = {}) {
  const totalTrades = Number.isFinite(Number(driftContext?.totalTrades))
    ? Number(driftContext?.totalTrades)
    : safeNumber(latestBacktest?.total_trades, 0);
  const sharpeDrop = safeNumber(driftContext?.sharpeDrop, 0);
  const returnDropPct = safeNumber(driftContext?.returnDropPct, 0);
  let severity = 'stable';
  let confidenceDecay = 0;

  if (recommendation === 'EXIT' || sharpeDrop >= 1.5 || returnDropPct >= 10) {
    severity = 'critical';
    confidenceDecay = 0.35;
  } else if (recommendation === 'ADJUST' || sharpeDrop >= 0.75 || returnDropPct >= 5) {
    severity = 'warning';
    confidenceDecay = 0.18;
  }

  return {
    enabled: true,
    severity,
    confidenceDecay,
    totalTrades,
    sharpeDrop: Number(sharpeDrop.toFixed(4)),
    returnDropPct: Number(returnDropPct.toFixed(4)),
    lastBacktestAt: latestBacktest?.created_at || latestBacktest?.createdAt || null,
    nextBacktestWindowDays: Number(monitoringPolicy?.backgroundBacktestWindowDays || 30),
  };
}

export function buildExecutionIntent({
  position = null,
  strategyProfile = null,
  recommendation = 'HOLD',
  reasonCode = null,
  reason = null,
  analysisSummary = null,
  monitoringPolicy = null,
  policyMatrix = null,
  validationState = null,
  trigger = null,
} = {}) {
  const exchange = normalizeString(position?.exchange, null);
  const tradeMode = normalizeString(position?.trade_mode || position?.tradeMode, 'normal');
  const symbol = normalizeString(position?.symbol, null);
  const responsibilityPlan = cloneObject(
    strategyProfile?.strategy_context?.responsibilityPlan
    || strategyProfile?.strategyContext?.responsibilityPlan
    || strategyProfile?.responsibilityPlan,
  );
  const exitPlan = cloneObject(strategyProfile?.exit_plan || strategyProfile?.exitPlan);
  const setupType = normalizeString(strategyProfile?.setup_type || strategyProfile?.setupType, 'unknown');
  const urgency = recommendation === 'EXIT'
    ? 'high'
    : recommendation === 'ADJUST'
      ? 'normal'
      : 'low';
  const riskGate = normalizeString(responsibilityPlan?.riskMission, policyMatrix?.riskGate || 'execution_safeguard');

  let runner = null;
  let command = null;
  let action = 'HOLD';
  let executionAllowed = false;

  if (recommendation === 'EXIT' && symbol && exchange) {
    action = 'EXIT';
    runner = 'runtime:strategy-exit';
    command = `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:strategy-exit -- --symbol=${symbol} --exchange=${exchange} --trade-mode=${tradeMode} --json`;
    executionAllowed = true;
  } else if (recommendation === 'ADJUST' && symbol && exchange) {
    action = 'ADJUST';
    runner = 'runtime:partial-adjust';
    command = `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:partial-adjust -- --symbol=${symbol} --exchange=${exchange} --trade-mode=${tradeMode} --json`;
    executionAllowed = true;
  } else if (symbol && exchange) {
    command = `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-reeval-event -- --symbol=${symbol} --exchange=${exchange} --trade-mode=${tradeMode} --event-source=${normalizeString(trigger?.source, 'runtime_loop')} --json`;
  }

  return {
    action,
    reasonCode: normalizeString(reasonCode, null),
    reason: normalizeString(reason, null),
    runner,
    command,
    urgency,
    riskGate,
    executionAllowed,
    setupType,
    exitGuard: normalizeString(exitPlan?.primaryExit, null),
    weightedBias: safeNumber(analysisSummary?.liveIndicator?.weightedBias, 0),
    validationSeverity: normalizeString(validationState?.severity, 'stable'),
  };
}

export function buildPositionRuntimeState({
  position = null,
  strategyProfile = null,
  analysisSummary = null,
  latestBacktest = null,
  driftContext = null,
  recommendation = 'HOLD',
  reasonCode = null,
  reason = null,
  regimeSnapshot = null,
  trigger = null,
  previousState = null,
} = {}) {
  const exchange = normalizeString(position?.exchange, null);
  const marketRegime = getPositionRuntimeRegime(regimeSnapshot, exchange);
  const setupType = normalizeString(strategyProfile?.setup_type || strategyProfile?.setupType, 'unknown');
  const monitoringPolicy = buildRegimeAwareMonitoringPolicy({
    exchange,
    recommendation,
    reasonCode,
    attentionType: trigger?.attentionType,
    regime: marketRegime,
    setupType,
  });
  const policyMatrix = buildRegimeAwarePolicyMatrix({
    exchange,
    strategyProfile,
    pnlPct: position?.pnlPct ?? position?.latestPnlPct ?? 0,
    recommendation,
    regime: marketRegime,
    analysisSummary,
    driftContext,
  });
  const validationState = buildOnlineValidationState({
    latestBacktest,
    driftContext,
    monitoringPolicy,
    recommendation,
  });
  const executionIntent = buildExecutionIntent({
    position,
    strategyProfile,
    recommendation,
    reasonCode,
    reason,
    analysisSummary,
    monitoringPolicy,
    policyMatrix,
    validationState,
    trigger,
  });

  const previous = cloneObject(previousState);
  const version = safeNumber(previous?.version, 0) + 1;
  return {
    version,
    updatedAt: new Date().toISOString(),
    updatedBy: normalizeString(trigger?.source, 'position_reevaluator'),
    exchange,
    symbol: normalizeString(position?.symbol, null),
    tradeMode: normalizeString(position?.trade_mode || position?.tradeMode, 'normal'),
    recommendation,
    reasonCode: normalizeString(reasonCode, null),
    reason: normalizeString(reason, null),
    trigger: {
      source: normalizeString(trigger?.source, 'position_reevaluator'),
      attentionType: normalizeString(trigger?.attentionType, null),
      attentionReason: normalizeString(trigger?.attentionReason, null),
      payload: trigger?.payload || null,
    },
    regime: marketRegime,
    monitoringPolicy,
    policyMatrix,
    validationState,
    executionIntent,
    marketState: {
      latestPnlPct: safeNumber(position?.pnlPct ?? position?.latestPnlPct, 0),
      amount: safeNumber(position?.amount, 0),
      avgPrice: safeNumber(position?.avg_price ?? position?.avgPrice, 0),
      unrealizedPnl: safeNumber(position?.unrealized_pnl ?? position?.unrealizedPnl, 0),
      liveIndicator: analysisSummary?.liveIndicator || null,
      analysisCounts: {
        buy: safeNumber(analysisSummary?.buy, 0),
        hold: safeNumber(analysisSummary?.hold, 0),
        sell: safeNumber(analysisSummary?.sell, 0),
        avgConfidence: safeNumber(analysisSummary?.avgConfidence, 0),
      },
    },
    previousRecommendation: normalizeString(previous?.recommendation, null),
    previousReasonCode: normalizeString(previous?.reasonCode, null),
    previousExecutionIntent: previous?.executionIntent || null,
  };
}
