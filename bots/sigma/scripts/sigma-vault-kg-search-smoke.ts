#!/usr/bin/env node

import assert from 'node:assert/strict';
import { searchVault } from '../vault/vault-search.js';
import { buildVaultKnowledgeGraph, queryRelatedRecordsFromSeeds } from '../vault/vault-knowledge-graph.js';

const vectorRows = [
  {
    id: 'vector-1',
    title: '벡터 검색 결과',
    source: 'sigma',
    content_preview: '기존 검색 결과',
    meta: { entities: ['OpenAI'] },
    similarity: 0.91,
  },
];

const graphRows = [
  {
    id: 'graph-1',
    title: 'A OpenAI related record',
    type: 'knowledge_entry',
    source: 'sigma',
    tags: [],
    content_preview: 'OpenAI 관련 직접 기록',
    meta: { vaultTier: 'knowledge', entities: ['OpenAI'] },
  },
  {
    id: 'graph-bridge',
    title: 'B OpenAI bridge record',
    type: 'knowledge_entry',
    source: 'sigma',
    tags: [],
    content_preview: '공유 주제로 연결된 기록',
    meta: { vaultTier: 'knowledge', entities: ['OpenAI', 'Agents'] },
  },
  {
    id: 'graph-2',
    title: 'Agents two-hop record',
    type: 'knowledge_entry',
    source: 'sigma',
    tags: [],
    content_preview: '2-hop only',
    meta: { vaultTier: 'knowledge', entities: ['Agents'] },
  },
  {
    id: 'graph-low',
    title: 'Low confidence source-ref record',
    type: 'knowledge_entry',
    source: 'sigma',
    tags: [],
    content_preview: 'low confidence only',
    meta: { vaultTier: 'knowledge', source_refs: [{ table: 'OpenAI' }] },
  },
  {
    id: 'graph-noise',
    title: 'Same-source unrelated record',
    type: 'knowledge_entry',
    source: 'sigma',
    tags: ['topic:Gardening'],
    content_preview: 'same source is not a semantic relation',
    meta: { vaultTier: 'knowledge' },
  },
];

function mockDeps({ enabled, graphFailure = false }: { enabled: boolean; graphFailure?: boolean }) {
  const calls: Array<{ schema: string; sql: string; params: unknown[] }> = [];
  return {
    calls,
    env: { SIGMA_KG_SEARCH_ENABLED: enabled ? 'true' : 'false' },
    embeddingFactory: async () => ({ embedding: [0.1, 0.2, 0.3], dim: 3 }),
    queryReadonly: async (schema: string, sql: string, params: unknown[] = []) => {
      calls.push({ schema, sql, params });
      assert.equal(schema, 'sigma');
      assert.equal(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i.test(sql), false);
      if (String(sql).includes('FROM sigma.vault_entries') && !String(sql).includes('embedding <=>')) {
        if (graphFailure) throw new Error('missing_graph_source');
        assert.match(sql, /meta->>'merged_into'\) IS NULL/);
        return graphRows;
      }
      if (String(sql).includes('FROM sigma.vault_entries')) {
        assert.match(sql, /meta->>'merged_into'\) IS NULL/);
      }
      return vectorRows;
    },
  };
}

