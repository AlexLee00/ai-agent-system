#!/usr/bin/env node
// @ts-nocheck

import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createVaultEmbedding, VaultManager } from '../vault/vault-manager.ts';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const pgPool = require(path.join(repoRoot, 'packages/core/lib/pg-pool'));

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, Math.floor(safe)));
}

function normalizeRows(rows) {
  return Array.isArray(rows) ? rows : rows?.rows ?? [];
}

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 24);
}

function contentHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function cleanText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function countBy(items, keyFn) {
  const out = {};
  for (const item of items || []) {
    const key = keyFn(item);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function safePathPart(value) {
  return String(value || 'unknown')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'unknown';
}

async function safeQuery(schema, label, sql, params, warnings, queryReadonly) {
  try {
    return normalizeRows(await queryReadonly(schema, sql, params));
  } catch (error) {
    warnings.push(`${label}:${error?.message || String(error)}`);
    return [];
  }
}

export function buildTeamVaultCandidates({ skaDaily = [], skaReservations = [], darwinResearch = [], darwinCycles = [] } = {}) {
  const candidates = [];

  for (const row of skaDaily || []) {
    const date = String(row.date || row.report_date || 'unknown');
    const content = cleanText([
      '[SKA 일일 매출 요약]',
      `date: ${date}`,
      `total_amount: ${Number(row.total_amount || 0)}`,
      `general_revenue: ${Number(row.general_revenue || 0)}`,
      `study_room_revenue: ${Number(row.pickko_study_room || row.studyroom_revenue || 0)}`,
      row.room_amounts_json ? `room_amounts: ${JSON.stringify(row.room_amounts_json)}` : '',
    ].filter(Boolean).join('\n'));
    const hash = contentHash(content);
    candidates.push({
      sourceKind: 'ska_daily_summary',
      sourceId: `ska_daily_summary:${date}:${hash.slice(0, 12)}`,
      title: `[ska_daily_summary] ${date}`,
      type: 'ska_daily_summary',
      content,
      tags: ['sigma-library', 'ska', 'reservation', 'revenue'],
      filePath: `library/ska/daily_summary/${safePathPart(date)}-${hash.slice(0, 12)}`,
      source: 'ska_daily_summary',
      meta: { sourceKind: 'ska_daily_summary', date, contentHash: hash, pii: 'aggregate_only' },
    });
  }

  for (const row of skaReservations || []) {
    const date = String(row.date || 'unknown');
    const content = cleanText([
      '[SKA 예약 상태 요약]',
      `date: ${date}`,
      `total_reservations: ${Number(row.total_reservations || 0)}`,
      `active_reservations: ${Number(row.active_reservations || 0)}`,
      `cancelled_reservations: ${Number(row.cancelled_reservations || 0)}`,
      `completed_reservations: ${Number(row.completed_reservations || 0)}`,
    ].join('\n'));
    const hash = contentHash(content);
    candidates.push({
      sourceKind: 'ska_reservation_summary',
      sourceId: `ska_reservation_summary:${date}:${hash.slice(0, 12)}`,
      title: `[ska_reservation_summary] ${date}`,
      type: 'ska_reservation_summary',
      content,
      tags: ['sigma-library', 'ska', 'reservation', 'status'],
      filePath: `library/ska/reservation_summary/${safePathPart(date)}-${hash.slice(0, 12)}`,
      source: 'ska_reservation_summary',
      meta: { sourceKind: 'ska_reservation_summary', date, contentHash: hash, pii: 'aggregate_only' },
    });
  }

  for (const row of darwinResearch || []) {
    const paperId = String(row.paper_id || row.id || shortHash(row.title || 'darwin-research'));
    const content = cleanText([
      '[Darwin R&D 결과]',
      row.title ? `title: ${row.title}` : '',
      row.stage ? `stage: ${row.stage}` : '',
      row.source ? `source: ${row.source}` : '',
      row.url ? `url: ${row.url}` : '',
      row.keywords ? `keywords: ${Array.isArray(row.keywords) ? row.keywords.join(', ') : row.keywords}` : '',
      row.metadata ? `metadata: ${JSON.stringify(row.metadata)}` : '',
    ].filter(Boolean).join('\n'));
    if (!content) continue;
    const hash = contentHash(content);
    candidates.push({
      sourceKind: 'darwin_research',
      sourceId: `darwin_research:${paperId}:${hash.slice(0, 12)}`,
      title: `[darwin_research] ${String(row.title || paperId).slice(0, 140)}`,
      type: 'darwin_research',
      content,
      tags: ['sigma-library', 'darwin', 'research', row.stage || 'stage:unknown'].filter(Boolean),
      filePath: `library/darwin/research/${safePathPart(paperId)}-${hash.slice(0, 12)}`,
      source: 'darwin_research',
      meta: {
        sourceKind: 'darwin_research',
        paperId,
        stage: row.stage || null,
        contentHash: hash,
        updatedAt: row.updated_at || row.inserted_at || null,
      },
    });
  }

  for (const row of darwinCycles || []) {
    const cycleId = String(row.cycle_id || row.id || shortHash(JSON.stringify(row)));
    const content = cleanText([
      '[Darwin 사이클 결과]',
      `cycle_id: ${cycleId}`,
      row.status ? `status: ${row.status}` : '',
      row.stage ? `stage: ${row.stage}` : '',
      row.verification_status ? `verification_status: ${row.verification_status}` : '',
      row.summary ? `summary: ${row.summary}` : '',
      row.metadata ? `metadata: ${JSON.stringify(row.metadata)}` : '',
    ].filter(Boolean).join('\n'));
    if (!content) continue;
    const hash = contentHash(content);
    candidates.push({
      sourceKind: 'darwin_cycle_result',
      sourceId: `darwin_cycle_result:${cycleId}:${hash.slice(0, 12)}`,
      title: `[darwin_cycle_result] ${cycleId}`,
      type: 'darwin_cycle_result',
      content,
      tags: ['sigma-library', 'darwin', 'cycle', row.status || row.verification_status || 'status:unknown'].filter(Boolean),
      filePath: `library/darwin/cycle_result/${safePathPart(cycleId)}-${hash.slice(0, 12)}`,
      source: 'darwin_cycle_result',
      meta: {
        sourceKind: 'darwin_cycle_result',
        cycleId,
        status: row.status || row.verification_status || null,
        contentHash: hash,
        createdAt: row.inserted_at || row.completed_at || null,
      },
    });
  }

  return candidates;
}

async function fetchSkaSources({ sinceHours, limit, warnings, queryReadonly }) {
  const skaDaily = await safeQuery('reservation', 'reservation.daily_summary', `
    SELECT date::date::text AS date, total_amount, general_revenue, pickko_study_room, room_amounts_json
    FROM reservation.daily_summary
    WHERE date::text ~ '^\\d{4}-\\d{2}-\\d{2}$'
      AND date::date >= (CURRENT_DATE - ($1::int * INTERVAL '1 hour'))::date
    ORDER BY date::date DESC
    LIMIT $2
  `, [sinceHours, limit], warnings, queryReadonly);

  const skaReservations = await safeQuery('reservation', 'reservation.reservations.aggregate', `
    SELECT date::date::text AS date,
           COUNT(*)::int AS total_reservations,
           COUNT(*) FILTER (WHERE COALESCE(status, '') NOT IN ('cancelled', 'canceled'))::int AS active_reservations,
           COUNT(*) FILTER (WHERE COALESCE(status, '') IN ('cancelled', 'canceled'))::int AS cancelled_reservations,
           COUNT(*) FILTER (WHERE COALESCE(status, '') = 'completed')::int AS completed_reservations
    FROM reservation.reservations
    WHERE date::text ~ '^\\d{4}-\\d{2}-\\d{2}$'
      AND date::date >= (CURRENT_DATE - ($1::int * INTERVAL '1 hour'))::date
    GROUP BY date::date
    ORDER BY date::date DESC
    LIMIT $2
  `, [sinceHours, limit], warnings, queryReadonly);

  return { skaDaily, skaReservations };
}

async function fetchDarwinSources({ sinceHours, limit, warnings, queryReadonly }) {
  const darwinResearch = await safeQuery('public', 'public.darwin_research_registry', `
    SELECT paper_id, title, source, url, stage, keywords, metadata, inserted_at, updated_at
    FROM public.darwin_research_registry
    WHERE COALESCE(updated_at, inserted_at) >= NOW() - ($1 || ' hours')::INTERVAL
    ORDER BY COALESCE(updated_at, inserted_at) DESC
    LIMIT $2
  `, [String(sinceHours), limit], warnings, queryReadonly);

  const darwinCycles = await safeQuery('public', 'public.darwin_v2_cycle_results', `
    SELECT id,
           id::text AS cycle_id,
           CASE WHEN success IS TRUE THEN 'passed' ELSE 'failed' END AS verification_status,
           result_summary AS summary,
           metadata,
           inserted_at,
           inserted_at AS completed_at
    FROM public.darwin_v2_cycle_results
    WHERE inserted_at >= NOW() - ($1 || ' hours')::INTERVAL
    ORDER BY inserted_at DESC
    LIMIT $2
  `, [String(sinceHours), limit], warnings, queryReadonly);

  return { darwinResearch, darwinCycles };
}

export async function runSigmaTeamVaultFeed(options = {}) {
  const sinceHours = boundedNumber(options.sinceHours, 24 * 7, 1, 24 * 60);
  const limit = boundedNumber(options.limit, 80, 1, 500);
  const teams = new Set(String(options.teams || 'ska,darwin').split(',').map((item) => item.trim()).filter(Boolean));
  const effectiveDryRun = options.dryRun !== false || options.write !== true;
  const queryReadonly = options.queryReadonly || pgPool.queryReadonly || pgPool.query;
  const warnings = [];

  const sourceRows = {
    skaDaily: [],
    skaReservations: [],
    darwinResearch: [],
    darwinCycles: [],
  };
  if (!options.noDb && teams.has('ska')) Object.assign(sourceRows, await fetchSkaSources({ sinceHours, limit, warnings, queryReadonly }));
  if (!options.noDb && teams.has('darwin')) Object.assign(sourceRows, await fetchDarwinSources({ sinceHours, limit, warnings, queryReadonly }));

  const candidates = buildTeamVaultCandidates(sourceRows);
  const embeddingProbeRecord = candidates[0] || null;
  const embeddingProbe = embeddingProbeRecord && options.sampleEmbedding !== false
    ? await createVaultEmbedding(embeddingProbeRecord.content)
    : { embedding: null, dim: null, warning: 'embedding_probe_skipped' };

  const manager = effectiveDryRun ? null : new VaultManager();
  const results = [];
  if (manager) {
    for (const candidate of candidates) {
      const persisted = await manager.addToInbox(candidate);
      results.push({
        sourceKind: candidate.sourceKind,
        sourceId: candidate.sourceId,
        filePath: candidate.filePath,
        ok: persisted.ok,
        id: persisted.id || null,
        embedded: persisted.embedded,
        embeddingDim: persisted.embeddingDim ?? null,
        embeddingWarning: persisted.embeddingWarning || null,
        message: persisted.message,
      });
    }
  }

  const failed = results.filter((item) => !item.ok);
  return {
    ok: failed.length === 0,
    dryRun: effectiveDryRun,
    sinceHours,
    limit,
    teams: [...teams],
    source: {
      rows: Object.fromEntries(Object.entries(sourceRows).map(([key, rows]) => [key, rows.length])),
      warnings,
    },
    candidates: candidates.length,
    candidatesBySource: countBy(candidates, (item) => item.sourceKind),
    embeddingProbe: {
      sourceKind: embeddingProbeRecord?.sourceKind || null,
      dim: embeddingProbe.dim,
      embedded: Boolean(embeddingProbe.embedding),
      warning: embeddingProbe.warning || null,
    },
    persisted: {
      attempted: results.length,
      ok: results.filter((item) => item.ok).length,
      failed: failed.length,
      embedded: results.filter((item) => item.embedded).length,
      bySource: countBy(results.filter((item) => item.ok), (item) => item.sourceKind),
      embeddingWarnings: results.filter((item) => item.embeddingWarning).slice(0, 10),
      failures: failed.slice(0, 10),
    },
    sample: candidates.slice(0, 3).map((item) => ({
      sourceKind: item.sourceKind,
      sourceId: item.sourceId,
      title: item.title,
      filePath: item.filePath,
      text: item.content.slice(0, 220),
    })),
    generatedAt: new Date().toISOString(),
    safety: {
      defaultDryRun: true,
      dbWriteRequiresWriteAndNoDryRun: true,
      writesOnlySigmaVaultEntries: true,
      rawReservationPiiRead: false,
      liveImpact: false,
    },
  };
}

async function main() {
  const json = hasFlag('json');
  const write = hasFlag('write');
  const noDryRun = hasFlag('no-dry-run');
  const result = await runSigmaTeamVaultFeed({
    sinceHours: boundedNumber(argValue('since-hours', '168'), 168, 1, 24 * 60),
    limit: boundedNumber(argValue('limit', '80'), 80, 1, 500),
    teams: argValue('teams', 'ska,darwin'),
    dryRun: !noDryRun,
    write,
    noDb: hasFlag('no-db'),
    sampleEmbedding: !hasFlag('no-sample-embedding'),
  });
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(`[sigma-team-vault-feed] dryRun=${result.dryRun} candidates=${result.candidates} persisted=${result.persisted.ok}/${result.persisted.attempted}`);
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
    process.exitCode = 1;
  });
}
