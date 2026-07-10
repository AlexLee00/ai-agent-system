#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import {
  buildVaultKnowledgeGraph,
  fetchVaultKnowledgeGraphReport,
  queryRecordsByEntity,
} from '../vault/vault-knowledge-graph.js';

const fixtures = [
  {
    id: 'record-1',
    title: 'OpenAI SEO lesson',
    type: 'library_record',
    source: 'blo',
    tags: ['sigma-library', 'blog', 'topic:seo', 'entity:openai'],
    meta: { team: 'blog', agent: 'maestro', entities: ['OpenAI'], insight: 'SEO lesson' },
  },
  {
    id: 'record-2',
    title: 'OpenAI editorial outcome',
    type: 'auto_dev_outcome',
    source: 'blog',
    tags: ['blog', 'theme:editorial'],
    meta: { team: 'blog', agent: 'writer', entity: 'OpenAI', success: true },
  },
  {
    id: 'record-3',
    title: 'Darwin routing finding',
    type: 'refactor_outcome',
    source: 'darwin',
    tags: ['darwin', 'routing'],
    meta: { team: 'darwin', agent: 'evaluator', entities: ['Hub'], lesson: 'routing contract' },
  },
];

async function main() {
  const graph = buildVaultKnowledgeGraph(fixtures);
  assert.equal(graph.records.length, 3);
  assert(graph.nodes.some((node) => node.type === 'team_agent' && node.id === 'team:blog'));
  assert(graph.nodes.some((node) => node.type === 'record' && node.id === 'record:record-1'));
  assert(graph.nodes.some((node) => node.type === 'topic_theme' && node.id === 'topic:seo'));
  assert(graph.nodes.some((node) => node.type === 'entity' && node.id === 'entity:openai'));

  const openAiRecords = queryRecordsByEntity(graph, 'OpenAI');
  assert.deepEqual(openAiRecords.map((record) => record.id).sort(), ['record-1', 'record-2']);
  assert.equal(graph.edges.some((edge) => edge.relationship === 'produced_by'), true);
  assert.equal(graph.edges.some((edge) => edge.relationship === 'about'), true);
  assert.equal(graph.edges.some((edge) => edge.relationship === 'mentions'), true);

  let queryCalls = 0;
  const off = await fetchVaultKnowledgeGraphReport({
    env: {},
    queryReadonly: async () => {
      queryCalls += 1;
      return fixtures;
    },
  });
  assert.equal(off.skipped, true);
  assert.equal(queryCalls, 0);

  const on = await fetchVaultKnowledgeGraphReport({
    env: { SIGMA_VAULT_KNOWLEDGE_GRAPH_REPORT_ENABLED: 'true' },
    entity: 'OpenAI',
    queryReadonly: async (_schema, sql) => {
      queryCalls += 1;
      assert.match(sql, /^\s*SELECT\b/i);
      assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);
      return fixtures;
    },
  });
  assert.equal(on.skipped, false);
  assert.equal(queryCalls, 1);
  assert.equal(on.query?.records.length, 2);
  assert.equal(on.safety.writes, false);
  assert.equal(on.safety.ddlRequired, false);

  console.log('sigma-vault-knowledge-graph-smoke ok');
}

main().catch((error) => {
  console.error(`sigma-vault-knowledge-graph-smoke failed: ${error?.message || error}`);
  process.exit(1);
});
