#!/usr/bin/env node
// @ts-nocheck

import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { normalizeLibraryCoords } from '../shared/library-coords.ts';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const pgPool = require(path.join(repoRoot, 'packages/core/lib/pg-pool.ts'));
const cycleTrace = require(path.join(repoRoot, 'packages/core/lib/cycle-trace.ts'));

const COORD_COLUMNS = ['abstraction_level', 'time_stage', 'validation_state', 'prediction_state', 'prediction_horizon'];
const LOW_VALUE_SOURCES = new Set(['blo', 'blog_comment', 'blog_post', 'blog_comment_action', 'blog_comment_inbound']);
const LOW_VALUE_PATTERNS = [/blog[_-]?comment/i, /library\/blo/i, /neighbor[_-]?comment/i, /comment\/(?:action|inbound)/i];
const LOW_VALUE_SQL_PATTERNS = ['%blog_comment%', '%blog-comment%', '%library/blo%', '%neighbor_comment%', '%comment/action%', '%comment/inbound%'];

export function parseArgs(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  return {
    json: argv.includes('--json'),
    write,
    dryRun: !write || argv.includes('--dry-run') || !argv.includes('--no-dry-run'),
    noDb: argv.includes('--no-db'),
    date: valueArg(argv, '--date') || yesterdayIsoDate(),
    limit: boundedInt(valueArg(argv, '--limit'), 200, 1, 1000),
    maxDigests: boundedInt(valueArg(argv, '--max-digests'), 20, 1, 100),
    decayDays: boundedInt(valueArg(argv, '--decay-days'), 30, 1, 3650),
    now: new Date(),
  };
}

function valueArg(argv, name) {
  const prefix = `${name}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || null;
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function yesterdayIsoDate(now = new Date()) {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
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

export function rowCoords(row = {}) {
  const meta = parseMeta(row.meta);
  return normalizeLibraryCoords({
    ...(meta.libraryCoords || {}),
    abstraction_level: row.abstraction_level || meta.libraryCoords?.abstraction_level,
    time_stage: row.time_stage || meta.libraryCoords?.time_stage,
    validation_state: row.validation_state || meta.libraryCoords?.validation_state,
    prediction_state: row.prediction_state || meta.libraryCoords?.prediction_state,
    prediction_horizon: row.prediction_horizon || meta.libraryCoords?.prediction_horizon,
  });
}

function rowText(row = {}) {
  return [
    row.title,
    row.type,
    row.source,
    row.file_path,
    row.content,
    typeof row.meta === 'string' ? row.meta : JSON.stringify(row.meta || {}),
  ].filter(Boolean).join('\n');
}

export function isDreamingDigestCandidate(row = {}) {
  const source = String(row.source || '').trim().toLowerCase();
  if (LOW_VALUE_SOURCES.has(source)) return true;
  const text = rowText(row);
  return LOW_VALUE_PATTERNS.some((pattern) => pattern.test(text));
}

function normalizeText(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(text = '') {
  return new Set(normalizeText(text).split(/\s+/).filter((token) => token.length >= 2).slice(0, 200));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function parseEmbedding(value) {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
  const raw = String(value || '').replace(/^\[|\]$/g, '');
  if (!raw.trim()) return [];
  return raw.split(',').map((item) => Number(item.trim())).filter(Number.isFinite);
}

function cosine(a, b) {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa > 0 && bb > 0 ? dot / (Math.sqrt(aa) * Math.sqrt(bb)) : 0;
}

function rowSignature(row) {
  return crypto.createHash('sha256').update(normalizeText(rowText(row)).slice(0, 1200)).digest('hex').slice(0, 12);
}

function rowsSimilar(a, b) {
  const ae = parseEmbedding(a.embedding_text || a.embedding);
  const be = parseEmbedding(b.embedding_text || b.embedding);
  if (ae.length && be.length && ae.length === be.length) return cosine(ae, be) >= 0.92;
  return jaccard(tokenSet(rowText(a)), tokenSet(rowText(b))) >= 0.72
    || rowSignature(a).slice(0, 8) === rowSignature(b).slice(0, 8);
}

export function buildDreamingClusters(rows = [], { maxDigests = 20 } = {}) {
  const candidates = (rows || [])
    .filter((row) => rowCoords(row).abstraction_level === 'L0')
    .filter((row) => rowCoords(row).time_stage === 'raw')
    .filter(isDreamingDigestCandidate);
  const clusters = [];
  for (const row of candidates) {
    let target = clusters.find((cluster) => rowsSimilar(cluster.rows[0], row));
    if (!target) {
      target = {
        id: `dream-${rowSignature(row)}`,
        source: String(row.source || 'unknown').toLowerCase(),
        rows: [],
      };
      clusters.push(target);
    }
    target.rows.push(row);
  }
  return clusters
    .sort((a, b) => b.rows.length - a.rows.length || a.id.localeCompare(b.id))
    .slice(0, Math.max(1, Number(maxDigests) || 20))
    .map((cluster) => ({
      ...cluster,
      title: `Dreaming digest: ${cluster.rows[0]?.title || cluster.source}`,
      sourceEntryIds: cluster.rows.map((row) => row.id).filter(Boolean),
      sourceFilePaths: cluster.rows.map((row) => row.file_path).filter(Boolean),
      content: formatDigestContent(cluster),
    }));
}

function formatDigestContent(cluster) {
  const lines = [
    `# ${cluster.rows[0]?.title || 'Dreaming digest'}`,
    '',
    'Z-axis digest generated from low-value raw vault entries.',
    '',
    '## Sources',
    ...cluster.rows.slice(0, 20).map((row) => `- vault-entry:${row.id || 'unknown'} ${row.title || row.file_path || ''}`.trim()),
    '',
    '## Integrated Notes',
    ...cluster.rows.slice(0, 8).map((row) => `- ${String(row.content || row.title || '').replace(/\s+/g, ' ').trim().slice(0, 240)}`),
  ];
  return lines.join('\n').trim();
}

