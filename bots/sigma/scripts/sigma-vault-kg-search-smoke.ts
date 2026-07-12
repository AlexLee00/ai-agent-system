#!/usr/bin/env node

import assert from 'node:assert/strict';
import { searchVault } from '../vault/vault-search.js';
import { buildVaultKnowledgeGraph, queryRelatedRecords } from '../vault/vault-knowledge-graph.js';

const vectorRows = [
  {
    id: 'vector-1',
    title: '벡터 검색 결과',
    source: 'sigma',
    content_preview: '기존 검색 결과',
    meta: {},
    similarity: 0.91,
  },
];

const graphRows = [
  {
    id: 'graph-1',
    title: 'OpenAI 직접 기록',
    type: 'knowledge_entry',
    source: 'claude',
    tags: ['topic:Agents'],
    content_preview: 'OpenAI 관련 직접 기록',
    meta: { vaultTier: 'knowledge', entities: ['OpenAI'] },
  },
  {
    id: 'graph-2',
    title: 'Agents 연관 기록',
    type: 'knowledge_entry',
    source: 'darwin',
    tags: ['topic:Agents'],
    content_preview: '공유 주제로 연결된 기록',
    meta: { vaultTier: 'knowledge' },
  },
  {
    id: 'graph-3',
    title: 'Claude 무관 기록',
    type: 'knowledge_entry',
    source: 'claude',
    tags: ['topic:Gardening'],
    content_preview: '같은 팀이지만 의미 관계가 없는 기록',
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
      if (String(sql).includes('type = ANY')) {
        if (graphFailure) throw new Error('missing_graph_source');
        return graphRows;
      }
      return vectorRows;
    },
  };
}

async function main() {
  const offDeps = mockDeps({ enabled: false });
  const off = await searchVault('OpenAI', { deps: offDeps });
  assert.equal(off.ok, true);
  assert.deepEqual(off.results.map((row) => row.id), ['vector-1']);
  assert.equal(off.knowledgeGraph, undefined);
  assert.equal(offDeps.calls.length, 1, 'gate off must not issue a graph query');

  const onDeps = mockDeps({ enabled: true });
  const on = await searchVault('OpenAI', { deps: onDeps });
  assert.equal(on.ok, true);
  assert.deepEqual(on.results.map((row) => row.id), ['vector-1'], 'vector order must not change');
  assert(on.knowledgeGraph);
  assert.equal(on.knowledgeGraph.enabled, true);
  assert.equal(on.knowledgeGraph.maxHops, 2);
  assert.deepEqual(on.knowledgeGraph.results.map((row) => [row.id, row.hop]), [
    ['graph-1', 1],
    ['graph-2', 2],
  ]);
  assert.equal(on.knowledgeGraph.results[0].confidence, 0.9);

  const teamDirect = queryRelatedRecords(buildVaultKnowledgeGraph(graphRows), 'claude', 2, 5);
  assert.equal(teamDirect.records.some(({ record, hop }) => record.id === 'graph-1' && hop === 1), true);
  assert.equal(teamDirect.records.some(({ record, hop }) => record.id === 'graph-3' && hop === 1), true);

  const capped = queryRelatedRecords(buildVaultKnowledgeGraph(Array.from({ length: 7 }, (_value, index) => ({
    id: `cap-${index}`,
    title: `OpenAI ${index}`,
    type: 'knowledge_entry',
    meta: { entities: ['OpenAI'] },
  }))), 'OpenAI', 2, 99);
  assert.equal(capped.records.length, 5, 'graph results must remain capped at five');

  const fallbackDeps = mockDeps({ enabled: true, graphFailure: true });
  const fallback = await searchVault('OpenAI', { deps: fallbackDeps });
  assert.equal(fallback.ok, true);
  assert.deepEqual(fallback.results.map((row) => row.id), ['vector-1']);
  assert(fallback.knowledgeGraph);
  assert.deepEqual(fallback.knowledgeGraph.results, []);
  assert.match(String(fallback.knowledgeGraph.warning), /^kg_search_unavailable:/);

  console.log(JSON.stringify({ ok: true, smoke: 'sigma-vault-kg-search', checks: 18 }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
