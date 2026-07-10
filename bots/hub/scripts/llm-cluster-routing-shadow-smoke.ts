#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildClusterRoutingRecommendation } from '../lib/llm/cluster-routing-shadow.ts';

const request = {
  callerTeam: 'hub',
  agent: 'archer',
  taskType: 'analysis',
  abstractModel: 'anthropic_sonnet',
  prompt: 'Analyze this failure and propose a safe fix.',
  systemPrompt: 'You are a careful reviewer.',
};

const CURRENT_SIGNATURE_KEY = 'v1:test-embed:2:2';

function historyRow(
  signature: number[],
  requestedModel: string,
  executedModel: string | null,
  success: boolean,
  latencyMs: number,
  costUsd: number,
  signatureKey = CURRENT_SIGNATURE_KEY,
  routingRequestId: string | null = 'routing-request',
) {
  return {
    routing_signals: {
      ...(routingRequestId ? { routing_request_id: routingRequestId } : {}),
      cluster_recommendation: {
        embedding_signature: signature,
        signature_key: signatureKey,
      },
      ...(executedModel ? { execution: { provider: executedModel.split('/')[0], model: executedModel } } : {}),
    },
    manual_model: requestedModel,
    auto_model: requestedModel,
    success,
    latency_ms: latencyMs,
    cost_usd: costUsd,
  };
}

async function main() {
  let embedCalls = 0;
  let historyCalls = 0;
  const deps = {
    embedText: async () => {
      embedCalls += 1;
      return [1, 0];
    },
    loadHistory: async () => {
      historyCalls += 1;
      return [
        historyRow([1, 0], 'anthropic_opus', 'openai-oauth/gpt-5.4-mini', true, 100, 0.001),
        historyRow([0.95, 0.05], 'anthropic_opus', 'openai-oauth/gpt-5.4-mini', true, 120, 0.0012),
        historyRow([0.9, 0.1], 'anthropic_haiku', 'groq/llama-3.1-8b-instant', false, 80, 0.02),
        historyRow([0.92, 0.08], 'anthropic_haiku', null, true, 1, 0),
        historyRow([1, 0], 'anthropic_haiku', 'legacy/should-not-win', true, 1, 0, CURRENT_SIGNATURE_KEY, null),
        historyRow([0.95, 0.05], 'anthropic_haiku', 'legacy/should-not-win', true, 1, 0, CURRENT_SIGNATURE_KEY, null),
        historyRow([0.9, 0.1], 'anthropic_haiku', 'legacy/should-not-win', true, 1, 0, CURRENT_SIGNATURE_KEY, null),
        historyRow([-1, 0], 'anthropic_haiku', 'anthropic/claude-opus', true, 400, 0.02),
        historyRow([-0.9, -0.1], 'anthropic_haiku', 'anthropic/claude-opus', true, 420, 0.021),
        historyRow([1, 0], 'anthropic_haiku', 'anthropic/should-not-win', true, 1, 0, 'v1:other-embed:2:2'),
        historyRow([0.95, 0.05], 'anthropic_haiku', 'anthropic/should-not-win', true, 1, 0, 'v1:other-embed:2:2'),
        historyRow([0.9, 0.1], 'anthropic_haiku', 'anthropic/should-not-win', true, 1, 0, 'v1:other-embed:2:2'),
        historyRow([1, 0], 'anthropic_haiku', 'anthropic/dimension-should-not-win', true, 1, 0, 'v1:test-embed:1024:2'),
        historyRow([0.95, 0.05], 'anthropic_haiku', 'anthropic/dimension-should-not-win', true, 1, 0, 'v1:test-embed:1024:2'),
        historyRow([0.9, 0.1], 'anthropic_haiku', 'anthropic/dimension-should-not-win', true, 1, 0, 'v1:test-embed:1024:2'),
      ];
    },
    embeddingModel: 'test-embed',
  };

  assert.equal(await buildClusterRoutingRecommendation(request, { ...deps, env: {} }), null);
  assert.equal(embedCalls, 0);
  assert.equal(historyCalls, 0);

  assert.equal(await buildClusterRoutingRecommendation({ ...request, callerTeam: 'investment', agent: 'luna' }, {
    ...deps,
    env: { LLM_CLUSTER_ROUTING_SHADOW_ENABLED: 'true' },
  }), null);
  assert.equal(embedCalls, 0);
  assert.equal(historyCalls, 0);

  const recommendation = await buildClusterRoutingRecommendation(request, {
    ...deps,
    env: {
      LLM_CLUSTER_ROUTING_SHADOW_ENABLED: 'true',
      LLM_CLUSTER_ROUTING_MIN_SAMPLES: '2',
    },
  });
  assert.equal(embedCalls, 1);
  assert.equal(historyCalls, 1);
  assert.equal(recommendation?.recommended_model, 'openai-oauth/gpt-5.4-mini');
  assert.equal(recommendation?.sample_count, 3);
  assert.equal(recommendation?.model_sample_count, 2);
  assert.equal(recommendation?.success_rate, 1);
  assert.equal(recommendation?.embedding_model, 'test-embed');
  assert.equal(recommendation?.embedding_dimensions, 2);
  assert.equal(recommendation?.signature_dimensions, 2);
  assert.equal(recommendation?.signature_key, CURRENT_SIGNATURE_KEY);
  assert.equal(JSON.stringify(recommendation).includes(request.prompt), false);

  assert.equal(await buildClusterRoutingRecommendation(request, {
    env: { LLM_CLUSTER_ROUTING_SHADOW_ENABLED: 'true' },
    embedText: async () => null,
    loadHistory: async () => {
      throw new Error('history must not load after embedding failure');
    },
  }), null);

  const autoRouterSource = fs.readFileSync(path.resolve(__dirname, '../lib/llm/llm-auto-router.ts'), 'utf8');
  assert.match(autoRouterSource, /result\.mode !== 'shadow'/);
  assert.match(autoRouterSource, /jsonb_build_object\('cluster_recommendation'/);
  assert.match(autoRouterSource, /routing_request_id/);

  const clusterSource = fs.readFileSync(path.resolve(__dirname, '../lib/llm/cluster-routing-shadow.ts'), 'utf8');
  assert.match(clusterSource, /routing_request_id/);

  console.log('llm-cluster-routing-shadow-smoke ok');
}

main().catch((error) => {
  console.error(`llm-cluster-routing-shadow-smoke failed: ${error?.message || error}`);
  process.exit(1);
});
