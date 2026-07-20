#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import {
  ONTOLOGY_ACTION_TYPES,
  ONTOLOGY_OBJECT_TYPES,
  ONTOLOGY_REGISTRY_JSON_SCHEMA,
} from '../../../packages/core/lib/ontology-registry.js';
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
    meta: {
      team: 'darwin',
      agent: 'evaluator',
      entities: ['Hub'],
      lesson: 'routing contract',
      source_refs: [{ team: 'luna', table: 'trade_journal', id: '42' }],
    },
  },
  {
    id: 'record-4',
    title: 'BTC position snapshot',
    type: 'position',
    source: 'luna',
    meta: { objectType: 'position', entities: ['BTC'] },
  },
];

async function main() {
  const objectTypeIds = ONTOLOGY_OBJECT_TYPES.map(({ id }) => id).sort();
  assert.deepEqual(objectTypeIds, [
    'alarm',
    'brief',
    'gate',
    'position',
    'prediction',
    'report',
    'task',
  ]);
  const actionTypeIds = ONTOLOGY_ACTION_TYPES.map(({ id }) => id).sort();
  assert.deepEqual(actionTypeIds, [
    'alarm.resolve',
    'brief.publish',
    'gate.evaluate',
    'prediction.evaluate',
    'report.publish',
    'task.report_progress',
  ]);
  assert.equal(ONTOLOGY_REGISTRY_JSON_SCHEMA.type, 'object');
  assert.deepEqual(ONTOLOGY_REGISTRY_JSON_SCHEMA.required, ['version', 'objectTypes', 'actionTypes']);
  assert.deepEqual(
    [...ONTOLOGY_REGISTRY_JSON_SCHEMA.properties.objectTypes.items.properties.id.enum].sort(),
    objectTypeIds,
  );
  assert.deepEqual(
    [...ONTOLOGY_REGISTRY_JSON_SCHEMA.properties.actionTypes.items.properties.id.enum].sort(),
    actionTypeIds,
  );
  assert(ONTOLOGY_ACTION_TYPES.every(({ objectType }) => objectTypeIds.includes(objectType)));

  const graph = buildVaultKnowledgeGraph(fixtures);
  assert.equal(graph.records.length, 4);
  assert(graph.nodes.some((node) => node.type === 'team_agent' && node.id === 'team:blog'));
  assert(graph.nodes.some((node) => node.type === 'record' && node.id === 'record:record-1'));
  assert(graph.nodes.some((node) => node.type === 'topic_theme' && node.id === 'topic:seo'));
  assert(graph.nodes.some((node) => node.type === 'entity' && node.id === 'entity:openai'));
  assert(graph.nodes.some((node) => node.type === 'entity' && node.id === 'entity:trade-journal'));
  assert.deepEqual(
    graph.nodes.filter((node) => node.type === 'object_type' && node.id !== 'object-type:root').map((node) => node.id).sort(),
    objectTypeIds.map((id) => `object-type:${id}`).sort(),
  );
  assert(graph.nodes.some((node) => node.type === 'object_type' && node.id === 'object-type:position'));
  assert.equal(graph.edges.some((edge) => (
    edge.source === 'record:record-4'
      && edge.target === 'object-type:position'
      && edge.relationship === 'instance_of'
  )), true);
  assert.equal(graph.edges.some((edge) => (
    edge.source === 'object-type:position'
      && edge.target === 'object-type:root'
      && edge.relationship === 'subtype_of'
  )), true);
  assert.deepEqual(queryRecordsByEntity(graph, 'trade_journal').map((record) => record.id), ['record-3']);

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
      assert.match(sql, /meta->>'merged_into'\) IS NULL/);
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