export function buildDreamingLitePlan({
  candidateRows = [],
  decayRows = [],
  dueRows = [],
  date = yesterdayIsoDate(),
  maxDigests = 20,
} = {}) {
  const clusters = buildDreamingClusters(candidateRows, { maxDigests });
  return {
    digestPlans: clusters.map((cluster) => ({
      clusterId: cluster.id,
      title: cluster.title,
      filePath: `library/sigma/dreaming/${date}/${cluster.id}.md`,
      sourceEntryIds: cluster.sourceEntryIds,
      sourceFilePaths: cluster.sourceFilePaths,
      content: cluster.content,
      libraryCoords: {
        abstraction_level: 'L1',
        time_stage: 'digest',
        validation_state: 'observed',
        prediction_state: 'none',
      },
      meta: {
        generatedBy: 'sigma-dreaming-lite',
        digestDate: date,
        sourceEntryIds: cluster.sourceEntryIds,
      },
    })),
    decayPlans: decayRows.map((row) => ({ id: row.id, title: row.title, nextTimeStage: 'decayed' })),
    duePlans: dueRows.map((row) => ({ id: row.id, title: row.title, nextPredictionState: 'due', predictionHorizon: row.prediction_horizon || rowCoords(row).prediction_horizon })),
  };
}

async function detectCoordColumns(queryReadonly = pgPool.queryReadonly) {
  try {
    const rows = await queryReadonly('sigma', `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'sigma'
        AND table_name = 'vault_entries'
        AND column_name = ANY($1::text[])
    `, [COORD_COLUMNS]);
    return new Set((Array.isArray(rows) ? rows : rows?.rows ?? []).map((row) => row.column_name));
  } catch {
    return new Set();
  }
}

