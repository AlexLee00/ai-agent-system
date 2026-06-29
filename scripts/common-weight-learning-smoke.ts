#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import {
  applyDelta,
  capDelta,
  clamp,
  hasSamples,
  n,
  round,
} from '../bots/_shared/common-weight-learning.ts';
import {
  DEFAULT_LUNA_WEIGHT_POLICY,
  buildLunaAutonomousWeightFeedback,
} from '../bots/investment/shared/luna-autonomous-weight-feedback.ts';
import {
  DEFAULT_LLM_RECOMMENDER_WEIGHT_POLICY,
  LLM_RECOMMENDER_WEIGHT_CATEGORIES,
  applyLlmRecommenderWeightDeltas,
} from '../bots/hub/lib/llm-recommender-weight-learning.ts';

const results: Array<{ id: string; pass: boolean; evidence: string }> = [];

function record(id: string, fn: () => string): void {
  try {
    results.push({ id, pass: true, evidence: fn() });
  } catch (error: any) {
    results.push({ id, pass: false, evidence: error?.stack || error?.message || String(error) });
  }
}

record('TS-CWL-1', () => {
  assert.equal(n('3.5'), 3.5);
  assert.equal(n('bad', 9), 9);
  assert.equal(clamp(3, 0, 1), 1);
  assert.equal(round(0.1234567, 4), 0.1235);
  assert.equal(capDelta(10, 0.07), 0.07);
  assert.equal(capDelta(-10, 0.07), -0.07);
  return 'numeric utilities ok';
});

record('TS-CWL-2', () => {
  const components = ['a', 'b'];
  const weights = applyDelta(
    { a: 0.5, b: 0.5 },
    { a: 1, b: -1 },
    components,
    0.07,
    (next) => next,
  );
  assert(Math.abs(weights.a - 0.57) < 0.000_001);
  assert(Math.abs(weights.b - 0.43) < 0.000_001);
  assert.equal(hasSamples({ a: { sample: 0 }, b: { count: 1 } }, ['a.sample', 'b.count']), true);
  assert.equal(hasSamples({ a: { sample: 0 } }, ['a.sample', 'b.count']), false);
  return `weights=${JSON.stringify(weights)}`;
});

record('TS-CWL-3', () => {
  const report = buildLunaAutonomousWeightFeedback({
    now: '2026-06-29T00:00:00.000Z',
    metrics: {
      candidate: { activeCount: 10 },
      backtest: { sample: 10, freshRate: 0.8, healthyRate: 0.65, passRate: 0.45 },
      predictive: { sample: 10, coverageAvg: 0.82, passRate: 0.36, blockRate: 0.5 },
      community: { sample: 12, readyRatio: 0.4, blockedRatio: 0.25, downweightedRatio: 0.5, avgQuality: 0.22 },
    },
  }) as any;
  assert.equal(report.generatedAt, '2026-06-29T00:00:00.000Z');
  assert.equal(report.shadowOnly, true);
  assert.equal(report.liveMutation, false);
  assert.equal(report.weights.community, 0.156145);
  assert.equal(report.deltas.community, -0.0439);
  assert.deepEqual(report.reasons, [
    'backtest_feedback_strong_boost',
    'predictive_feedback_strong_boost',
    'community_source_quality_weak_downweight',
  ]);
  assert.equal(report.baseWeights.community, DEFAULT_LUNA_WEIGHT_POLICY.community);
  return `lunaCommunity=${report.weights.community}`;
});

record('TS-CWL-4', () => {
  const weights = applyLlmRecommenderWeightDeltas(DEFAULT_LLM_RECOMMENDER_WEIGHT_POLICY, {
    length: 10,
    budget: -10,
    failure: 0.5,
    urgency: 0.5,
    task_type: 0.5,
    accuracy: 0.5,
  }, 0.07);
  const sum = LLM_RECOMMENDER_WEIGHT_CATEGORIES.reduce((total, category) => total + weights[category], 0);
  assert(Math.abs(sum - 1) < 0.000_01);
  assert.equal(weights.length, 0.181833);
  assert.equal(weights.budget, 0.090833);
  assert.equal(weights.accuracy, 0.181833);
  return `llmWeights=${JSON.stringify(weights)}`;
});

const failed = results.filter((result) => !result.pass);
console.log(JSON.stringify({
  ok: failed.length === 0,
  suite: 'common-weight-learning-smoke',
  results,
}, null, 2));

if (failed.length > 0) process.exitCode = 1;
