#!/usr/bin/env node
// @ts-nocheck

import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { rowsFromPg } from '../shared/zaxis.ts';
import { buildVaultNormalizedContentMd5 } from '../vault/vault-manager.ts';
import { resolveVaultTier } from '../vault/vault-tiering.ts';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const pgPool = require(path.join(repoRoot, 'packages/core/lib/pg-pool.ts'));

const COORD_RANKS = {
  validation_state: { retired: 0, contradicted: 1, unverified: 2, observed: 3, validated: 4 },
  abstraction_level: { L0: 0, L1: 1, L2: 2, L3: 3 },
  time_stage: { forgotten: 0, dormant: 1, raw: 2, digest: 3, pattern: 4 },
  prediction_state: { none: 0, forward: 1, due: 2, resolved: 3 },
};

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

function exactContentMd5(row) {
  return crypto.createHash('md5')
    .update(`${row?.title || ''}\n${row?.content || ''}`)
    .digest('hex');
}

function rowCoordinates(row) {
  const metaCoords = parseMeta(row?.meta).libraryCoords || {};
  return Object.fromEntries(Object.keys(COORD_RANKS).map((key) => [key, row?.[key] || metaCoords[key] || null]));
}

function compareRepresentativeRows(left, right) {
  const leftCoords = rowCoordinates(left);
  const rightCoords = rowCoordinates(right);
  for (const [key, ranks] of Object.entries(COORD_RANKS)) {
    const coordDelta = (ranks[rightCoords[key]] || 0) - (ranks[leftCoords[key]] || 0);
    if (coordDelta !== 0) return coordDelta;
  }
  const leftTime = new Date(left.created_at || 0).getTime();
  const rightTime = new Date(right.created_at || 0).getTime();
  const timeDelta = (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
  if (timeDelta !== 0) return timeDelta;
  const embeddingDelta = Number(Boolean(right.has_embedding ?? right.embedding)) - Number(Boolean(left.has_embedding ?? left.embedding));
  if (embeddingDelta !== 0) return embeddingDelta;
  const sourceRefDelta = Number(Boolean(parseMeta(right.meta).source_ref)) - Number(Boolean(parseMeta(left.meta).source_ref));
  if (sourceRefDelta !== 0) return sourceRefDelta;
  return String(right.id || '').localeCompare(String(left.id || ''), 'en', { numeric: true });
}

export function chooseKeepRow(rows = []) {
  return [...rows].sort(compareRepresentativeRows)[0] || null;
}

function duplicateGroups(rows, keyForRow) {
  const grouped = new Map();
  for (const row of rows) {
    const key = keyForRow(row);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return [...grouped.entries()]
    .filter(([, groupRows]) => groupRows.length > 1)
    .map(([contentMd5, groupRows]) => {
      const sorted = [...groupRows].sort(compareRepresentativeRows);
      return {
        contentMd5,
        total: sorted.length,
        keep: sorted[0],
        duplicates: sorted.slice(1),
      };
    })
    .sort((left, right) => right.total - left.total || left.contentMd5.localeCompare(right.contentMd5));
}

function duplicateCounts(groups) {
  return {
    groups: groups.length,
    groupRows: groups.reduce((sum, group) => sum + group.total, 0),
    duplicateRows: groups.reduce((sum, group) => sum + group.duplicates.length, 0),
  };
}

function addDistributionRow(distribution, key, field) {
  const safeKey = String(key || 'unknown');
  distribution[safeKey] ||= { totalRows: 0, exactDuplicateRows: 0, normalizedDuplicateRows: 0 };
  distribution[safeKey][field] += 1;
}

export function buildVaultDuplicateInventory(inputRows = []) {
  const rows = rowsFromPg(inputRows).filter((row) => String(row?.title || '').trim() || String(row?.content || '').trim());
  const exactGroups = duplicateGroups(rows, exactContentMd5);
  const normalizedGroups = duplicateGroups(rows, buildVaultNormalizedContentMd5);
  const byTier = {};
  const bySource = {};

  for (const row of rows) {
    addDistributionRow(byTier, resolveVaultTier(row).tier, 'totalRows');
    addDistributionRow(bySource, row.source, 'totalRows');
  }
  for (const row of exactGroups.flatMap((group) => group.duplicates)) {
    addDistributionRow(byTier, resolveVaultTier(row).tier, 'exactDuplicateRows');
    addDistributionRow(bySource, row.source, 'exactDuplicateRows');
  }
  for (const row of normalizedGroups.flatMap((group) => group.duplicates)) {
    addDistributionRow(byTier, resolveVaultTier(row).tier, 'normalizedDuplicateRows');
    addDistributionRow(bySource, row.source, 'normalizedDuplicateRows');
  }

  return {
    totalRows: rows.length,
    exact: duplicateCounts(exactGroups),
    normalized: duplicateCounts(normalizedGroups),
    exactGroups,
    normalizedGroups,
    byTier,
    bySource,
  };
}

export async function fetchVaultDedupeRows({
  source = 'all',
  queryReadonly = pgPool.queryReadonly,
} = {}) {
  const sourceFilter = source === 'all' ? null : source;
  return rowsFromPg(await queryReadonly('sigma', `
    SELECT id, title, type, content, source, file_path, meta,
           abstraction_level, time_stage, validation_state, prediction_state,
           (embedding IS NOT NULL) AS has_embedding, created_at
    FROM sigma.vault_entries
    WHERE COALESCE(status, 'captured') <> 'archived'
      AND (meta->>'merged_into') IS NULL
      AND ($1::text IS NULL OR source = $1)
      AND NULLIF(TRIM(COALESCE(title, '') || COALESCE(content, '')), '') IS NOT NULL
    ORDER BY id ASC
  `, [sourceFilter]));
}

export async function fetchVaultDuplicateGroups(options = {}) {
  const rows = await fetchVaultDedupeRows(options);
  return buildVaultDuplicateInventory(rows).normalizedGroups.slice(0, boundedInt(options.limit, 100, 1, 10_000));
}

export function buildVaultDedupePlan(groups = []) {
  return groups.map((group) => ({
    contentMd5: group.contentMd5,
    keepId: group.keep?.id || null,
    duplicateIds: group.duplicates.map((row) => row.id),
    duplicateCount: group.duplicates.length,
    source: group.keep?.source || null,
    keepTitle: group.keep?.title || null,
    keepSelection: 'validation>abstraction>time>prediction>created_at>embedding>source_ref>id',
    transferPlan: {
      embedding: 'fill_keep_only_when_missing',
      sourceRefs: 'union_into_keep_meta.source_refs',
      knowledgeGraphRefs: 'redirect_duplicate_entry_ids_to_keep_id',
    },
  }));
}

export async function applyVaultDedupePlan(plan = [], {
  write = false,
  confirm = false,
} = {}) {
  if (!write || !confirm) {
    return { applied: 0, skipped: true, reason: 'write_confirm_required' };
  }
  const plannedDuplicateRows = plan.reduce((sum, group) => (
    sum + (group.duplicateIds || []).filter((id) => String(id) !== String(group.keepId)).length
  ), 0);
  if (plannedDuplicateRows > 0) {
    return {
      applied: 0,
      skipped: true,
      reason: 'reference_transfer_not_implemented',
      plannedDuplicateRows,
    };
  }
  return { applied: 0, skipped: false };
}

export async function buildVaultDedupeReport(options = {}) {
  const rows = options.rows || await fetchVaultDedupeRows({
    source: options.source || 'all',
    queryReadonly: options.queryReadonly || pgPool.queryReadonly,
  });
  const inventory = options.inventory || buildVaultDuplicateInventory(rows);
  const groups = inventory.normalizedGroups.slice(0, boundedInt(options.limit, 100, 1, 10_000));
  const plan = buildVaultDedupePlan(groups);
  const writeRequested = options.write === true;
  const applyResult = writeRequested
    ? await applyVaultDedupePlan(plan, {
      write: true,
      confirm: options.confirm === true,
    })
    : null;
  return {
    ok: !writeRequested || applyResult?.skipped === false,
    source: 'sigma_vault_dedupe',
    dryRun: !writeRequested,
    liveMutation: Boolean(writeRequested && applyResult?.skipped === false && applyResult?.applied > 0),
    generatedAt: new Date().toISOString(),
    targetSource: options.source || 'all',
    counts: {
      totalRows: inventory.totalRows,
      exact: inventory.exact,
      normalized: inventory.normalized,
      plannedGroups: plan.length,
      plannedDuplicateRows: plan.reduce((sum, item) => sum + item.duplicateCount, 0),
      writeAttempted: writeRequested,
      applied: applyResult?.applied || 0,
    },
    distribution: {
      byTier: inventory.byTier,
      bySource: inventory.bySource,
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
      writeGate: 'blocked_until_reference_transfer_is_implemented',
      groupAtomicity: null,
      writesOnlySigmaTables: [],
      transferPlanOnly: true,
    },
  };
}

async function main() {
  const report = await buildVaultDedupeReport({
    write: hasFlag('write'),
    confirm: hasFlag('confirm'),
    source: valueArg('source', 'all'),
    limit: boundedInt(valueArg('limit'), 100, 1, 10_000),
  });
  if (hasFlag('json')) console.log(JSON.stringify(report, null, 2));
  else console.log(`[sigma-vault-dedupe] groups=${report.counts.normalized.groups} duplicates=${report.counts.normalized.duplicateRows} dryRun=${report.dryRun}`);
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[sigma-vault-dedupe] failed: ${error?.message || error}`);
    process.exit(1);
  });
}