async function fetchCandidateRows({ date, limit, queryReadonly = pgPool.queryReadonly } = {}) {
  const coordColumns = await detectCoordColumns(queryReadonly);
  const coordSelect = coordColumns.size ? `, ${[...coordColumns].join(', ')}` : '';
  const timeStageExpr = coordColumns.has('time_stage')
    ? "COALESCE(time_stage, meta->'libraryCoords'->>'time_stage', 'raw')"
    : "COALESCE(meta->'libraryCoords'->>'time_stage', 'raw')";
  const abstractionExpr = coordColumns.has('abstraction_level')
    ? "COALESCE(abstraction_level, meta->'libraryCoords'->>'abstraction_level', 'L0')"
    : "COALESCE(meta->'libraryCoords'->>'abstraction_level', 'L0')";
  const start = `${date}T00:00:00.000Z`;
  const endDate = new Date(start);
  endDate.setUTCDate(endDate.getUTCDate() + 1);
  const rows = await queryReadonly('sigma', `
    SELECT id, title, type, content, source, file_path, meta, created_at, embedding::text AS embedding_text${coordSelect}
    FROM sigma.vault_entries
    WHERE COALESCE(status, 'captured') <> 'archived'
      AND ${abstractionExpr} = 'L0'
      AND ${timeStageExpr} = 'raw'
      AND created_at >= $1
      AND created_at < $2
      AND (
        LOWER(COALESCE(source, '')) = ANY($3::text[])
        OR COALESCE(title, '') ILIKE ANY($4::text[])
        OR COALESCE(type, '') ILIKE ANY($4::text[])
        OR COALESCE(file_path, '') ILIKE ANY($4::text[])
        OR COALESCE(meta::text, '') ILIKE ANY($4::text[])
      )
    ORDER BY created_at DESC
    LIMIT $5
  `, [start, endDate.toISOString(), [...LOW_VALUE_SOURCES], LOW_VALUE_SQL_PATTERNS, limit]);
  return Array.isArray(rows) ? rows : rows?.rows ?? [];
}

async function fetchTransitionRows({ decayDays, now = new Date(), limit, queryReadonly = pgPool.queryReadonly } = {}) {
  const coordColumns = await detectCoordColumns(queryReadonly);
  const coordSelect = coordColumns.size ? `, ${[...coordColumns].join(', ')}` : '';
  const timeStageExpr = coordColumns.has('time_stage')
    ? "COALESCE(time_stage, meta->'libraryCoords'->>'time_stage', 'raw')"
    : "COALESCE(meta->'libraryCoords'->>'time_stage', 'raw')";
  const predictionExpr = coordColumns.has('prediction_state')
    ? "COALESCE(prediction_state, meta->'libraryCoords'->>'prediction_state', 'none')"
    : "COALESCE(meta->'libraryCoords'->>'prediction_state', 'none')";
  const horizonExpr = coordColumns.has('prediction_horizon')
    ? "COALESCE(prediction_horizon, NULLIF(meta->'libraryCoords'->>'prediction_horizon', '')::timestamptz)"
    : "NULLIF(meta->'libraryCoords'->>'prediction_horizon', '')::timestamptz";
  const cutoff = new Date(now.getTime() - decayDays * 86400_000).toISOString();
  const [decayRows, dueRows] = await Promise.all([
    queryReadonly('sigma', `
      SELECT id, title, type, content, source, file_path, meta, created_at${coordSelect}
      FROM sigma.vault_entries
      WHERE COALESCE(status, 'captured') <> 'archived'
        AND ${timeStageExpr} = 'raw'
        AND created_at < $1
      ORDER BY created_at ASC
      LIMIT $2
    `, [cutoff, limit]),
    queryReadonly('sigma', `
      SELECT id, title, type, content, source, file_path, meta, created_at${coordSelect}
      FROM sigma.vault_entries
      WHERE COALESCE(status, 'captured') <> 'archived'
        AND ${predictionExpr} = 'forward'
        AND ${horizonExpr} IS NOT NULL
        AND ${horizonExpr} <= $1::timestamptz
      ORDER BY created_at ASC
      LIMIT $2
    `, [now.toISOString(), limit]),
  ]);
  return {
    decayRows: Array.isArray(decayRows) ? decayRows : decayRows?.rows ?? [],
    dueRows: Array.isArray(dueRows) ? dueRows : dueRows?.rows ?? [],
  };
}

async function updateEntryCoords(id, patch, { pg = pgPool, coordColumns = null } = {}) {
  const columns = coordColumns || await detectCoordColumns(pg.queryReadonly || pg.query);
  if (columns.size === COORD_COLUMNS.length) {
    const sets = [];
    const params = [];
    for (const key of Object.keys(patch)) {
      if (!COORD_COLUMNS.includes(key)) continue;
      params.push(patch[key]);
      sets.push(`${key} = $${params.length}`);
    }
    params.push(id);
    if (sets.length) {
      await pg.query('sigma', `UPDATE sigma.vault_entries SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`, params);
    }
  } else {
    await pg.query('sigma', `
      UPDATE sigma.vault_entries
      SET meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{libraryCoords}', COALESCE(meta->'libraryCoords', '{}'::jsonb) || $1::jsonb, true),
          updated_at = NOW()
      WHERE id = $2
    `, [JSON.stringify(patch), id]);
  }
  await pg.query('sigma', `
    INSERT INTO sigma.vault_audit (entry_id, action, classifier, reasoning, applied, dry_run)
    VALUES ($1, 'tagged', 'rule', $2, true, false)
  `, [id, `sigma_dreaming_lite_coord_transition:${JSON.stringify(patch)}`]).catch(() => []);
}

