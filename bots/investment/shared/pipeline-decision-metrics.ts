// @ts-nocheck
/**
 * Metrics helpers for the decision execution pipeline.
 *
 * The runner still owns state transitions; this module keeps the metric shape
 * deterministic and smoke-testable while we gradually break down the monolith.
 */

export function buildDecisionWarnings({
  symbols = [],
  debateCount = 0,
  debateLimit = 0,
  riskRejected = 0,
  weakSignalSkipped = 0,
  midGapPromoted = 0,
  representativeBuyDropped = 0,
} = {}) {
  const warnings = [];
  if (symbols.length >= 20 && debateCount >= Math.max(1, debateLimit - 1)) warnings.push('debate_capacity_hot');
  if (riskRejected >= 5) warnings.push('risk_reject_saved_work');
  if (weakSignalSkipped >= 10) warnings.push('weak_signal_pressure');
  if (midGapPromoted >= 3) warnings.push('mid_gap_validation_promoted');
  if (representativeBuyDropped >= 1) warnings.push('representative_buy_pass_applied');
  return warnings;
}

export function countDecisionActions(decisions = []) {
  const counts = { buy: 0, sell: 0, hold: 0 };
  for (const decision of decisions || []) {
    const action = String(decision?.action || '').toLowerCase();
    if (action === 'buy') counts.buy += 1;
    else if (action === 'sell') counts.sell += 1;
    else counts.hold += 1;
  }
  return counts;
}

export function buildDecisionPipelineMetrics({
  startedAt = Date.now(),
  runtimeSymbols = [],
  symbolDecisions = [],
  debateCount = 0,
  debateLimit = 0,
  riskRejected = 0,
  riskRejectReasons = {},
  weakSignalSkipped = 0,
  weakSignalReasons = {},
  strategyRouteCounts = {},
  strategyRouteQualityCounts = {},
  strategyRouteReadinessSum = 0,
  strategyRouteReadinessCount = 0,
  midGapPromoted = 0,
  midGapRejectedByRisk = 0,
  invalidSignalSkipped = 0,
  exitPhaseEvaluated = 0,
  exitPhaseSellSignals = 0,
  exitPhaseExecuted = 0,
  exitBelowMinSkipped = 0,
  representativeReduction = null,
  collectQuality = {},
  collectQualityBlockedBuyCount = 0,
  collectQualityReducedBuyCount = 0,
  entryTriggerStats = null,
  predictiveValidationStats = null,
  extra = {},
} = {}) {
  const representativeBuyDropped = Number(representativeReduction?.dropped?.length || 0);
  return {
    durationMs: Date.now() - startedAt,
    inputSymbols: runtimeSymbols.length,
    decidedSymbols: symbolDecisions.length,
    approvedSignals: extra.approvedSignals ?? 0,
    executedSymbols: extra.executedSymbols ?? 0,
    debateCount,
    debateLimit,
    riskRejected,
    riskRejectReasons: { ...riskRejectReasons },
    weakSignalSkipped,
    weakSignalReasons: { ...weakSignalReasons },
    strategyRouteCounts: { ...strategyRouteCounts },
    strategyRouteQualityCounts: { ...strategyRouteQualityCounts },
    strategyRouteAvgReadiness: strategyRouteReadinessCount > 0
      ? Number((strategyRouteReadinessSum / strategyRouteReadinessCount).toFixed(4))
      : null,
    midGapPromoted,
    midGapRejectedByRisk,
    invalidSignalSkipped,
    exitPhaseEvaluated,
    exitPhaseSellSignals,
    exitPhaseExecuted,
    exitBelowMinSkipped,
    savedExecutionWork: riskRejected * 5,
    warnings: [
      ...buildDecisionWarnings({
        symbols: runtimeSymbols,
        debateCount,
        debateLimit,
        riskRejected,
        weakSignalSkipped,
        midGapPromoted,
        representativeBuyDropped,
      }),
      ...(collectQuality.status === 'degraded' ? ['collect_quality_degraded'] : []),
      ...(collectQuality.status === 'insufficient' ? ['collect_quality_insufficient'] : []),
    ],
    representativeBuyRequested: Number(representativeReduction?.requestedBuyCount || 0),
    representativeBuyKept: Number(representativeReduction?.kept?.length || 0),
    representativeBuyDropped,
    collectQualityStatus: collectQuality.status,
    collectQualityReadiness: collectQuality.readinessScore,
    collectQualityBlockedBuyCount,
    collectQualityReducedBuyCount,
    entryTriggerStats,
    predictiveValidationStats,
    ...extra,
  };
}

export default {
  buildDecisionWarnings,
  countDecisionActions,
  buildDecisionPipelineMetrics,
};
