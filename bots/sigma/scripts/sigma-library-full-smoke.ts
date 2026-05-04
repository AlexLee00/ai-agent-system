import assert from 'node:assert/strict';
import { createTeamMemory, injectTeamMemory } from '../ts/lib/team-memory-adapter.js';
import { buildDatasetPlan } from '../ts/lib/dataset-builder.js';
import { buildKnowledgeGraphPersistPlan, buildKnowledgeGraphSnapshot } from '../ts/lib/knowledge-graph.js';
import { assessSelfRag, buildHydePlan, buildMultiHopPlan } from '../ts/lib/rag-advanced.js';
import { buildMonthlySelfImprovementFixture, buildSelfImprovementPlan } from '../ts/lib/self-improvement-pipeline.js';

function boolEnv(name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] ?? '').toLowerCase());
}

const disabledMemory = createTeamMemory('blog', 'blo');
assert.deepEqual(await disabledMemory.getShortTerm(), []);
assert.equal(
  await injectTeamMemory('base prompt', 'blog', 'blo', { query: 'blog topic quality' }),
  'base prompt',
);

const graph = buildKnowledgeGraphSnapshot([
  'Luna reconcile incident teaches Sigma library lineage',
  'Blog publish queue incident links to Hub alarm repair',
]);
assert.ok(graph.nodes.length >= 8);
assert.ok(graph.edges.length >= 6);
assert.ok(graph.communities.length >= 1);

const persistPlan = buildKnowledgeGraphPersistPlan(graph);
assert.equal(persistPlan.dryRun, true);
assert.ok(persistPlan.ddl.some((sql) => sql.includes('sigma.entity_relationships')));
assert.equal(persistPlan.rows.length, graph.edges.length);

const hyde = buildHydePlan('Luna reconcile lineage');
assert.equal(hyde.enabled, boolEnv('SIGMA_HYDE_ENABLED'));
assert.equal(hyde.providerCallRequired, false);
assert.ok(hyde.hypotheticalDocument.includes('Luna reconcile lineage'));

const multiHop = buildMultiHopPlan({
  query: 'incident repair lineage',
  seedEntity: graph.nodes[0].id,
  edges: graph.edges,
  hops: 2,
});
assert.equal(multiHop.enabled, boolEnv('SIGMA_MULTI_HOP_RAG_ENABLED'));
assert.ok(multiHop.collections.includes('rag_trades'));

const selfRag = assessSelfRag({
  query: 'Luna reconcile lineage',
  retrievedContexts: boolEnv('SIGMA_SELF_RAG_ENABLED')
    ? []
    : ['Luna reconcile incident teaches Sigma library lineage'],
});
assert.equal(selfRag.answerPolicy, boolEnv('SIGMA_SELF_RAG_ENABLED') ? 'retrieve_more' : 'answer');

const datasetPlan = buildDatasetPlan({ weekLabel: '2026w18', dryRun: true });
assert.equal(datasetPlan.dryRun, true);
assert.equal(datasetPlan.artifacts.length, 18);
assert.ok(datasetPlan.artifacts.every((artifact) => artifact.files.readme.endsWith('README.md')));
assert.ok(datasetPlan.warnings.some((warning) => warning.includes('external_dataset_export_requires_master_approval')));

const improvementPlan = buildSelfImprovementPlan(buildMonthlySelfImprovementFixture());
assert.equal(improvementPlan.dryRun, true);
assert.equal(improvementPlan.promptCandidates.length, 1);
assert.equal(improvementPlan.skillCandidates.length, 2);
assert.equal(improvementPlan.fineTuneCandidate.ready, false);

console.log(JSON.stringify({
  ok: true,
  status: 'sigma_library_full_smoke_passed',
  graph: {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    communities: graph.communities.length,
  },
  datasets: datasetPlan.artifacts.length,
  promptCandidates: improvementPlan.promptCandidates.length,
  skillCandidates: improvementPlan.skillCandidates.length,
  hydeEnabled: hyde.enabled,
  selfRagPolicy: selfRag.answerPolicy,
}, null, 2));
