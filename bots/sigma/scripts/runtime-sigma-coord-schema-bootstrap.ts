#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const pgPool = require(path.join(repoRoot, 'packages/core/lib/pg-pool.ts'));
const MIGRATION_PATH = path.join(__dirname, '../migrations/20260703000001_sigma_coord_schema.sql');

export const SIGMA_COORD_COLUMNS = [
  'abstraction_level',
  'time_stage',
  'validation_state',
  'prediction_state',
  'prediction_horizon',
];

export const SIGMA_COORD_CONSTRAINTS = [
  'vault_entries_abstraction_level_coord_check',
  'vault_entries_time_stage_coord_check',
  'vault_entries_validation_state_coord_check',
  'vault_entries_prediction_state_coord_check',
];

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

export async function inspectSigmaCoordSchema({ queryReadonly = pgPool.queryReadonly } = {}) {
  const [columnRows, constraintRows] = await Promise.all([
    queryReadonly('sigma', `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'sigma'
        AND table_name = 'vault_entries'
        AND column_name = ANY($1::text[])
    `, [SIGMA_COORD_COLUMNS]),
    queryReadonly('sigma', `
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'sigma.vault_entries'::regclass
        AND conname = ANY($1::text[])
    `, [SIGMA_COORD_CONSTRAINTS]),
  ]);
  const columns = new Set(columnRows.map((row) => row.column_name));
  const constraints = new Set(constraintRows.map((row) => row.conname));
  return {
    columns: SIGMA_COORD_COLUMNS.map((name) => ({ name, exists: columns.has(name) })),
    constraints: SIGMA_COORD_CONSTRAINTS.map((name) => ({ name, exists: constraints.has(name) })),
    missingColumns: SIGMA_COORD_COLUMNS.filter((name) => !columns.has(name)),
    missingConstraints: SIGMA_COORD_CONSTRAINTS.filter((name) => !constraints.has(name)),
  };
}

export async function buildSigmaCoordSchemaBootstrapReport({ apply = false, queryReadonly = pgPool.queryReadonly, run = pgPool.run } = {}) {
  const before = await inspectSigmaCoordSchema({ queryReadonly });
  let applied = false;
  if (apply) {
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    await run('sigma', sql, []);
    applied = true;
  }
  const after = apply ? await inspectSigmaCoordSchema({ queryReadonly }) : before;
  return {
    ok: true,
    source: 'sigma_coord_schema_bootstrap',
    checkedAt: new Date().toISOString(),
    dryRun: !apply,
    liveMutation: apply,
    migrationPath: MIGRATION_PATH,
    applied,
    before,
    after,
    ready: after.missingColumns.length === 0 && after.missingConstraints.length === 0,
  };
}

async function main() {
  const report = await buildSigmaCoordSchemaBootstrapReport({ apply: hasFlag('apply') });
  if (hasFlag('json')) console.log(JSON.stringify(report, null, 2));
  else console.log(`[sigma-coord-schema-bootstrap] ready=${report.ready} dryRun=${report.dryRun}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[sigma-coord-schema-bootstrap] failed: ${error?.message || error}`);
    process.exit(1);
  });
}
