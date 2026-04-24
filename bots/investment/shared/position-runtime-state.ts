// @ts-nocheck

import { computeRegimePolicy } from './regime-strategy-policy.ts';

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeString(value, fallback = null) {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function clamp01(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1, Math.max(0, parsed));
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

function getPolicyMarket(exchange = 'binance') {
  return exchange === 'binance' ? 'crypto' : 'stock';
}

function resolveFamilyBias(strategyProfile = null) {
  const context = strategyProfile?.strategy_context || strategyProfile?.strategyContext || {};
  const feedback = context.familyPerformanceFeedback
    || strategyProfile?.familyPerformanceFeedback
    || strategyProfile?.strategy_state?.familyPerformanceFeedback
    || {};
  return normalizeString(feedback?.bias, null);
}

function resolveInternalSourceQualityScore(analysisSummary = null) {
  const live = analysisSummary?.liveIndicator || {};
  const qualityScore = nullableNumber(
    live?.quality?.score
    ?? live?.qualityScore
    ?? live?.avgConfidence
    ?? live?.confidence
    ?? analysisSummary?.avgConfidence,
    null,
  );
  if (qualityScore != null) return clamp01(qualityScore, 0.5);
  return null;
}

function resolveSourceQualityScore(analysisSummary = null, externalEvidenceSummary = null) {
  const internalQuality = resolveInternalSourceQualityScore(analysisSummary);
  const externalEvidenceCount = Number(externalEvidenceSummary?.evidenceCount || 0);
  const externalQuality = nullableNumber(externalEvidenceSummary?.avgQuality, null);
  const externalFreshness = nullableNumber(externalEvidenceSummary?.avgFreshness, null);

  if (externalEvidenceCount > 0 && externalQuality != null) {
    const freshnessMultiplier = externalFreshness != null
      ? 0.75 + (clamp01(externalFreshness, 0) * 0.25)
      : 1;
    const adjustedExternal = clamp01(externalQuality * freshnessMultiplier, 1);
    if (internalQuality != null) {
      const externalWeight = Math.min(0.75, 0.35 + (Math.min(externalEvidenceCount, 6) * 0.07));
      return clamp01((adjustedExternal * externalWeight) + (internalQuality * (1 - externalWeight)), 1);
    }
    return adjustedExternal;
  }

  if (internalQuality != null) {
    // 외부 에비던스 부재는 "품질 미확정"으로 취급한다.
    // 즉시 실행 차단 대신 내부 신호 품질 기반 감쇠 점수를 사용한다.
    return clamp01(Math.min(Math.max(internalQuality * 0.9, 0.45), 0.75), 0.5);
  }
  return 0.5;
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
  strategyProfile = null,
  analysisSummary = null,
  driftContext = null,
  externalEvidenceSummary = null,
} = {}) {
  const market = getPositionRuntimeMarket(exchange);
  const normalizedRegime = normalizeString(regime?.regime, market === 'crypto' ? 'volatile' : 'ranging');
  const normalizedSetupType = normalizeString(setupType, 'unknown');
  const normalizedRecommendation = normalizeString(recommendation, 'HOLD');
  const normalizedAttentionType = normalizeString(attentionType, null);
  const sourceQualityScore = resolveSourceQualityScore(analysisSummary, externalEvidenceSummary);
  const policy = computeRegimePolicy({
    exchange,
    market: getPolicyMarket(exchange),
    regime: normalizedRegime,
    setupType: normalizedSetupType,
    familyBias: resolveFamilyBias(strategyProfile),
    sharpeDrop: safeNumber(driftContext?.sharpeDrop, 0),
    returnDropPct: safeNumber(driftContext?.returnDropPct, 0),
    sourceQualityScore,
    recommendation: normalizedRecommendation,
    attentionType: normalizedAttentionType,
  });

  return {
    lane: policy.lane,
    profile: policy.monitorProfile,
    cadenceMs: policy.cadenceMs,
    reevaluationWindowMinutes: policy.reevaluationWindowMinutes,
    backgroundBacktestWindowDays: policy.backgroundBacktestWindowDays,
    recommendedEventSource: normalizedAttentionType ? 'position_watch' : 'runtime_loop',
    reasonCode: normalizeString(reasonCode, null),
    sourceQualityScore: Number(sourceQualityScore.toFixed(4)),
    sourceQualityBlocked: policy.sourceQualityBlocked === true,
    sourceQualityReason: policy.sourceQualityReason || null,
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
  externalEvidenceSummary = null,
} = {}) {
  const market = getPositionRuntimeMarket(exchange);
  const setupType = normalizeString(strategyProfile?.setup_type || strategyProfile?.setupType, 'unknown');
  const normalizedRegime = normalizeString(regime?.regime, market === 'crypto' ? 'volatile' : 'ranging');
  const sellCount = safeNumber(analysisSummary?.sell, 0);
  const buyCount = safeNumber(analysisSummary?.buy, 0);
  const weightedBias = safeNumber(analysisSummary?.liveIndicator?.weightedBias, 0);
  const familyBias = resolveFamilyBias(strategyProfile);
  const sourceQualityScore = resolveSourceQualityScore(analysisSummary, externalEvidenceSummary);
  const closeoutAvgPnlPercent = nullableNumber(strategyProfile?.strategy_state?.phase6Closeout?.avgPnlPercent, null);
  const closeoutWinRate = nullableNumber(strategyProfile?.strategy_state?.phase6Closeout?.winRate, null);
  const policy = computeRegimePolicy({
    exchange,
    market: getPolicyMarket(exchange),
    regime: normalizedRegime,
    setupType,
    familyBias,
    sharpeDrop: safeNumber(driftContext?.sharpeDrop, 0),
    returnDropPct: safeNumber(driftContext?.returnDropPct, 0),
    closeoutAvgPnlPercent,
    closeoutWinRate,
    sourceQualityScore,
    recommendation,
  });

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
    policyMode: policy.policyMode,
    riskGate: policy.riskGate,
    stopLossPct: policy.stopLossPct,
    profitLockPct: policy.profitLockPct,
    partialAdjustBias: policy.partialExitRatioBias,
    partialExitRatioBias: policy.partialExitRatioBias,
    cooldownMinutes: policy.cooldownMinutes,
    positionSizeMultiplier: policy.positionSizeMultiplier,
    reentryLock: policy.reentryLock === true,
    sourceQualityBlocked: policy.sourceQualityBlocked === true,
    sourceQualityReason: policy.sourceQualityReason || null,
    monitorProfile: policy.monitorProfile,
    lane: policy.lane,
    cadenceMs: policy.cadenceMs,
    reevaluationWindowMinutes: policy.reevaluationWindowMinutes,
    backgroundBacktestWindowDays: policy.backgroundBacktestWindowDays,
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
  const isHardExit = recommendation === 'EXIT' && String(reasonCode || '') === 'stop_loss_threshold';
  const triggerSource = normalizeString(trigger?.source, 'runtime_loop');

  let runner = null;
  let command = null;
  let previewCommand = null;
  let manualExecuteCommand = null;
  let autonomousExecuteCommand = null;
  let runnerArgs = null;
  let executionPolicy = {
    autonomy: 'manual_only',
    needsUserApproval: false,
    requiresMarketOpen: false,
    postActionAlertOnly: true,
  };
  let action = 'HOLD';
  let executionAllowed = false;
  const guardReasons = [];

  if (recommendation === 'EXIT' && symbol && exchange) {
    action = 'EXIT';
    runner = 'runtime:strategy-exit';
    previewCommand = `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:strategy-exit -- --symbol=${symbol} --exchange=${exchange} --trade-mode=${tradeMode} --json`;
    manualExecuteCommand = `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:strategy-exit -- --symbol=${symbol} --exchange=${exchange} --trade-mode=${tradeMode} --execute --confirm=strategy-exit --json`;
    autonomousExecuteCommand = `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:strategy-exit -- --symbol=${symbol} --exchange=${exchange} --trade-mode=${tradeMode} --execute --confirm=position-runtime-autopilot --run-context=position-runtime-autopilot --json`;
    runnerArgs = {
      symbol,
      exchange,
      'trade-mode': tradeMode,
      execute: true,
      confirm: 'position-runtime-autopilot',
      'run-context': 'position-runtime-autopilot',
      json: true,
    };
    executionPolicy = {
      autonomy: isHardExit ? 'hard_exit_required' : 'autonomous_allowed',
      needsUserApproval: false,
      requiresMarketOpen: exchange !== 'binance',
      postActionAlertOnly: true,
    };
    command = previewCommand;
    executionAllowed = true;
  } else if (recommendation === 'ADJUST' && symbol && exchange) {
    action = 'ADJUST';
    runner = 'runtime:partial-adjust';
    previewCommand = `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:partial-adjust -- --symbol=${symbol} --exchange=${exchange} --trade-mode=${tradeMode} --json`;
    manualExecuteCommand = `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:partial-adjust -- --symbol=${symbol} --exchange=${exchange} --trade-mode=${tradeMode} --execute --confirm=partial-adjust --json`;
    autonomousExecuteCommand = `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:partial-adjust -- --symbol=${symbol} --exchange=${exchange} --trade-mode=${tradeMode} --execute --confirm=position-runtime-autopilot --run-context=position-runtime-autopilot --json`;
    runnerArgs = {
      symbol,
      exchange,
      'trade-mode': tradeMode,
      execute: true,
      confirm: 'position-runtime-autopilot',
      'run-context': 'position-runtime-autopilot',
      json: true,
    };
    executionPolicy = {
      autonomy: 'autonomous_allowed',
      needsUserApproval: false,
      requiresMarketOpen: exchange !== 'binance',
      postActionAlertOnly: true,
    };
    command = previewCommand;
    executionAllowed = true;
  } else if (symbol && exchange) {
    command = `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-reeval-event -- --symbol=${symbol} --exchange=${exchange} --trade-mode=${tradeMode} --event-source=${triggerSource} --json`;
  }

  if (executionAllowed) {
    if (policyMatrix?.sourceQualityBlocked === true) {
      guardReasons.push(policyMatrix?.sourceQualityReason || 'source_quality_blocked');
      executionAllowed = false;
    }
    if (normalizeString(validationState?.severity, 'stable') === 'critical' && action === 'ADJUST') {
      guardReasons.push('validation_severity_critical_adjust_blocked');
      executionAllowed = false;
    }
  }

  return {
    action,
    reasonCode: normalizeString(reasonCode, null),
    reason: normalizeString(reason, null),
    runner,
    command,
    previewCommand,
    manualExecuteCommand,
    autonomousExecuteCommand,
    runnerArgs,
    executionPolicy,
    executionScope: symbol && exchange ? `${exchange}:${symbol}:${action}:${tradeMode}` : null,
    brokerScope: symbol && exchange ? `${exchange}:${symbol}` : null,
    urgency,
    riskGate,
    executionAllowed,
    guardReasons,
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
  externalEvidenceSummary = null,
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
    strategyProfile,
    analysisSummary,
    driftContext,
    externalEvidenceSummary,
  });
  const policyMatrix = buildRegimeAwarePolicyMatrix({
    exchange,
    strategyProfile,
    pnlPct: position?.pnlPct ?? position?.latestPnlPct ?? 0,
    recommendation,
    regime: marketRegime,
    analysisSummary,
    driftContext,
    externalEvidenceSummary,
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
      externalEvidenceSummary: externalEvidenceSummary || null,
    },
    previousRecommendation: normalizeString(previous?.recommendation, null),
    previousReasonCode: normalizeString(previous?.reasonCode, null),
    previousExecutionIntent: previous?.executionIntent || null,
  };
}
