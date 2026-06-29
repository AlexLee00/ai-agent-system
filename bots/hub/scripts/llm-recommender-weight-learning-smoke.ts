#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  aggregateLlmRoutingRowsForLearning,
  applyLlmRecommenderWeightDeltas,
  buildLlmRecommenderWeightLearningReport,
  DEFAULT_LLM_RECOMMENDER_WEIGHT_POLICY,
  LLM_RECOMMENDER_WEIGHT_CATEGORIES,
} from '../lib/llm-recommender-weight-learning.ts';
import { runLlmRecommenderWeightLearningRuntime } from './runtime-llm-recommender-weight-learning.ts';

const results: Array<{ id: string; pass: boolean; evidence: string }> = [];

function repeat(count: number, row: Record<string, unknown>): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({ ...row, request_id: `${row.selector_key}-${row.runtime_purpose}-${index}` }));
}

function fixtureRows(): Record<string, unknown>[] {
  return [
    ...repeat(40, {
      selector_key: 'fixture.accuracy',
      runtime_purpose: 'evaluation_scoring',
      abstract_model: 'anthropic_sonnet',
      provider_tier: '1',
      success: true,
      duration_ms: 900,
      estimated_cost_usd: 0.002,
      cost_usd: 0,
      prompt_chars: 9200,
      fallback_count: 0,
      budget_guard_status: 'ok',
    }),
    ...repeat(40, {
      selector_key: 'fixture.accuracy',
      runtime_purpose: 'evaluation_scoring',
      abstract_model: 'anthropic_haiku',
      provider_tier: '1',
      success: true,
      duration_ms: 2400,
      estimated_cost_usd: 0.004,
      cost_usd: 0,
      prompt_chars: 9200,
      fallback_count: 0,
      budget_guard_status: 'ok',
    }),
    ...repeat(36, {
      selector_key: 'fixture.fast',
      runtime_purpose: 'comment',
      abstract_model: 'anthropic_haiku',
      provider_tier: '2',
      success: true,
      duration_ms: 350,
      estimated_cost_usd: 0.0005,
      cost_usd: 0.0001,
      prompt_chars: 1200,
      fallback_count: 0,
      budget_guard_status: 'ok',
    }),
    ...repeat(36, {
      selector_key: 'fixture.fast',
      runtime_purpose: 'comment',
      abstract_model: 'anthropic_sonnet',
      provider_tier: '2',
      success: true,
      duration_ms: 1200,
      estimated_cost_usd: 0.0025,
      cost_usd: 0.0002,
      prompt_chars: 1200,
      fallback_count: 1,
      budget_guard_status: 'ok',
    }),
  ];
}

async function record(id: string, fn: () => Promise<string> | string): Promise<void> {
  try {
    results.push({ id, pass: true, evidence: await fn() });
  } catch (error) {
    results.push({ id, pass: false, evidence: error?.stack || error?.message || String(error) });
  }
}

async function main(): Promise<void> {
  await record('TS-1', () => {
    const rows = aggregateLlmRoutingRowsForLearning(fixtureRows());
    const sonnet = rows.find((row) => row.selectorKey === 'fixture.accuracy' && row.abstractModel === 'anthropic_sonnet');
    assert.equal(rows.length, 4);
    assert.equal(sonnet?.sample, 40);
    assert.equal(sonnet?.successRate, 1);
    assert.equal(sonnet?.avgDurationMs, 900);
    assert(Math.abs((sonnet?.avgEffectiveCostUsd || 0) - 0.002) < 0.000_000_1);
    return `groups=${rows.length} sonnetSample=${sonnet?.sample}`;
  });

  await record('TS-2', () => {
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
    assert(LLM_RECOMMENDER_WEIGHT_CATEGORIES.every((category) => weights[category] >= 0.08 - 0.000_01));
    assert(LLM_RECOMMENDER_WEIGHT_CATEGORIES.every((category) => weights[category] <= 0.48 + 0.000_01));
    assert.equal(weights.length, 0.181833);
    assert.equal(weights.budget, 0.090833);
    assert.equal(weights.accuracy, 0.181833);
    return `sum=${sum.toFixed(6)} max=${Math.max(...Object.values(weights)).toFixed(6)}`;
  });

  await record('TS-3', () => {
    const report = buildLlmRecommenderWeightLearningReport({
      rows: repeat(5, {
        selector_key: 'fixture.small',
        runtime_purpose: 'comment',
        abstract_model: 'anthropic_haiku',
        provider_tier: '1',
        success: true,
        duration_ms: 100,
        estimated_cost_usd: 0.001,
      }),
      minSamples: 30,
      now: new Date('2026-06-28T00:00:00Z'),
    });
    assert.equal(report.status, 'insufficient_feedback_static_weights');
    assert.deepEqual(report.weights, report.baseWeights);
    return `status=${report.status}`;
  });

  await record('TS-4', () => {
    const report = buildLlmRecommenderWeightLearningReport({ rows: fixtureRows(), minSamples: 30 });
    assert.equal(report.shadowOnly, true);
    assert.equal(report.liveMutation, false);
    assert.equal(report.promotionReady, false);
    return `shadowOnly=${report.shadowOnly} liveMutation=${report.liveMutation}`;
  });

  await record('TS-5', () => {
    const report = buildLlmRecommenderWeightLearningReport({ rows: fixtureRows(), minSamples: 30 });
    assert.equal(report.status, 'shadow_weight_feedback_ready');
    assert.equal(report.manualPromotionReviewCandidate, true);
    assert(report.metrics.shadowCompositeScore >= report.metrics.staticCompositeScore);
    assert(report.reasons.includes('accuracy_sensitive_large_model_boost'));
    return `static=${report.metrics.staticCompositeScore} shadow=${report.metrics.shadowCompositeScore}`;
  });

  await record('TS-6', () => {
    const report = buildLlmRecommenderWeightLearningReport({
      rows: repeat(30, {
        selector_key: 'fixture.schema',
        runtime_purpose: 'schema_check',
        abstract_model: 'anthropic_haiku',
        provider_tier: '1',
        success: true,
        duration_ms: 500,
        estimated_cost_usd: 0.001,
      }),
      minSamples: 30,
    });
    assert.equal(report.metrics.rows[0].avgDurationMs, 500);
    assert.equal(Object.prototype.hasOwnProperty.call(report.metrics.rows[0], 'matched'), false);
    return `duration=${report.metrics.rows[0].avgDurationMs}`;
  });

  await record('TS-7', async () => {
    let writes = 0;
    const queryFn = async () => aggregateLlmRoutingRowsForLearning(fixtureRows());
    const writeFn = async () => {
      writes += 1;
      return { rowCount: 1, rows: [] };
    };
    const dry = await runLlmRecommenderWeightLearningRuntime({ argv: ['--json', '--write'], queryFn, writeFn });
    assert.equal(dry.wrote, false);
    const liveShadow = await runLlmRecommenderWeightLearningRuntime({ argv: ['--json', '--write', '--no-dry-run'], queryFn, writeFn });
    assert.equal(liveShadow.wrote, true);
    assert.equal(writes, 1);
    return `dryWrote=${dry.wrote} writeWrote=${liveShadow.wrote}`;
  });

  const failed = results.filter((result) => !result.pass);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    suite: 'llm-recommender-weight-learning-smoke',
    results,
  }, null, 2));

  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
