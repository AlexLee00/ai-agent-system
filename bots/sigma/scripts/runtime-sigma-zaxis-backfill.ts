#!/usr/bin/env node
// @ts-nocheck

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { initialTimeStageFromAge, mergeLibraryCoords, rowsFromPg } from '../shared/zaxis.ts';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const pgPool = require(path.join(repoRoot, 'packages/core/lib/pg-pool.ts'));

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function valueArg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

export async function fetchZAxisBackfillRows({
  limit = 10_000,
  queryReadonly = pgPool.queryReadonly,
} = {}) {
  const rows = await queryReadonly('sigma', `
    SELECT id, title, source, created_at, meta, abstraction_level, time_stage, validation_state, prediction_state
    FROM sigma.vault_entries
    WHERE COALESCE(status, 'captured') <> 'archived'
      AND (
        abstraction_level IS NULL
        OR time_stage IS NULL
        OR validation_state IS NULL
        OR prediction_state IS NULL
      )
    ORDER BY created_at ASC, id ASC
    LIMIT $1
  `, [boundedInt(limit, 10_000, 1, 50_000)]);
  return rowsFromPg(rows);
}

export function buildZAxisBackfillPlan(rows = [], { now = new Date() } = {}) {
  return (rows || []).map((row) => {
    const patch = {
      abstraction_level: row.abstraction_level || 'L0',
      time_stage: row.time_stage || initialTimeStageFromAge(row.created_at, now),
      validation_state: row.validation_state || 'unverified',
      prediction_state: row.prediction_state || 'none',
    };
    return {
      id: row.id,
      title: row.title || null,
      source: row.source || null,
      createdAt: row.created_at || null,
      patch,
      meta: mergeLibraryCoords(row.meta, patch),
    };
  });
}

export async function applyZAxisBackfillPlan(plan = [], { pg = pgPool } = {}) {
  let applied = 0;
  for (const item of plan) {
    await pg.query('sigma', `
      UPDATE sigma.vault_entries
      SET abstraction_level = COALESCE(abstraction_level, $1),
          time_stage = COALESCE(time_stage, $2),
          validation_state = COALESCE(validation_state, $3),
          prediction_state = COALESCE(prediction_state, $4),
          meta = $5::jsonb,
          updated_at = NOW()
      WHERE id = $6
    `, [
      item.patch.abstraction_level,
      item.patch.time_stage,
      item.patch.validation_state,
      item.patch.prediction_state,
      JSON.stringify(item.meta),
      item.id,
    ]);
    await pg.query('sigma', `
      INSERT INTO sigma.vault_audit (entry_id, action, classifier, reasoning, applied, dry_run)
      VALUES ($1, 'tagged', 'rule', $2, true, false)
    `, [item.id, `sigma_zaxis_backfill:${JSON.stringify(item.patch)}`]).catch(() => []);
    applied += 1;
  }
  return { applied };
}

export async function buildZAxisBackfillReport(options = {}) {
  const rows = options.rows || await fetchZAxisBackfillRows({
    limit: options.limit || 10_000,
    queryReadonly: options.queryReadonly || pgPool.queryReadonly,
  });
  const plan = buildZAxisBackfillPlan(rows, { now: options.now || new Date() });
  const applyResult = options.apply ? await applyZAxisBackfillPlan(plan, { pg: options.pg || pgPool }) : null;
  const distribution = plan.reduce((acc, item) => {
    const key = item.patch.time_stage;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return {
    ok: true,
    source: 'sigma_zaxis_backfill',
    dryRun: options.apply !== true,
    liveMutation: Boolean(options.apply && applyResult?.applied > 0),
    generatedAt: new Date().toISOString(),
    counts: {
      candidates: rows.length,
      applied: applyResult?.applied || 0,
      distribution,
    },
    plan: plan.slice(0, options.planLimit || 50).map((item) => ({
      id: item.id,
      title: item.title,
      source: item.source,
      createdAt: item.createdAt,
      patch: item.patch,
    })),
    safety: {
      writesOnlySigmaTables: ['sigma.vault_entries', 'sigma.vault_audit'],
      defaultDryRun: true,
    },
  };
}

async function main() {
  const report = await buildZAxisBackfillReport({
    apply: hasFlag('apply'),
    limit: boundedInt(valueArg('limit'), 10_000, 1, 50_000),
  });
  if (hasFlag('json')) console.log(JSON.stringify(report, null, 2));
  else console.log(`[sigma-zaxis-backfill] candidates=${report.counts.candidates} dryRun=${report.dryRun}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[sigma-zaxis-backfill] failed: ${error?.message || error}`);
    process.exit(1);
  });
}
