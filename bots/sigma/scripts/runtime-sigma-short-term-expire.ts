#!/usr/bin/env node
// @ts-nocheck

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { rowsFromPg } from '../shared/zaxis.ts';

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

export async function fetchExpiredShortTermRows({
  limit = 500,
  queryReadonly = pgPool.queryReadonly,
} = {}) {
  const rows = await queryReadonly('sigma', `
    SELECT id, team, agent_name, expires_at, created_at
    FROM sigma.agent_short_term_memory
    WHERE expires_at < NOW()
    ORDER BY expires_at ASC, id ASC
    LIMIT $1
  `, [boundedInt(limit, 500, 1, 10_000)]);
  return rowsFromPg(rows);
}

export async function expireShortTermRows({ ids = [], pg = pgPool } = {}) {
  const safeIds = (ids || []).map((id) => Number(id)).filter(Number.isFinite);
  if (safeIds.length === 0) return { deleted: 0 };
  const result = await pg.run('sigma', `
    DELETE FROM sigma.agent_short_term_memory
    WHERE id = ANY($1::bigint[])
  `, [safeIds]);
  return { deleted: result?.rowCount || 0 };
}

export async function buildShortTermExpireReport(options = {}) {
  const rows = options.rows || await fetchExpiredShortTermRows({
    limit: options.limit || 500,
    queryReadonly: options.queryReadonly || pgPool.queryReadonly,
  });
  const ids = rows.map((row) => row.id);
  const applyResult = options.apply ? await expireShortTermRows({ ids, pg: options.pg || pgPool }) : null;
  return {
    ok: true,
    source: 'sigma_short_term_expire',
    dryRun: options.apply !== true,
    liveMutation: Boolean(options.apply && applyResult?.deleted > 0),
    generatedAt: new Date().toISOString(),
    counts: {
      expired: rows.length,
      deleted: applyResult?.deleted || 0,
    },
    sample: rows.slice(0, 20),
    safety: {
      deleteAllowedTable: 'sigma.agent_short_term_memory',
      defaultDryRun: true,
    },
  };
}

async function main() {
  const report = await buildShortTermExpireReport({
    apply: hasFlag('apply'),
    limit: boundedInt(valueArg('limit'), 500, 1, 10_000),
  });
  if (hasFlag('json')) console.log(JSON.stringify(report, null, 2));
  else console.log(`[sigma-short-term-expire] expired=${report.counts.expired} deleted=${report.counts.deleted} dryRun=${report.dryRun}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[sigma-short-term-expire] failed: ${error?.message || error}`);
    process.exit(1);
  });
}
