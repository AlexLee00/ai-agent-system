import assert from 'node:assert/strict';
import {
  buildKnowledgeGraphPersistPlan,
  buildKnowledgeGraphSnapshot,
  persistKnowledgeGraphPlan,
} from '../ts/lib/knowledge-graph.js';
import { buildFixtureLibraryRecords } from '../ts/lib/library-data-source.js';

const records = buildFixtureLibraryRecords();
const snapshot = buildKnowledgeGraphSnapshot(records.map((record) => record.piiRedactedText));
assert.ok(snapshot.nodes.length > 0);
assert.ok(snapshot.edges.length > 0);

const dryRunPlan = buildKnowledgeGraphPersistPlan(snapshot, { dryRun: true });
const dryRunResult = await persistKnowledgeGraphPlan(dryRunPlan);
assert.equal(dryRunResult.dryRun, true);
assert.equal(dryRunResult.insertedOrUpdated, 0);
assert.equal(dryRunResult.skipped, dryRunPlan.rows.length);

const blockedPlan = buildKnowledgeGraphPersistPlan(snapshot, { dryRun: false });
const blockedResult = await persistKnowledgeGraphPlan(blockedPlan);
assert.equal(blockedResult.dryRun, true);
assert.ok(blockedResult.warnings.includes('confirm_required:sigma-knowledge-graph-apply'));

const keys = new Set(blockedPlan.rows.map((row) => `${row.source_entity}:${row.target_entity}:${row.relationship_type}`));
assert.equal(keys.size, blockedPlan.rows.length);

console.log(JSON.stringify({
  ok: true,
  status: 'sigma_knowledge_graph_persistence_smoke_passed',
  nodes: snapshot.nodes.length,
  rows: blockedPlan.rows.length,
  dryRunNoWrite: dryRunResult.insertedOrUpdated === 0,
}, null, 2));