async function main() {
  const offDeps = mockDeps({ enabled: true });
  const off = await searchVault('OpenAI', { graphExpansionEnabled: false, deps: offDeps });
  assert.equal(off.ok, true);
  assert.deepEqual(off.results.map((row) => row.id), ['vector-1']);
  assert.equal(off.knowledgeGraph, undefined);
  assert.equal(offDeps.calls.length, 1, 'gate off must not issue a graph query');

  const onDeps = mockDeps({ enabled: false });
  const on = await searchVault('OpenAI', { graphExpansionEnabled: true, deps: onDeps });
  assert.equal(on.ok, true);
  assert.deepEqual(on.results.map((row) => row.id), ['vector-1'], 'vector order must not change');
  assert.deepEqual(on.results, off.results, 'graph expansion must not alter or reduce base retrieval');
  assert(on.knowledgeGraph);
  assert.equal(on.knowledgeGraph.enabled, true);
  assert.equal(on.knowledgeGraph.maxHops, 1);
  assert.equal(on.knowledgeGraph.confidenceThreshold, 0.8);
  assert.deepEqual(on.knowledgeGraph.seedEntities, ['openai']);
  assert.deepEqual(on.knowledgeGraph.results.map((row) => [row.id, row.hop]), [
    ['graph-1', 1],
    ['graph-bridge', 1],
  ]);
  assert.equal(on.knowledgeGraph.results[0].confidence, 0.9);
  assert.equal(on.knowledgeGraph.results.some((row) => row.id === 'graph-2'), false, 'two-hop records must not be returned');
  assert.equal(on.knowledgeGraph.results.some((row) => row.id === 'graph-low'), false, 'low-confidence relation must not add noise');
  assert.equal(on.knowledgeGraph.results.some((row) => row.id === 'graph-noise'), false, 'same source alone must not create a relation');

  const layerCalls: Array<{ schema: string; sql: string; params: unknown[] }> = [];
  const layerScoped = await searchVault('OpenAI evidence', {
    topK: 1,
    intent: 'evidence',
    layerSearchEnabled: true,
    graphExpansionEnabled: true,
    deps: {
      env: {},
      embeddingFactory: async () => ({ embedding: [0.1, 0.2, 0.3], dim: 3 }),
      queryReadonly: async (schema: string, sql: string, params: unknown[] = []) => {
        layerCalls.push({ schema, sql, params });
        if (sql.includes('information_schema.columns')) {
          return ['abstraction_level', 'time_stage'].map((column_name) => ({ column_name }));
        }
        if (sql.includes('embedding <=>')) {
          return [{ ...vectorRows[0], abstraction_level: 'L0', time_stage: 'raw' }];
        }
        assert.match(sql, /abstraction_level/);
        assert.match(sql, /time_stage/);
        return [{
          ...graphRows[0],
          id: 'graph-physical-in',
          abstraction_level: 'L0',
          time_stage: 'raw',
        }, {
          ...graphRows[1],
          id: 'graph-physical-out',
          abstraction_level: 'L2',
          time_stage: 'digest',
        }];
      },
    },
  });
  assert.equal(layerScoped.ok, true);
  assert.deepEqual(layerScoped.knowledgeGraph?.results.map((row) => row.id), ['graph-physical-in']);
  assert.equal(layerCalls.length, 3, 'layer graph search must detect columns, search directly, then load scoped candidates');

  const highDegreeEntries = [
    { id: 'seed', title: 'seed', type: 'knowledge_entry', meta: { entities: ['OpenAI'] } },
    ...Array.from({ length: 12 }, (_value, index) => ({
      id: `degree-${index}`,
      title: `OpenAI ${index}`,
      type: 'knowledge_entry',
      meta: { entities: ['OpenAI'] },
    })),
  ];
  const highDegree = queryRelatedRecordsFromSeeds(buildVaultKnowledgeGraph(highDegreeEntries), ['seed'], {
    maxHops: 1,
    minConfidence: 0.8,
    maxConceptDegree: 12,
    limit: 3,
  });
  assert.deepEqual(highDegree.records, [], 'high-degree concepts must fail closed instead of becoming super-hubs');

  const noSeeds = queryRelatedRecordsFromSeeds(buildVaultKnowledgeGraph([{
    id: 'plain',
    title: 'No structured concepts',
    type: 'knowledge_entry',
    meta: {},
  }]), ['plain'], { maxHops: 1, minConfidence: 0.8, maxConceptDegree: 12, limit: 3 });
  assert.deepEqual(noSeeds.records, [], 'records without structured concepts must not fall back to raw text tokens');

  const fallbackDeps = mockDeps({ enabled: true, graphFailure: true });
  const fallback = await searchVault('OpenAI', { graphExpansionEnabled: true, deps: fallbackDeps });
  assert.equal(fallback.ok, true);
  assert.deepEqual(fallback.results.map((row) => row.id), ['vector-1']);
  assert(fallback.knowledgeGraph);
  assert.deepEqual(fallback.knowledgeGraph.results, []);
  assert.match(String(fallback.knowledgeGraph.warning), /^kg_search_unavailable:/);

  const shapedCalls: Array<{ schema: string; sql: string; params: unknown[] }> = [];
  const shaped = await searchVault('SSR SEO', {
    topK: 3,
    sourceKinds: ['blo'],
    types: ['blog_post'],
    sourceRefIds: ['61', '62'],
    groupBySourceRef: true,
    layerSearchEnabled: false,
    deps: {
      env: {},
      embeddingFactory: async () => ({ embedding: [0.1, 0.2, 0.3], dim: 3 }),
      queryReadonly: async (schema: string, sql: string, params: unknown[] = []) => {
        shapedCalls.push({ schema, sql, params });
        return vectorRows;
      },
    },
  });
  assert.equal(shaped.ok, true);
  assert.equal(shapedCalls.length, 1);
  assert.match(shapedCalls[0].sql, /type = ANY/);
  assert.match(shapedCalls[0].sql, /meta->>'sourceId'/);
  assert.match(shapedCalls[0].sql, /meta->'source_ref'->>'id'/);
  assert.match(shapedCalls[0].sql, /meta->'source_refs'/);
  assert.match(shapedCalls[0].sql, /meta->'source_ref'->>'team'/);
  assert.match(shapedCalls[0].sql, /meta->'source_ref'->>'table'/);
  assert.match(shapedCalls[0].sql, /ROW_NUMBER\(\) OVER/i);
  assert.deepEqual(shapedCalls[0].params.slice(1, 4), [['blo'], ['blog_post'], ['61', '62']]);

  console.log(JSON.stringify({ ok: true, smoke: 'sigma-vault-kg-search', checks: 37 }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
