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
  collectLibraryPersistenceMetrics,
  collectLibraryRecords,
} from '../ts/lib/library-data-source.js';

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const apply = hasArg('--apply');
const confirm = argValue('--confirm');
const dryRun = !(apply && confirm === 'sigma-library-materialize');
const sinceHours = Number(argValue('--since-hours') ?? 24 * 7);
const limitPerSource = Number(argValue('--limit-per-source') ?? 120);
const weekLabel = argValue('--week');

const sourceReport = await collectLibraryRecords({ sinceHours, limitPerSource });
const texts = sourceReport.records.map((record) => record.piiRedactedText).filter(Boolean);
const graphSnapshot = buildKnowledgeGraphSnapshot(texts);
const graphPlan = buildKnowledgeGraphPersistPlan(graphSnapshot, { dryRun });
const datasetPlan = buildDatasetPlan({
  dryRun,
  weekLabel,
  records: sourceReport.records,
  masterApprovedExternalExport: false,
});

const [graphPersisted, datasetPersisted] = await Promise.all([
  persistKnowledgeGraphPlan(graphPlan, {
    confirm: dryRun ? undefined : 'sigma-knowledge-graph-apply',
  }),
  persistDatasetMetadata(datasetPlan, {
    confirm: dryRun ? undefined : 'sigma-dataset-builder-apply',
  }),
]);
const metrics = await collectLibraryPersistenceMetrics();

const warnings = [
  ...sourceReport.warnings.map((warning) => `source:${warning}`),
  ...graphPersisted.warnings.map((warning) => `graph:${warning}`),
  ...datasetPersisted.warnings.map((warning) => `dataset:${warning}`),
];

console.log(JSON.stringify({
  ok: graphPersisted.ok && datasetPersisted.ok,
  status: dryRun ? 'sigma_library_materialize_dry_run_ready' : 'sigma_library_materialize_apply_complete',
  dryRun,
  source: sourceReport.stats,
  graph: {
    nodes: graphSnapshot.nodes.length,
    edges: graphSnapshot.edges.length,
    rows: graphPlan.rows.length,
    persisted: graphPersisted,
  },
  dataset: {
    weekLabel: datasetPlan.weekLabel,
    artifacts: datasetPlan.artifacts.length,
    rows: datasetPlan.artifacts.reduce((sum, artifact) => sum + artifact.rows.length, 0),
    lineageRows: datasetPlan.artifacts.reduce((sum, artifact) => sum + artifact.lineageRecords.length, 0),
    parquetReady: false,
    externalExportBlocked: datasetPlan.artifacts.every((artifact) => !artifact.exportAllowed),
    persisted: datasetPersisted,
  },
  metrics,
  applyBlocked: apply && dryRun ? 'confirm_required:sigma-library-materialize' : null,
  warnings,
}, null, 2));
