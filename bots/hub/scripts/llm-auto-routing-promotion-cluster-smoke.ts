#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import {
  evaluateClusterPromotion,
  runLlmAutoRoutingPromotionEvaluation,
} from './llm-auto-routing-promotion-evaluation.ts';

type ClusterRow = {
  cluster_id: string;
  signature_key: string;
  cluster_algorithm_version?: string;
  centroid_hash?: string;
  recommended_model: string;
  selected_model: string;
  success: boolean;
};

function clusterRows(
  recommendedSuccesses: number,
  alternativeSuccesses: number,
  centroidHash = 'centroid-a',
  recommendationSelectedCount = 15,
): ClusterRow[] {
  return Array.from({ length: 30 }, (_value, index) => {
    const recommendationSelected = index < recommendationSelectedCount;
    const successIndex = recommendationSelected ? index : index - recommendationSelectedCount;
    return {
      cluster_id: 'cluster-1-of-2',
      signature_key: 'v1:test-embed:2:2',
      cluster_algorithm_version: 'kmeans-v1',
      centroid_hash: centroidHash,
      recommended_model: 'openai/gpt-5.4-mini',
      selected_model: recommendationSelected ? 'openai/gpt-5.4-mini' : 'anthropic/claude-sonnet',
      success: successIndex < (recommendationSelected ? recommendedSuccesses : alternativeSuccesses),
    };
  });
}

function mockPgPool(rows: ClusterRow[]) {
  const calls: string[] = [];
  return {
    calls,
    query: async (_schema: string, sql: string) => {
      calls.push(String(sql));
      if (String(sql).includes("cluster_recommendation,cluster_id")) return rows;
      if (String(sql).includes('min(created_at)')) return [{ days: '30' }];
      if (String(sql).includes('SELECT count(*) AS cnt')) return [{ cnt: '200' }];
      if (String(sql).includes('GROUP BY mode')) return [{ mode: 'shadow', cnt: '200' }];
      if (String(sql).includes('GROUP BY task_complexity')) return [{ task_complexity: 'medium', cnt: '200' }];
      if (String(sql).includes('GROUP BY selected_provider')) return [{ selected_provider: 'openai', cnt: '200' }];
      if (String(sql).includes('count(*) FILTER (WHERE success = false)')) return [{ total: '100', failures: '0' }];
      if (String(sql).includes('percentile_cont')) return [{ p99: '1000' }];
      if (String(sql).includes('haiku_cost')) return [{ haiku_cost: '1', total_cost: '2' }];
      if (String(sql).includes('manual_count')) return [{ manual_count: '40', manual_agreement_count: '36' }];
      return [];
    },
  };
}

async function main() {
  const direct = evaluateClusterPromotion(clusterRows(12, 15));
  assert.equal(direct.applied, true);
  assert.equal(direct.clusters[0].sampleCount, 30);
  assert.equal(direct.clusters[0].recommendationMatchRate, 0.5);
  assert.equal(direct.clusters[0].successRateDelta, -0.2);
  assert.equal(direct.checks[0].passed, false);
  assert.equal(direct.minSamplesPerCohort, 10);

  const oneVsTwentyNine = evaluateClusterPromotion(clusterRows(1, 20, 'centroid-1-vs-29', 1));
  assert.equal(oneVsTwentyNine.applied, false);
  assert.equal(oneVsTwentyNine.fallbackReason, 'insufficient_cluster_data');

  const tenVsTwenty = evaluateClusterPromotion(clusterRows(8, 15, 'centroid-10-vs-20', 10));
  assert.equal(tenVsTwenty.applied, true);

  const zeroVsThirty = evaluateClusterPromotion(clusterRows(0, 20, 'centroid-0-vs-30', 0));
  assert.equal(zeroVsThirty.applied, false);
  assert.equal(zeroVsThirty.fallbackReason, 'insufficient_cluster_data');

  const stableKeySplit = evaluateClusterPromotion([
    ...clusterRows(12, 15, 'centroid-a'),
    ...clusterRows(12, 15, 'centroid-b'),
  ]);
  assert.equal(stableKeySplit.clusters.length, 2, 'same display cluster ID must not merge different centroids');

  const legacyRows = clusterRows(12, 15).map(({ cluster_algorithm_version, centroid_hash, ...row }) => row);
  const legacy = evaluateClusterPromotion(legacyRows);
  assert.equal(legacy.applied, false);
  assert.equal(legacy.fallbackReason, 'insufficient_cluster_data');

  const signatureMismatchRows = clusterRows(12, 15);
  signatureMismatchRows[0] = { ...signatureMismatchRows[0], signature_key: 'v1:other-embed:2:2' };
  const signatureMismatch = evaluateClusterPromotion(signatureMismatchRows);
  assert.equal(signatureMismatch.applied, false);
  assert.equal(signatureMismatch.fallbackReason, 'insufficient_cluster_data');
  assert.equal(signatureMismatch.clusters.length, 2);

  const offPool = mockPgPool(clusterRows(12, 15));
  const off = await runLlmAutoRoutingPromotionEvaluation({ env: {}, pgPool: offPool });
  assert.equal(off.promotionEligible, true);
  assert.equal(off.clusterEvaluation, undefined);
  assert.equal(offPool.calls.some((sql) => sql.includes("cluster_recommendation,cluster_id")), false);

  const insufficientPool = mockPgPool(clusterRows(1, 1).slice(0, 5));
  const insufficient = await runLlmAutoRoutingPromotionEvaluation({
    env: { LLM_CLUSTER_PROMOTION_EVALUATION_ENABLED: 'true' },
    pgPool: insufficientPool,
  });
  assert.equal(insufficient.promotionEligible, true, 'insufficient cluster data must preserve baseline decision');
  assert(insufficient.clusterEvaluation);
  assert.equal(insufficient.clusterEvaluation.applied, false);
  assert.equal(insufficient.clusterEvaluation.fallbackReason, 'insufficient_cluster_data');

  const integratedPool = mockPgPool(clusterRows(12, 15));
  const integrated = await runLlmAutoRoutingPromotionEvaluation({
    env: { LLM_CLUSTER_PROMOTION_EVALUATION_ENABLED: 'true' },
    pgPool: integratedPool,
  });
  assert(integrated.clusterEvaluation);
  assert.equal(integrated.clusterEvaluation.applied, true);
  assert.equal(integrated.promotionEligible, false);
  assert.equal(integrated.blockers.some((blocker) => blocker.includes('cluster-1-of-2')), true);
  assert.equal(integrated.nextStep.includes('launchctl'), false);

  console.log(JSON.stringify({ ok: true, smoke: 'llm-auto-routing-promotion-cluster', checks: 29 }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
