// @ts-nocheck

function normalizeActionCounts(actionCounts = {}) {
  return {
    buy: Number(actionCounts.buy || 0),
    sell: Number(actionCounts.sell || 0),
    hold: Number(actionCounts.hold || 0),
  };
}

export function buildPipelineDecisionFinishMeta({
  bridgeStatus,
  symbolDecisions = [],
  metrics = {},
  actionCounts = {},
  exitEntrySummary = null,
  investmentTradeMode = 'normal',
  plannerMeta = {},
  portfolioDecision = null,
  topRiskRejectReason = null,
  topWeakSignalReason = null,
  decisionCount = null,
  approvedSignals = null,
  executedSymbols = null,
  midGapExecuted = 0,
  postExecutionBlocked = 0,
} = {}) {
  const counts = normalizeActionCounts(actionCounts);
  const meta = {
    bridge_status: bridgeStatus,
    decided_symbols: Array.isArray(symbolDecisions) ? symbolDecisions.length : Number(symbolDecisions || 0),
    executed_symbols: executedSymbols ?? Number(metrics.executedSymbols || 0),
    decision_count: decisionCount ?? Number(counts.buy + counts.sell + counts.hold),
    buy_decisions: counts.buy,
    sell_decisions: counts.sell,
    hold_decisions: counts.hold,
    approved_signals: approvedSignals ?? Number(metrics.approvedSignals || 0),
    debate_count: Number(metrics.debateCount || 0),
    debate_limit: Number(metrics.debateLimit || 0),
    risk_rejected: Number(metrics.riskRejected || 0),
    risk_reject_reason_top: topRiskRejectReason,
    risk_reject_reasons: metrics.riskRejectReasons || {},
    weak_signal_skipped: Number(metrics.weakSignalSkipped || 0),
    weak_signal_reason_top: topWeakSignalReason,
    weak_signal_reasons: metrics.weakSignalReasons || {},
    strategy_route_counts: metrics.strategyRouteCounts || {},
    strategy_route_quality_counts: metrics.strategyRouteQualityCounts || {},
    strategy_route_avg_readiness: Number(metrics.strategyRouteAvgReadiness || 0),
    mid_gap_promoted: Number(metrics.midGapPromoted || 0),
    mid_gap_rejected_by_risk: Number(metrics.midGapRejectedByRisk || 0),
    mid_gap_executed: Number(midGapExecuted || metrics.midGapExecuted || 0),
    post_execution_blocked: Number(postExecutionBlocked || metrics.postExecutionBlocked || 0),
    invalid_signal_skipped: Number(metrics.invalidSignalSkipped || 0),
    exit_phase_evaluated: Number(metrics.exitPhaseEvaluated || 0),
    exit_phase_sell_signals: Number(metrics.exitPhaseSellSignals || 0),
    exit_phase_executed: Number(metrics.exitPhaseExecuted || 0),
    exit_below_min_skipped: Number(metrics.exitBelowMinSkipped || 0),
    exit_reclaimed_usdt: Number(exitEntrySummary?.reclaimedUsdt || 0),
    exit_closed_count: Number(exitEntrySummary?.closedCount || 0),
    saved_execution_work: Number(metrics.savedExecutionWork || 0),
    warnings: metrics.warnings || [],
    investment_trade_mode: investmentTradeMode,
    ...plannerMeta,
  };

  if (portfolioDecision) {
    meta.portfolio_view = portfolioDecision.portfolio_view;
    meta.risk_level = portfolioDecision.risk_level;
  }
  if (metrics.entryTriggerStats) {
    meta.entry_trigger_stats = metrics.entryTriggerStats;
  }
  if (metrics.predictiveValidationStats) {
    meta.predictive_validation = metrics.predictiveValidationStats;
  }

  return meta;
}

export default {
  buildPipelineDecisionFinishMeta,
};
