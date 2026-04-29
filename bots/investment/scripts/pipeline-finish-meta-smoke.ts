#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildPipelineDecisionFinishMeta } from '../shared/pipeline-decision-finish-meta.ts';

const meta = buildPipelineDecisionFinishMeta({
  bridgeStatus: 'completed',
  symbolDecisions: [{ symbol: 'BTC/USDT' }, { symbol: 'ETH/USDT' }],
  metrics: {
    approvedSignals: 1,
    executedSymbols: 1,
    debateCount: 2,
    debateLimit: 4,
    riskRejected: 1,
    riskRejectReasons: { max_position: 1 },
    weakSignalSkipped: 1,
    weakSignalReasons: { low_confidence: 1 },
    strategyRouteCounts: { breakout: 2 },
    strategyRouteQualityCounts: { good: 1 },
    strategyRouteAvgReadiness: 0.73,
    midGapPromoted: 1,
    midGapRejectedByRisk: 0,
    invalidSignalSkipped: 0,
    exitPhaseEvaluated: 2,
    exitPhaseSellSignals: 1,
    exitPhaseExecuted: 1,
    exitBelowMinSkipped: 0,
    savedExecutionWork: 3,
    warnings: ['sample_warning'],
    entryTriggerStats: { fired: 1 },
    predictiveValidationStats: { blocked: 0 },
  },
  actionCounts: { buy: 1, sell: 1, hold: 1 },
  decisionCount: 3,
  exitEntrySummary: { reclaimedUsdt: 12.5, closedCount: 1 },
  investmentTradeMode: 'validation',
  plannerMeta: { planner_source: 'smoke' },
  portfolioDecision: { portfolio_view: 'balanced', risk_level: 'MEDIUM' },
  topRiskRejectReason: 'max_position',
  topWeakSignalReason: 'low_confidence',
});

assert.equal(meta.bridge_status, 'completed');
assert.equal(meta.decided_symbols, 2);
assert.equal(meta.decision_count, 3);
assert.equal(meta.buy_decisions, 1);
assert.equal(meta.executed_symbols, 1);
assert.equal(meta.risk_reject_reason_top, 'max_position');
assert.equal(meta.strategy_route_counts.breakout, 2);
assert.equal(meta.exit_reclaimed_usdt, 12.5);
assert.equal(meta.investment_trade_mode, 'validation');
assert.equal(meta.planner_source, 'smoke');
assert.equal(meta.portfolio_view, 'balanced');
assert.equal(meta.entry_trigger_stats.fired, 1);
assert.equal(meta.predictive_validation.blocked, 0);

const payload = {
  ok: true,
  smoke: 'pipeline-finish-meta',
  meta,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('pipeline-finish-meta-smoke ok');
}
