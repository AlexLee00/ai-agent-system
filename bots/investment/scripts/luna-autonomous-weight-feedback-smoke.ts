#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  DEFAULT_LUNA_WEIGHT_POLICY,
  buildLunaAutonomousWeightFeedback,
} from '../shared/luna-autonomous-weight-feedback.ts';
import { buildLunaWeightVector } from '../shared/luna-weight-vector.ts';

function sumWeights(weights: any = {}) {
  return Object.values(weights).reduce((sum, value) => sum + Number(value || 0), 0);
}

const weakCommunity = buildLunaAutonomousWeightFeedback({
  metrics: {
    candidate: { activeCount: 10 },
    backtest: { sample: 10, freshRate: 0.8, healthyRate: 0.65, passRate: 0.45 },
    predictive: { sample: 10, coverageAvg: 0.82, passRate: 0.36, blockRate: 0.5 },
    community: { sample: 12, readyRatio: 0.4, blockedRatio: 0.25, downweightedRatio: 0.5, avgQuality: 0.22 },
  },
});
assert.equal(weakCommunity.ok, true);
assert.equal(weakCommunity.shadowOnly, true);
assert.equal(weakCommunity.liveMutation, false);
assert.ok(Math.abs(sumWeights(weakCommunity.weights) - 1) < 0.000001);
assert.ok(weakCommunity.weights.community < DEFAULT_LUNA_WEIGHT_POLICY.community);
assert.ok(weakCommunity.reasons.includes('community_source_quality_weak_downweight'));

const strongCommunity = buildLunaAutonomousWeightFeedback({
  metrics: {
    candidate: { activeCount: 10 },
    backtest: { sample: 10, freshRate: 0.82, healthyRate: 0.66, passRate: 0.46 },
    predictive: { sample: 10, coverageAvg: 0.84, passRate: 0.38, blockRate: 0.45 },
    community: { sample: 12, readyRatio: 0.88, blockedRatio: 0.02, downweightedRatio: 0.05, avgQuality: 0.44 },
  },
});
assert.ok(strongCommunity.weights.community > DEFAULT_LUNA_WEIGHT_POLICY.community);
assert.ok(strongCommunity.reasons.includes('community_source_quality_strong_boost'));

const weakBacktest = buildLunaAutonomousWeightFeedback({
  metrics: {
    candidate: { activeCount: 10 },
    backtest: { sample: 10, freshRate: 0.2, healthyRate: 0.4, passRate: 0.1 },
    predictive: { sample: 10, coverageAvg: 0.82, passRate: 0.36, blockRate: 0.5 },
    community: { sample: 8, readyRatio: 0.75, blockedRatio: 0.05, downweightedRatio: 0.05, avgQuality: 0.4 },
  },
});
assert.ok(weakBacktest.weights.backtest < DEFAULT_LUNA_WEIGHT_POLICY.backtest);
assert.ok(weakBacktest.reasons.includes('backtest_feedback_weak_downweight'));

const staticFallback = buildLunaAutonomousWeightFeedback({ metrics: {} });
assert.deepEqual(staticFallback.weights, DEFAULT_LUNA_WEIGHT_POLICY);
assert.equal(staticFallback.status, 'insufficient_feedback_static_weights');

const deterministicWeakCommunity = buildLunaAutonomousWeightFeedback({
  now: '2026-06-29T00:00:00.000Z',
  metrics: {
    candidate: { activeCount: 10 },
    backtest: { sample: 10, freshRate: 0.8, healthyRate: 0.65, passRate: 0.45 },
    predictive: { sample: 10, coverageAvg: 0.82, passRate: 0.36, blockRate: 0.5 },
    community: { sample: 12, readyRatio: 0.4, blockedRatio: 0.25, downweightedRatio: 0.5, avgQuality: 0.22 },
  },
});
assert.equal(deterministicWeakCommunity.generatedAt, '2026-06-29T00:00:00.000Z');
assert.equal(deterministicWeakCommunity.shadowOnly, true);
assert.equal(deterministicWeakCommunity.liveMutation, false);
assert.equal(deterministicWeakCommunity.weights.community, 0.156145);
assert.equal(deterministicWeakCommunity.deltas.community, -0.0439);

const now = new Date('2026-05-14T00:00:00.000Z').toISOString();
const vector = buildLunaWeightVector({
  asOf: now,
  candidate: { symbol: 'BTC/USDT', market: 'crypto', score: 0.9, discovered_at: now },
  backtest: { fresh: true, healthy: true, sharpe: 1.1, win_rate: 55, max_drawdown: 10, last_backtest_at: now },
  predictive: { decision: 'pass_prediction', score: 0.8, created_at: now },
  community: { avg_score: 0.4, source_count: 3, last_seen_at: now },
}, {
  riskBudgetUsdt: 50,
  weights: weakCommunity.weights,
  autonomousWeightFeedback: weakCommunity,
});
assert.equal(vector.evidence.weights.source, 'luna_autonomous_feedback');
assert.equal(vector.evidence.weights.liveMutation, false);
assert.ok(vector.evidence.weights.reasons.includes('community_source_quality_weak_downweight'));

const payload = {
  ok: true,
  smoke: 'luna-autonomous-weight-feedback',
  weakCommunity: {
    community: weakCommunity.weights.community,
    reasons: weakCommunity.reasons,
  },
  deterministicWeakCommunity: {
    generatedAt: deterministicWeakCommunity.generatedAt,
    community: deterministicWeakCommunity.weights.community,
    delta: deterministicWeakCommunity.deltas.community,
  },
  strongCommunity: {
    community: strongCommunity.weights.community,
    reasons: strongCommunity.reasons,
  },
  weakBacktest: {
    backtest: weakBacktest.weights.backtest,
    reasons: weakBacktest.reasons,
  },
  vector: {
    signal: vector.signal,
    weightSource: vector.evidence.weights.source,
  },
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('luna-autonomous-weight-feedback-smoke ok');
}
