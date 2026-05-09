import assert from 'node:assert/strict';
import {
  buildSelfImprovementSignalsFromRecords,
  buildFixtureLibraryRecords,
  collectLibraryPersistenceMetrics,
} from '../ts/lib/library-data-source.js';
import { createDashboardSummary } from '../ts/lib/intelligent-library.js';

const records = buildFixtureLibraryRecords();
const summary = createDashboardSummary({
  texts: records.map((record) => record.piiRedactedText),
  signals: buildSelfImprovementSignalsFromRecords(records),
});
const persistence = await collectLibraryPersistenceMetrics();

assert.equal(summary.ok, true);
assert.ok(summary.graph.nodes > 0);
assert.equal(typeof persistence.entityRelationships, 'number');
assert.equal(typeof persistence.dataLineage, 'number');
assert.equal(typeof persistence.datasetSnapshots, 'number');

console.log(JSON.stringify({
  ok: true,
  status: 'sigma_dashboard_real_metrics_smoke_passed',
  graphNodes: summary.graph.nodes,
  graphEdges: summary.graph.edges,
  persistence,
}, null, 2));
