import assert from 'node:assert/strict';
import { buildKnowledgeGraphSnapshot } from '../ts/lib/knowledge-graph.js';
import {
  assessSelfRag,
  runSelfRagPipeline,
} from '../ts/lib/rag-advanced.js';
import { buildFixtureLibraryRecords } from '../ts/lib/library-data-source.js';

const records = buildFixtureLibraryRecords();
const graph = buildKnowledgeGraphSnapshot(records.map((record) => record.piiRedactedText));

const answered = await runSelfRagPipeline({
  query: 'Luna reflexion lineage',
  records,
  graphEdges: graph.edges,
  enabled: true,
});
assert.equal(answered.policy, 'answer');
assert.ok(answered.evidence.length > 0);
assert.ok(answered.hyde.hypotheticalDocument.includes('Luna reflexion lineage'));

const noEvidence = await runSelfRagPipeline({
  query: 'completely-unmatched-query-token',
  records,
  graphEdges: graph.edges,
  enabled: true,
});
assert.equal(noEvidence.policy, 'abstain');
assert.equal(noEvidence.evidence.length, 0);

const retrieveMore = assessSelfRag({
  query: 'market graph lineage',
  retrievedContexts: [],
  enabled: true,
});
assert.equal(retrieveMore.answerPolicy, 'retrieve_more');

console.log(JSON.stringify({
  ok: true,
  status: 'sigma_self_rag_pipeline_smoke_passed',
  answeredEvidence: answered.evidence.length,
  noEvidencePolicy: noEvidence.policy,
  retrieveMorePolicy: retrieveMore.answerPolicy,
}, null, 2));
