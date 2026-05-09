import assert from 'node:assert/strict';
import {
  buildDatasetPlan,
  persistDatasetMetadata,
} from '../ts/lib/dataset-builder.js';
import { buildFixtureLibraryRecords } from '../ts/lib/library-data-source.js';

const records = buildFixtureLibraryRecords();
const plan = buildDatasetPlan({
  weekLabel: '2026w19',
  dryRun: true,
  records,
});

assert.equal(plan.dryRun, true);
assert.equal(plan.artifacts.length, 18);
assert.ok(plan.artifacts.some((artifact) => artifact.rows.length > 0));
assert.ok(plan.artifacts.every((artifact) => artifact.parquetReady === false));
assert.ok(plan.warnings.some((warning) => warning.includes('external_dataset_export_requires_master_approval')));

const activity = plan.artifacts.find((artifact) => artifact.card.dataset === 'luna_activity_weekly');
assert.ok(activity);
assert.ok(activity.rows.length > 0);
assert.ok(activity.lineageRecords.length > 0);

const persisted = await persistDatasetMetadata({ ...plan, dryRun: false });
assert.equal(persisted.dryRun, true);
assert.ok(persisted.warnings.includes('confirm_required:sigma-dataset-builder-apply'));

console.log(JSON.stringify({
  ok: true,
  status: 'sigma_dataset_real_row_smoke_passed',
  artifacts: plan.artifacts.length,
  totalRows: plan.artifacts.reduce((sum, artifact) => sum + artifact.rows.length, 0),
  externalExportBlocked: plan.warnings.length > 0,
}, null, 2));
