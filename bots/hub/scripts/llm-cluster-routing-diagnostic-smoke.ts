#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  buildClusterRoutingRecommendation,
  loadClusterRoutingHistory,
} from '../lib/llm/cluster-routing-shadow.ts';

const require = createRequire(__filename);
const pgPool = require('../../../packages/core/lib/pg-pool');

const LIVE_SIGNATURE_KEY = 'v1:qwen3-embed-0.6b:1024:24';
const FIXTURE_SIGNATURE_KEY = 'v1:diagnostic-embed:2:2';

function historyRow(signature: number[], model: string, success: boolean, index: number) {
  return {
    routing_signals: {
      routing_request_id: `diagnostic-${index}`,
      cluster_recommendation: {
        embedding_signature: signature,
        signature_key: FIXTURE_SIGNATURE_KEY,
      },
      execution: { provider: model.split('/')[0], model },
    },
    success,
    latency_ms: 100 + index,
    cost_usd: 0.001,
  };
}

async function scopedCount(agent: string): Promise<number> {
  const result = await pgPool.getPool('public').query(`
    SELECT COUNT(*)::int AS count
    FROM hub.llm_auto_routing_log
    WHERE agent = $1
  `, [agent]);
  return Number(result.rows?.[0]?.count || 0);
}

async function main() {
  const smokeAgent = `SMOKE-CLUSTER-ROUTING-${process.pid}-${Date.now()}`;
  const beforeCount = await scopedCount(smokeAgent);
  const history = await loadClusterRoutingHistory(500, LIVE_SIGNATURE_KEY);
  assert(history.length > 0, 'eligible history must load from the real database');

  const fixtureHistory = [
    historyRow([1, 0], 'openai-oauth/gpt-5.4-mini', true, 1),
    historyRow([0.98, 0.02], 'openai-oauth/gpt-5.4-mini', true, 2),
    historyRow([0.95, 0.05], 'groq/llama-3.1-8b-instant', false, 3),
    historyRow([-1, 0], 'anthropic/claude-opus', true, 4),
  ];
  const recommendation = await buildClusterRoutingRecommendation({
    callerTeam: 'hub',
    agent: smokeAgent,
    prompt: 'diagnostic fixture',
  }, {
    env: {
      LLM_CLUSTER_ROUTING_SHADOW_ENABLED: 'true',
      LLM_CLUSTER_ROUTING_MIN_SAMPLES: '2',
    },
    embedText: async () => [1, 0],
    embeddingModel: 'diagnostic-embed',
    loadHistory: async () => fixtureHistory,
  });
  assert.equal(recommendation?.reason, 'recommended');
  assert.equal(recommendation?.recommended_model, 'openai-oauth/gpt-5.4-mini');
  assert.equal(recommendation?.model_sample_count, 2);

  const afterCount = await scopedCount(smokeAgent);
  assert.equal(beforeCount, 0);
  assert.equal(afterCount, beforeCount, 'read-only smoke must not create scoped rows');

  console.log(JSON.stringify({
    ok: true,
    smoke: 'llm-cluster-routing-diagnostic',
    liveMutation: false,
    signatureKey: LIVE_SIGNATURE_KEY,
    eligibleHistoryLoaded: history.length,
    fixtureRecommendation: {
      clusterId: recommendation?.cluster_id,
      sampleCount: recommendation?.sample_count,
      recommendedModel: recommendation?.recommended_model,
      modelSampleCount: recommendation?.model_sample_count,
    },
    scopedCount: { before: beforeCount, after: afterCount },
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(`llm-cluster-routing-diagnostic-smoke failed: ${error?.message || error}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pgPool.closeAll();
  });
