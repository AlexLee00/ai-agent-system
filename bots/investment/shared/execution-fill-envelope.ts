// @ts-nocheck

function normalizeSide(side = '') {
  const value = String(side || '').trim().toLowerCase();
  if (value === 'buy' || value === 'long') return 'buy';
  if (value === 'sell' || value === 'exit') return 'sell';
  return value || 'unknown';
}

function normalizeTradeMode(tradeMode = null) {
  return String(tradeMode || 'normal').trim() || 'normal';
}

function safeJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function firstObject(...values) {
  for (const value of values) {
    const parsed = safeJson(value, null);
    if (parsed && typeof parsed === 'object') return parsed;
  }
  return null;
}

function deriveStrategyRoute({ trade = null, signal = null, journal = null, strategyContext = {}, strategyProfile = null } = {}) {
  const route = firstObject(signal?.strategy_route, journal?.strategy_route, strategyContext?.strategyRoute);
  if (route) return route;

  const setupType = strategyProfile?.setup_type || strategyContext?.setupType || null;
  const family = signal?.strategy_family || journal?.strategy_family || strategyContext?.family || setupType || null;
  if (!setupType && !family) {
    const hasExecutionRecoveryContext = Boolean(trade) && !strategyProfile && (signal || journal || trade?.execution_origin || trade?.quality_flag);
    if (!hasExecutionRecoveryContext) return null;
    return {
      source: signal ? 'execution_envelope_signal_without_route_fallback' : 'execution_envelope_unattributed_fallback',
      setupType: 'unattributed_execution_tracking',
      selectedFamily: 'unattributed_execution_tracking',
      executionOrigin: trade?.execution_origin || journal?.execution_origin || 'unattributed',
      qualityFlag: trade?.quality_flag || journal?.quality_flag || 'degraded',
      signalId: signal?.id || trade?.signal_id || journal?.signal_id || null,
    };
  }

  return {
    source: 'execution_envelope_profile_fallback',
    setupType: setupType || family,
    selectedFamily: family || setupType,
  };
}

function buildFallbackResponsibilityPlan({ exchange = 'binance', setupType = null, regime = null } = {}) {
  if (!setupType) return null;
  const normalizedSetupType = String(setupType || '').trim().toLowerCase();
  const bearishRegime = String(regime || '').toLowerCase().includes('bear');
  const equityMarket = exchange !== 'binance';
  let ownerMode = bearishRegime ? 'capital_preservation' : 'balanced_rotation';
  let riskMission = bearishRegime ? 'strict_risk_gate' : 'execution_safeguard';
  let watchMission = bearishRegime ? 'risk_sentinel' : 'strategy_invalidation_watcher';
  let executionMission = 'precision_execution';

  if (equityMarket) {
    ownerMode = 'equity_rotation';
  } else if (normalizedSetupType === 'mean_reversion') {
    ownerMode = bearishRegime ? 'capital_preservation' : 'opportunity_capture';
    riskMission = 'soft_sizing_preference';
    executionMission = 'partial_adjust_executor';
  } else if (normalizedSetupType === 'momentum_rotation' || normalizedSetupType === 'trend_following') {
    watchMission = bearishRegime ? 'risk_sentinel' : 'backtest_drift_watcher';
    riskMission = bearishRegime ? 'strict_risk_gate' : 'soft_sizing_preference';
    executionMission = 'partial_adjust_executor';
  } else if (normalizedSetupType === 'unattributed_execution_tracking') {
    ownerMode = 'reconciliation_tracking';
    riskMission = 'position_truth_guard';
    watchMission = 'execution_linkage_repair';
    executionMission = 'no_new_order_until_attributed';
  }

  return {
    source: 'execution_envelope_route_fallback',
    ownerAgent: 'luna',
    ownerMode,
    strategyScoutAgent: 'argos',
    riskAgent: 'nemesis',
    riskMission,
    executionAgent: 'hephaestos',
    executionMission,
    watchAgent: 'position_watch',
    watchMission,
  };
}

