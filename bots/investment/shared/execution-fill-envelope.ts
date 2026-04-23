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
  const strategyRoute = safeJson(signal?.strategy_route || journal?.strategy_route, null);

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
      setupType: strategyProfile?.setup_type || strategyRoute?.setupType || null,
      route: strategyRoute,
      executionPlan: strategyContext?.executionPlan || null,
      responsibilityPlan: strategyContext?.responsibilityPlan || null,
    },
    regime: {
      regime: journal?.market_regime || marketRegime?.regime || strategyProfile?.market_context?.regime || null,
      confidence: journal?.market_regime_confidence ?? marketRegime?.confidence ?? strategyProfile?.market_context?.confidence ?? null,
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
      hasExecutionPlan: Boolean(strategyContext?.executionPlan),
      hasResponsibilityPlan: Boolean(strategyContext?.responsibilityPlan),
      hasRegime: Boolean(journal?.market_regime || marketRegime?.regime || strategyProfile?.market_context?.regime),
      hasAgentConsensus: Boolean(signal?.analyst_signals || signal?.nemesis_verdict),
    },
  };
}

export function scoreExecutionFillEnvelope(envelope = {}) {
  const linkage = envelope.linkage || {};
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
  return {
    score,
    missing,
    status: missing.length === 0 ? 'complete' : score >= 70 ? 'partial' : 'weak',
  };
}
