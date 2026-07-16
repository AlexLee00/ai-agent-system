#!/usr/bin/env node
// @ts-nocheck

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { nextDecayStage, normalizeTimeStage, recallStage, rowsFromPg } from '../shared/zaxis.ts';
import { fetchVaultTierReport, isVaultTierReportEnabled } from '../vault/vault-tiering.ts';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const pgPool = require(path.join(repoRoot, 'packages/core/lib/pg-pool.ts'));

const TOUCH_ACTIONS = ['searched', 'recalled', 'matched', 'used', 'retrieved'];

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

function stageExpr() {
  return `
    CASE COALESCE(time_stage, meta->'libraryCoords'->>'time_stage', 'raw')
      WHEN 'decayed' THEN 'dormant'
      ELSE COALESCE(time_stage, meta->'libraryCoords'->>'time_stage', 'raw')
    END
  `;
}

export async function fetchLibrarianCandidates({
  limit = 500,
  recallDays = 30,
  queryReadonly = pgPool.queryReadonly,
} = {}) {
  const boundedLimit = boundedInt(limit, 500, 1, 5000);
  const boundedRecallDays = boundedInt(recallDays, 30, 1, 3650);
  const stage = stageExpr();
  const [decayRows, recallRows] = await Promise.all([
    queryReadonly('sigma', `
      SELECT id, title, source, file_path, meta, created_at, ${stage} AS current_time_stage
      FROM sigma.vault_entries v
      WHERE COALESCE(status, 'captured') <> 'archived'
        AND (meta->>'merged_into') IS NULL
        AND ${stage} IN ('raw', 'digest', 'pattern', 'dormant')
        AND (
          (${stage} = 'raw' AND created_at < NOW() - INTERVAL '7 days')
          OR (${stage} = 'digest' AND created_at < NOW() - INTERVAL '30 days')
          OR (${stage} = 'pattern' AND created_at < NOW() - INTERVAL '90 days')
          OR (${stage} = 'dormant' AND created_at < NOW() - INTERVAL '180 days')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM sigma.vault_audit a
          WHERE a.entry_id = v.id
            AND a.created_at >= NOW() - ($1::int * INTERVAL '1 day')
            AND a.action = ANY($2::text[])
        )
      ORDER BY created_at ASC, id ASC
      LIMIT $3
    `, [boundedRecallDays, TOUCH_ACTIONS, boundedLimit]),
    queryReadonly('sigma', `
      SELECT id, title, source, file_path, meta, created_at, ${stage} AS current_time_stage
      FROM sigma.vault_entries v
      WHERE COALESCE(status, 'captured') <> 'archived'
        AND (meta->>'merged_into') IS NULL
        AND ${stage} IN ('dormant', 'forgotten')
        AND EXISTS (
          SELECT 1
          FROM sigma.vault_audit a
          WHERE a.entry_id = v.id
            AND a.created_at >= NOW() - ($1::int * INTERVAL '1 day')
            AND a.action = ANY($2::text[])
        )
      ORDER BY created_at DESC, id DESC
      LIMIT $3
    `, [boundedRecallDays, TOUCH_ACTIONS, boundedLimit]),
  ]);
  return {
    decayRows: rowsFromPg(decayRows),
    recallRows: rowsFromPg(recallRows),
  };
}

export function buildLibrarianPlan({ decayRows = [], recallRows = [] } = {}) {
  const decayPlans = (decayRows || [])
    .map((row) => {
      const from = normalizeTimeStage(row.current_time_stage);
      const to = nextDecayStage(from);
      return to ? { id: row.id, title: row.title || null, source: row.source || null, transition: 'decay', from, to } : null;
    })
    .filter(Boolean);
  const recallPlans = (recallRows || [])
    .map((row) => {
      const from = normalizeTimeStage(row.current_time_stage);
      const to = recallStage(from);
      return to ? { id: row.id, title: row.title || null, source: row.source || null, transition: 'recall', from, to } : null;
    })
    .filter(Boolean);
  return [...decayPlans, ...recallPlans];
}

export async function applyLibrarianPlan(plan = [], { pg = pgPool, env = process.env } = {}) {
  if (String(env.SIGMA_LIBRARIAN_ENABLED || '').toLowerCase() !== 'true') {
    return { applied: 0, skipped: true, reason: 'SIGMA_LIBRARIAN_ENABLED_not_true' };
  }
  let applied = 0;
  for (const item of plan) {
    await pg.query('sigma', `
      UPDATE sigma.vault_entries
      SET time_stage = $1,
          meta = jsonb_set(
            COALESCE(meta, '{}'::jsonb),
            '{libraryCoords}',
            COALESCE(meta->'libraryCoords', '{}'::jsonb) || jsonb_build_object('time_stage', $1::text),
            true
          ),
          updated_at = NOW()
      WHERE id = $2
        AND (meta->>'merged_into') IS NULL
    `, [item.to, item.id]);
    await pg.query('sigma', `
      INSERT INTO sigma.vault_audit (entry_id, action, classifier, reasoning, applied, dry_run)
      VALUES ($1, 'tagged', 'rule', $2, true, false)
    `, [item.id, `sigma_librarian:${item.transition}:${item.from}->${item.to}`]).catch(() => []);
    applied += 1;
  }
  return { applied, skipped: false };
}

export async function buildLibrarianReport(options = {}) {
  const queryReadonly = options.queryReadonly || pgPool.queryReadonly;
  const candidates = options.candidates || await fetchLibrarianCandidates({
    limit: options.limit || 500,
    recallDays: options.recallDays || 30,
    queryReadonly,
  });
  const plan = buildLibrarianPlan(candidates);
  const applyResult = options.apply
    ? await applyLibrarianPlan(plan, { pg: options.pg || pgPool, env: options.env || process.env })
    : null;
  const vaultTierReport = isVaultTierReportEnabled(options.env || process.env)
    ? await fetchVaultTierReport({
      queryReadonly,
      sampleLimit: options.vaultTierSampleLimit || 12,
    })
    : null;
  return {
    ok: !options.apply || applyResult?.skipped === false,
    source: 'sigma_librarian',
    dryRun: options.apply !== true,
    liveMutation: Boolean(options.apply && applyResult?.applied > 0),
    generatedAt: new Date().toISOString(),
    counts: {
      decayCandidates: candidates.decayRows.length,
      recallCandidates: candidates.recallRows.length,
      planned: plan.length,
      applied: applyResult?.applied || 0,
      byTransition: plan.reduce((acc, item) => {
        acc[item.transition] = (acc[item.transition] || 0) + 1;
        return acc;
      }, {}),
    },
    plan: plan.slice(0, options.planLimit || 50),
    applyResult,
    vaultTierReport,
    safety: {
      applyRequiresEnv: 'SIGMA_LIBRARIAN_ENABLED=true',
      vaultTierReportRequiresEnv: 'SIGMA_VAULT_TIER_REPORT_ENABLED=true',
      writesOnlySigmaTables: ['sigma.vault_entries', 'sigma.vault_audit'],
      defaultDryRun: true,
    },
  };
}

async function main() {
  const report = await buildLibrarianReport({
    apply: hasFlag('apply'),
    limit: boundedInt(valueArg('limit'), 500, 1, 5000),
    recallDays: boundedInt(valueArg('recall-days'), 30, 1, 3650),
  });
  if (hasFlag('json')) console.log(JSON.stringify(report, null, 2));
  else console.log(`[sigma-librarian] decay=${report.counts.decayCandidates} recall=${report.counts.recallCandidates} dryRun=${report.dryRun}`);
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[sigma-librarian] failed: ${error?.message || error}`);
    process.exit(1);
  });
}