function buildFallbackExecutionPlan({ exchange = 'binance', setupType = null, responsibilityPlan = null, regime = null } = {}) {
  if (!setupType || !responsibilityPlan) return null;
  const normalizedSetupType = String(setupType || '').trim().toLowerCase();
  const bearishRegime = String(regime || '').toLowerCase().includes('bear');
  const riskMission = String(responsibilityPlan?.riskMission || '').trim();
  const watchMission = String(responsibilityPlan?.watchMission || '').trim();
  let entrySizingMultiplier = exchange === 'binance' ? 0.98 : 0.96;
  let partialAdjustBias = 1.0;
  let exitUrgency = bearishRegime ? 'high' : 'normal';
  let backtestUrgency = exchange === 'binance' ? 'normal' : 'watchful';

  if (riskMission === 'strict_risk_gate') entrySizingMultiplier *= 0.92;
  if (riskMission === 'soft_sizing_preference') entrySizingMultiplier *= 0.97;
  if (riskMission === 'position_truth_guard') entrySizingMultiplier = 0;
  if (watchMission === 'backtest_drift_watcher') backtestUrgency = 'high';
  if (watchMission === 'execution_linkage_repair') backtestUrgency = 'audit';
  if (normalizedSetupType === 'mean_reversion') partialAdjustBias *= 1.12;
  if (normalizedSetupType === 'momentum_rotation' || normalizedSetupType === 'trend_following') partialAdjustBias *= 1.04;
  if (normalizedSetupType === 'unattributed_execution_tracking') {
    partialAdjustBias = 0;
    exitUrgency = 'manual_review';
  }
  if (normalizedSetupType === 'breakout' && bearishRegime) exitUrgency = 'high';

  return {
    source: 'execution_envelope_route_fallback',
    entrySizingMultiplier: Number(entrySizingMultiplier.toFixed(4)),
    partialAdjustBias: Number(partialAdjustBias.toFixed(4)),
    backtestUrgency,
    exitUrgency,
  };
}

