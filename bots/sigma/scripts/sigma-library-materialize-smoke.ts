import assert from 'node:assert/strict';
import {
  buildDatasetPlan,
  persistDatasetMetadata,
} from '../ts/lib/dataset-builder.js';
import {
  buildKnowledgeGraphPersistPlan,
  buildKnowledgeGraphSnapshot,
  persistKnowledgeGraphPlan,
} from '../ts/lib/knowledge-graph.js';
import {
  buildFixtureLibraryRecords,
  collectLibraryPersistenceMetrics,
} from '../ts/lib/library-data-source.js';

const before = await collectLibraryPersistenceMetrics();
const records = buildFixtureLibraryRecords();
const snapshot = buildKnowledgeGraphSnapshot(records.map((record) => record.piiRedactedText));
const graphDryPlan = buildKnowledgeGraphPersistPlan(snapshot, { dryRun: true });
const graphDry = await persistKnowledgeGraphPlan(graphDryPlan);
assert.equal(graphDry.dryRun, true);
assert.equal(graphDry.insertedOrUpdated, 0);

const graphConfirmMissingPlan = buildKnowledgeGraphPersistPlan(snapshot, { dryRun: false });
const graphConfirmMissing = await persistKnowledgeGraphPlan(graphConfirmMissingPlan);
assert.equal(graphConfirmMissing.dryRun, true);
assert.ok(graphConfirmMissing.warnings.includes('confirm_required:sigma-knowledge-graph-apply'));

const datasetPlan = buildDatasetPlan({
  dryRun: true,
  weekLabel: '2026w19-smoke',
  records,
});
const datasetDry = await persistDatasetMetadata(datasetPlan);
assert.equal(datasetDry.dryRun, true);
assert.equal(datasetDry.lineageRows, 0);
assert.ok(datasetPlan.artifacts.some((artifact) => artifact.rows.length > 0));
assert.equal(datasetPlan.artifacts.every((artifact) => !artifact.exportAllowed), true);

const datasetConfirmMissing = await persistDatasetMetadata({
  ...datasetPlan,
  dryRun: false,
});
assert.equal(datasetConfirmMissing.dryRun, true);
assert.ok(datasetConfirmMissing.warnings.includes('confirm_required:sigma-dataset-builder-apply'));

const after = await collectLibraryPersistenceMetrics();
assert.deepEqual(
  {
    entityRelationships: after.entityRelationships,
    dataLineage: after.dataLineage,
    datasetSnapshots: after.datasetSnapshots,
  },
  {
    entityRelationships: before.entityRelationships,
    dataLineage: before.dataLineage,
    datasetSnapshots: before.datasetSnapshots,
  },
  'dry-run materialization smoke must not mutate persistence counts',
);

console.log(JSON.stringify({
  ok: true,
  status: 'sigma_library_materialize_smoke_passed',
  graphRows: graphDryPlan.rows.length,
  datasetRows: datasetPlan.artifacts.reduce((sum, artifact) => sum + artifact.rows.length, 0),
  persistenceCounts: after,
}, null, 2));