export async function applyDreamingLitePlan(plan, { pg = pgPool } = {}) {
  const { VaultManager } = await import('../vault/vault-manager.ts');
  const manager = new VaultManager({ pgPool: pg });
  const coordColumns = await detectCoordColumns(pg.queryReadonly || pg.query);
  const digestResults = [];
  for (const item of plan.digestPlans || []) {
    digestResults.push(await manager.addToInbox({
      title: item.title,
      type: 'sigma_dreaming_digest',
      content: item.content,
      tags: ['sigma-dreaming', 'digest'],
      filePath: item.filePath,
      source: 'sigma_dreaming',
      meta: item.meta,
      libraryCoords: item.libraryCoords,
    }));
  }
  for (const item of plan.decayPlans || []) {
    await updateEntryCoords(item.id, { time_stage: 'decayed' }, { pg, coordColumns });
  }
  for (const item of plan.duePlans || []) {
    await updateEntryCoords(item.id, { prediction_state: 'due' }, { pg, coordColumns });
  }
  return {
    digestResults,
    decayed: plan.decayPlans.length,
    due: plan.duePlans.length,
  };
}

export async function buildDreamingLiteReport(options = {}) {
  const trace = cycleTrace.createCycleTrace?.('sigma.dreaming-lite', { startedAt: Date.now() }) || {};
  if (options.noDb) {
    const plan = buildDreamingLitePlan({ candidateRows: [], decayRows: [], dueRows: [], date: options.date, maxDigests: options.maxDigests });
    return formatReport(plan, { ...options, trace, candidateRows: [], decayRows: [], dueRows: [] });
  }
  const queryReadonly = options.queryReadonly || pgPool.queryReadonly;
  const candidateRows = await fetchCandidateRows({ date: options.date, limit: options.limit, queryReadonly });
  const { decayRows, dueRows } = await fetchTransitionRows({
    decayDays: options.decayDays,
    now: options.now,
    limit: options.limit,
    queryReadonly,
  });
  const plan = buildDreamingLitePlan({
    candidateRows,
    decayRows,
    dueRows,
    date: options.date,
    maxDigests: options.maxDigests,
  });
  return formatReport(plan, { ...options, trace, candidateRows, decayRows, dueRows });
}

function formatReport(plan, options = {}) {
  return {
    ok: true,
    source: 'sigma_dreaming_lite',
    shadowOnly: options.dryRun !== false,
    liveMutation: false,
    dryRun: options.dryRun !== false,
    writeReady: options.write === true && options.dryRun === false,
    date: options.date,
    generatedAt: new Date().toISOString(),
    traceId: options.trace?.traceId || null,
    cycleId: options.trace?.cycleId || null,
    counts: {
      candidates: options.candidateRows?.length || 0,
      digestPlans: plan.digestPlans.length,
      decayPlans: plan.decayPlans.length,
      duePlans: plan.duePlans.length,
    },
    plan,
  };
}

async function main() {
  const args = parseArgs();
  const report = await buildDreamingLiteReport(args);
  let applyResult = null;
  if (args.write && !args.dryRun) {
    applyResult = await applyDreamingLitePlan(report.plan);
  }
  const liveMutation = Boolean(applyResult && (
    (applyResult.digestResults || []).length > 0
    || Number(applyResult.decayed || 0) > 0
    || Number(applyResult.due || 0) > 0
  ));
  const output = { ...report, liveMutation, shadowOnly: !liveMutation, applyResult };
  if (args.json) console.log(JSON.stringify(output, null, 2));
  else console.log(`[sigma-dreaming-lite] date=${report.date} digest=${report.counts.digestPlans} decay=${report.counts.decayPlans} due=${report.counts.duePlans} dryRun=${report.dryRun}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[sigma-dreaming-lite] failed: ${error?.message || error}`);
    process.exit(1);
  });
}