export function buildExecutionFillEnvelope({
  trade = null,
  signal = null,
  journal = null,
  strategyProfile = null,
  marketRegime = null,
} = {}) {
  const side = normalizeSide(trade?.side || signal?.action || journal?.direction);
  const exchange = String(trade?.exchange || signal?.exchange || journal?.exchange || strategyProfile?.exchange || 'binance').trim();
  const symbol = String(trade?.symbol || signal?.symbol || journal?.symbol || strategyProfile?.symbol || '').trim();
  const tradeMode = normalizeTradeMode(trade?.trade_mode || trade?.tradeMode || signal?.trade_mode || journal?.trade_mode || strategyProfile?.trade_mode);
  const filledQty = Number(trade?.amount ?? journal?.entry_size ?? 0);
  const avgFillPrice = Number(trade?.price ?? journal?.entry_price ?? 0);
  const notional = Number(trade?.total_usdt ?? trade?.totalUsdt ?? journal?.entry_value ?? 0);
  const strategyContext = safeJson(strategyProfile?.strategy_context, {});
  const strategyState = safeJson(strategyProfile?.strategy_state, {});
  const marketContext = safeJson(strategyProfile?.market_context, {});
  const strategyRoute = deriveStrategyRoute({ trade, signal, journal, strategyContext, strategyProfile });
  const setupType = strategyProfile?.setup_type || strategyRoute?.setupType || strategyRoute?.selectedFamily || null;
  const regime = journal?.market_regime || marketRegime?.regime || marketContext?.regime || strategyRoute?.regime || null;
  const responsibilityPlan = strategyContext?.responsibilityPlan
    || buildFallbackResponsibilityPlan({ exchange, setupType, regime });
  const executionPlan = strategyContext?.executionPlan
    || buildFallbackExecutionPlan({ exchange, setupType, responsibilityPlan, regime });

  return {
    schemaVersion: 1,
    fillId: trade?.id || journal?.trade_id || null,
    orderId: trade?.order_id || trade?.orderId || null,
    tradeId: journal?.trade_id || null,
    signalId: trade?.signal_id || trade?.signalId || signal?.id || journal?.signal_id || strategyProfile?.signal_id || null,
    symbol,
    exchange,
    tradeMode,
    side,
    paper: trade?.paper ?? journal?.is_paper ?? null,
    filledQty,
    avgFillPrice,
    notional,
    executedAt: trade?.executed_at || journal?.entry_time || null,
    lifecycle: {
      journalStatus: journal?.status || null,
      strategyProfileStatus: strategyProfile?.status || null,
      strategyLifecycleStatus: strategyState?.lifecycleStatus || null,
    },
    strategy: {
      profileId: strategyProfile?.id || null,
      family: signal?.strategy_family || journal?.strategy_family || strategyRoute?.family || null,
      quality: signal?.strategy_quality || journal?.strategy_quality || null,
      readiness: signal?.strategy_readiness ?? journal?.strategy_readiness ?? null,
      setupType,
      route: strategyRoute,
      executionPlan,
      responsibilityPlan,
    },
    regime: {
      regime,
      confidence: journal?.market_regime_confidence ?? marketRegime?.confidence ?? marketContext?.confidence ?? strategyRoute?.confidence ?? null,
    },
    agentConsensus: {
      analystSignals: signal?.analyst_signals || null,
      nemesisVerdict: signal?.nemesis_verdict || null,
      executionOrigin: trade?.execution_origin || journal?.execution_origin || signal?.execution_origin || null,
      qualityFlag: trade?.quality_flag || journal?.quality_flag || signal?.quality_flag || null,
    },
    linkage: {
      hasTrade: Boolean(trade),
      hasSignal: Boolean(signal),
      hasJournal: Boolean(journal),
      hasStrategyProfile: Boolean(strategyProfile),
      hasStrategyRoute: Boolean(strategyRoute),
      hasExecutionPlan: Boolean(executionPlan),
      hasResponsibilityPlan: Boolean(responsibilityPlan),
      hasRegime: Boolean(regime),
      hasAgentConsensus: Boolean(signal?.analyst_signals || signal?.nemesis_verdict),
    },
  };
}

export function scoreExecutionFillEnvelope(envelope = {}) {
  const linkage = envelope.linkage || {};
  const setupType = String(envelope?.strategy?.setupType || '').trim();
  const routeSource = String(envelope?.strategy?.route?.source || '').trim();
  const checks = [
    ['trade', linkage.hasTrade],
    ['signal', linkage.hasSignal],
    ['journal', linkage.hasJournal],
    ['strategyProfile', linkage.hasStrategyProfile],
    ['strategyRoute', linkage.hasStrategyRoute],
    ['executionPlan', linkage.hasExecutionPlan],
    ['responsibilityPlan', linkage.hasResponsibilityPlan],
    ['regime', linkage.hasRegime],
    ['agentConsensus', linkage.hasAgentConsensus],
  ];
  const missing = checks.filter(([, ok]) => !ok).map(([key]) => key);
  const score = checks.length > 0
    ? Math.round(((checks.length - missing.length) / checks.length) * 100)
    : 0;
  const recoveredUnattributedExecution =
    setupType === 'unattributed_execution_tracking'
    && routeSource.includes('fallback')
    && linkage.hasTrade
    && linkage.hasJournal
    && linkage.hasStrategyRoute
    && linkage.hasExecutionPlan
    && linkage.hasResponsibilityPlan
    && linkage.hasRegime;
  return {
    score,
    missing,
    status: missing.length === 0
      ? 'complete'
      : (score >= 70 || recoveredUnattributedExecution)
        ? 'partial'
        : 'weak',
  };
}
