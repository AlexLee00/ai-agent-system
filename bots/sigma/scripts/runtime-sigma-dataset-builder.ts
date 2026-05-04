import { buildDatasetPlan, writeDatasetPlan } from '../ts/lib/dataset-builder.js';

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

const plan = buildDatasetPlan({
  dryRun,
  weekLabel: argValue('--week'),
  outDir: argValue('--out'),
  masterApprovedExternalExport: hasArg('--master-approved-export'),
});

const written = writeDatasetPlan(plan);

console.log(JSON.stringify({
  ...plan,
  written,
  applyBlocked: apply && dryRun ? 'confirm_required:sigma-dataset-builder-apply' : null,
}, null, 2));
