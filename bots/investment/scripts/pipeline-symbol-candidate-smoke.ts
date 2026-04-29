#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { ACTIONS, ANALYST_TYPES } from '../shared/signal.ts';
import {
  buildPipelineSymbolCandidate,
  recordStrategyRouteStats,
} from '../shared/pipeline-symbol-candidate.ts';

const symbol = 'ORCA/USDT';
const analyses = [
  { analyst: ANALYST_TYPES.TA_MTF, confidence: 0.6, signal: ACTIONS.BUY },
];
const discoveryCandidateBySymbol = new Map([
  [symbol, {
    source: 'smoke-discovery',
    score: 0.82,
    confidence: 0.77,
    reasonCode: 'breakout',
    evidenceRef: 'evidence-1',
  }],
]);
const communitySentimentBySymbol = new Map([
  [symbol, { sentimentScore: 0.4, source: 'community' }],
]);
const candles = Array.from({ length: 12 }, (_, index) => ({
  timestamp: index,
  open: 1 + index,
  high: 2 + index,
  low: 0.5 + index,
  close: 1.5 + index,
  volume: 100 + index,
}));

const candidate = await buildPipelineSymbolCandidate({
  symbol,
  exchange: 'binance',
  decision: {
    action: ACTIONS.BUY,
    confidence: 0.5,
    strategy_route: {
      selectedFamily: 'breakout',
      quality: 'good',
      readinessScore: 0.73,
    },
  },
  analyses,
  intelligentFlags: {
    phases: {
      mtfAnalyzerEnabled: true,
      wyckoffDetectionEnabled: true,
      vsaClassificationEnabled: true,
      scoreFusionEnabled: true,
    },
    mtf: { smoke: true },
    shouldApplyDecisionMutation: () => true,
    shouldApplyScoreFusion: () => true,
  },
  currentPortfolio: { marketRegime: { regime: 'bull' } },
  discoveryCandidateBySymbol,
  communitySentimentBySymbol,
  discoveryMarket: 'crypto',
  getOHLCV: async () => candles,
  analyzeMultiTimeframe: () => ({
    mtfAgreement: 0.8,
    alignmentScore: 0.6,
    dominantSignal: ACTIONS.BUY,
  }),
  detectWyckoffPhase: () => ({ phase: 'accumulation' }),
  classifyVsaBar: () => ({ metrics: { volRatio: 2.3 } }),
  fuseDiscoveryScore: () => ({
    discoveryScore: 0.8,
    setupType: 'breakout',
    entryStrategy: 'breakout_retest',
  }),
  normalizeRegimeLabel: () => 'bull',
});

assert.equal(candidate.enrichedDecision.confidence, 0.59);
assert.equal(candidate.enrichedDecision.setup_type, 'breakout');
assert.equal(candidate.enrichedDecision.entry_strategy, 'breakout_retest');
assert.equal(candidate.enrichedDecision.predictiveScore, 0.8);
assert.equal(candidate.enrichedDecision.triggerHints.breakoutRetest, true);
assert.equal(candidate.enrichedDecision.triggerHints.volumeBurst, 2.3);
assert.equal(candidate.enrichedDecision.block_meta.discoveryContext.market, 'crypto');
assert.equal(candidate.intelligentState.discoverySeed.source, 'smoke-discovery');

const stats = recordStrategyRouteStats(candidate.enrichedDecision, {
  strategyRouteCounts: {},
  strategyRouteQualityCounts: {},
  strategyRouteReadinessSum: 0,
  strategyRouteReadinessCount: 0,
});

assert.equal(stats.strategyRouteCounts.breakout, 1);
assert.equal(stats.strategyRouteQualityCounts.good, 1);
assert.equal(stats.strategyRouteReadinessSum, 0.73);
assert.equal(stats.strategyRouteReadinessCount, 1);

const payload = {
  ok: true,
  smoke: 'pipeline-symbol-candidate',
  decision: candidate.enrichedDecision,
  stats,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('pipeline-symbol-candidate-smoke ok');
}
