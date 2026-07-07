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

function parseMeta(meta) {
  if (!meta) return {};
  if (typeof meta === 'object') return meta;
  try {
    return JSON.parse(String(meta));
  } catch {
    return {};
  }
}

function chooseKeepRow(rows = []) {
  return [...rows].sort((left, right) => {
    const leftRef = parseMeta(left.meta).source_ref ? 1 : 0;
    const rightRef = parseMeta(right.meta).source_ref ? 1 : 0;
    if (leftRef !== rightRef) return rightRef - leftRef;
    const leftTime = new Date(left.created_at || 0).getTime();
    const rightTime = new Date(right.created_at || 0).getTime();
    if (leftTime !== rightTime) return rightTime - leftTime;
    return Number(right.id || 0) - Number(left.id || 0);
  })[0] || null;
}

export async function fetchVaultDuplicateGroups({
  source = 'blo',
  limit = 100,
  queryReadonly = pgPool.queryReadonly,
} = {}) {
  const sourceFilter = source === 'all' ? null : source;
  const rows = await queryReadonly('sigma', `
    WITH base AS (
      SELECT id, title, content, source, file_path, meta, created_at,
             md5(COALESCE(title, '') || E'\\n' || COALESCE(content, '')) AS content_md5
      FROM sigma.vault_entries
      WHERE COALESCE(status, 'captured') <> 'archived'
        AND (meta->>'merged_into') IS NULL
        AND ($1::text IS NULL OR source = $1)
        AND NULLIF(TRIM(COALESCE(title, '') || COALESCE(content, '')), '') IS NOT NULL
    ),
    groups AS (
      SELECT content_md5, COUNT(*)::int AS total
      FROM base
      GROUP BY content_md5
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC, content_md5 ASC
      LIMIT $2
    )
    SELECT base.*, groups.total AS group_total
    FROM base
    JOIN groups USING (content_md5)
    ORDER BY base.content_md5 ASC, (base.meta ? 'source_ref') DESC, base.created_at DESC, base.id DESC
  `, [sourceFilter, boundedInt(limit, 100, 1, 10_000)]);

  const grouped = new Map();
  for (const row of rowsFromPg(rows)) {
    const key = row.content_md5;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  return [...grouped.entries()].map(([contentMd5, groupRows]) => {
    const keep = chooseKeepRow(groupRows);
    const duplicates = groupRows.filter((row) => String(row.id) !== String(keep?.id));
    return {
      contentMd5,
      total: groupRows.length,
      keep,
      duplicates,
    };
  });
}

export function buildVaultDedupePlan(groups = []) {
  return groups.map((group) => ({
    contentMd5: group.contentMd5,
    keepId: group.keep?.id || null,
    duplicateIds: group.duplicates.map((row) => row.id),
    duplicateCount: group.duplicates.length,
    source: group.keep?.source || null,
    keepTitle: group.keep?.title || null,
  }));
}

export async function applyVaultDedupePlan(plan = [], { pg = pgPool, env = process.env } = {}) {
  if (String(env.SIGMA_DEDUPE_ENABLED || '').toLowerCase() !== 'true') {
    return { applied: 0, skipped: true, reason: 'SIGMA_DEDUPE_ENABLED_not_true' };
  }
  let applied = 0;
  for (const group of plan) {
    if (!group.keepId) continue;
    for (const duplicateId of group.duplicateIds || []) {
      await pg.query('sigma', `
        UPDATE sigma.vault_entries
        SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object(
              'merged_into', $1::text,
              'merged_at', NOW()::text,
              'merged_reason', 'sigma_vault_dedupe',
              'dedupe_md5', $2::text
            ),
            updated_at = NOW()
        WHERE id = $3
          AND (meta->>'merged_into') IS NULL
      `, [String(group.keepId), group.contentMd5, duplicateId]);
      await pg.query('sigma', `
        INSERT INTO sigma.vault_audit (entry_id, action, classifier, reasoning, applied, dry_run)
        VALUES ($1, 'deduped', 'rule', $2, true, false)
      `, [duplicateId, `sigma_vault_dedupe: merged_into=${group.keepId} md5=${group.contentMd5}`]).catch(() => []);
      applied += 1;
    }
  }
  return { applied, skipped: false };
}

export async function buildVaultDedupeReport(options = {}) {
  const groups = options.groups || await fetchVaultDuplicateGroups({
    source: options.source || 'blo',
    limit: options.limit || 100,
    queryReadonly: options.queryReadonly || pgPool.queryReadonly,
  });
  const plan = buildVaultDedupePlan(groups);
  const applyRequested = options.apply === true;
  const applyResult = applyRequested
    ? await applyVaultDedupePlan(plan, { pg: options.pg || pgPool, env: options.env || process.env })
    : null;
  return {
    ok: !applyRequested || applyResult?.skipped === false,
    source: 'sigma_vault_dedupe',
    dryRun: !applyRequested,
    liveMutation: Boolean(applyRequested && applyResult?.skipped === false && applyResult?.applied > 0),
    generatedAt: new Date().toISOString(),
    targetSource: options.source || 'blo',
    counts: {
      groups: groups.length,
      duplicateRows: plan.reduce((sum, item) => sum + item.duplicateCount, 0),
      applyAttempted: applyRequested,
      applied: applyResult?.applied || 0,
    },
    plan: plan.slice(0, options.planLimit || 50).map((item) => ({
      ...item,
      duplicateIds: item.duplicateIds.slice(0, options.duplicateIdSampleLimit || 20),
      duplicateIdsOmitted: Math.max(0, item.duplicateIds.length - (options.duplicateIdSampleLimit || 20)),
    })),
    applyResult,
    safety: {
      hardDelete: false,
      softMergeField: 'meta.merged_into',
      applyRequiresEnv: 'SIGMA_DEDUPE_ENABLED=true',
      writesOnlySigmaTables: ['sigma.vault_entries', 'sigma.vault_audit'],
    },
  };
}

async function main() {
  const report = await buildVaultDedupeReport({
    apply: hasFlag('apply'),
    source: valueArg('source', 'blo'),
    limit: boundedInt(valueArg('limit'), 100, 1, 10_000),
  });
  if (hasFlag('json')) console.log(JSON.stringify(report, null, 2));
  else console.log(`[sigma-vault-dedupe] groups=${report.counts.groups} duplicates=${report.counts.duplicateRows} dryRun=${report.dryRun}`);
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[sigma-vault-dedupe] failed: ${error?.message || error}`);
    process.exit(1);
  });
}
