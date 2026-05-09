import { buildDatasetPlan, persistDatasetMetadata, writeDatasetPlan } from '../ts/lib/dataset-builder.js';
import { collectLibraryRecords } from '../ts/lib/library-data-source.js';

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const apply = hasArg('--apply');
const confirm = argValue('--confirm');
const dryRun = !(apply && confirm === 'sigma-dataset-builder-apply');
const verbose = hasArg('--verbose');
const sourceReport = await collectLibraryRecords({
  sinceHours: Number(argValue('--since-hours') ?? 24 * 7),
  limitPerSource: Number(argValue('--limit-per-source') ?? 80),
});

const plan = buildDatasetPlan({
  dryRun,
  weekLabel: argValue('--week'),
  outDir: argValue('--out'),
  masterApprovedExternalExport: hasArg('--master-approved-export'),
  records: sourceReport.records,
});

const written = writeDatasetPlan(plan);
const persisted = await persistDatasetMetadata(plan, { confirm });

const artifactSummary = plan.artifacts.map((artifact) => ({
  team: artifact.card.team,
  dataset: artifact.card.dataset,
  rows: artifact.rows.length,
  lineageRows: artifact.lineageRecords.length,
  contentHash: artifact.contentHash,
  exportAllowed: artifact.exportAllowed,
  exportReason: artifact.exportReason,
  parquetReady: artifact.parquetReady,
  files: artifact.files,
}));

console.log(JSON.stringify({
  ok: plan.ok,
  status: plan.status,
  dryRun: plan.dryRun,
  weekLabel: plan.weekLabel,
  artifacts: verbose ? plan.artifacts : artifactSummary,
  blockers: plan.blockers,
  warnings: plan.warnings,
  source: sourceReport.stats,
  sourceWarnings: sourceReport.warnings,
  written,
  persisted,
  applyBlocked: apply && dryRun ? 'confirm_required:sigma-dataset-builder-apply' : null,
}, null, 2));
