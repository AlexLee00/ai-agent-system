#!/usr/bin/env node
// @ts-nocheck

import { buildDecisionPipelineMetrics, buildDecisionWarnings } from '../shared/pipeline-decision-metrics.ts';

const startedAt = Date.now() - 250;
const metrics = buildDecisionPipelineMetrics({
  startedAt,
  runtimeSymbols: Array.from({ length: 25 }, (_, index) => `SYM${index}/USDT`),
  symbolDecisions: [{ symbol: 'BTC/USDT' }, { symbol: 'ETH/USDT' }],
  debateCount: 4,
  debateLimit: 5,
  riskRejected: 6,
  riskRejectReasons: { capital_backpressure: 2 },
  weakSignalSkipped: 11,
  weakSignalReasons: { weak_confidence: 3 },
  strategyRouteCounts: { breakout: 2, mean_reversion: 1 },
  strategyRouteQualityCounts: { ready: 2 },
  strategyRouteReadinessSum: 1.4,
  strategyRouteReadinessCount: 2,
  midGapPromoted: 3,
  representativeReduction: {
    requestedBuyCount: 4,
    kept: ['BTC/USDT', 'ETH/USDT'],
    dropped: ['ORCA/USDT'],
  },
  collectQuality: { status: 'degraded', readinessScore: 0.62 },
  collectQualityBlockedBuyCount: 1,
  collectQualityReducedBuyCount: 2,
  entryTriggerStats: { accepted: 1 },
  predictiveValidationStats: { blocked: 1 },
  extra: { approvedSignals: 3, executedSymbols: 2, midGapExecuted: 1 },
});

const warnings = buildDecisionWarnings({
  symbols: Array.from({ length: 25 }, (_, index) => `SYM${index}`),
  debateCount: 4,
  debateLimit: 5,
  riskRejected: 6,
  weakSignalSkipped: 11,
  midGapPromoted: 3,
  representativeBuyDropped: 1,
});

const checks = [
  ['approvedSignals', metrics.approvedSignals === 3],
  ['executedSymbols', metrics.executedSymbols === 2],
  ['strategyRouteCounts', metrics.strategyRouteCounts.breakout === 2 && metrics.strategyRouteCounts.mean_reversion === 1],
  ['strategyRouteAvgReadiness', metrics.strategyRouteAvgReadiness === 0.7],
  ['warnings', ['debate_capacity_hot', 'risk_reject_saved_work', 'weak_signal_pressure', 'mid_gap_validation_promoted', 'representative_buy_pass_applied'].every((item) => warnings.includes(item))],
  ['collectQualityWarning', metrics.warnings.includes('collect_quality_degraded')],
  ['extraPreserved', metrics.midGapExecuted === 1],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length > 0) {
  throw new Error(`pipeline metrics smoke failed: ${failed.map(([name]) => name).join(', ')}`);
}

const payload = {
  ok: true,
  smoke: 'pipeline-decision-metrics',
  metrics,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('✅ pipeline decision metrics smoke passed');
}
