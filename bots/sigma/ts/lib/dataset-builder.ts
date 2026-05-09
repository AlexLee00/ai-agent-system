import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  SIGMA_TEAMS,
  buildDatasetCards,
  buildLineageRecord,
  evaluateSensitiveExport,
  type DatasetCard,
  type SigmaTeam,
} from './intelligent-library.js';
import type { LibraryRecord } from './library-data-source.js';

const require = createRequire(import.meta.url);

const pgPool = require('../../../../packages/core/lib/pg-pool.js') as {
  run: (schema: string, sql: string, params?: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }>;
};

export interface DatasetBuildOptions {
  weekLabel?: string;
  teams?: readonly SigmaTeam[];
  outDir?: string;
  dryRun?: boolean;
  masterApprovedExternalExport?: boolean;
  records?: readonly LibraryRecord[];
}

export interface DatasetArtifactPlan {
  card: DatasetCard;
  datasetDir: string;
  files: Record<'readme' | 'schema' | 'stats' | 'lineage' | 'data', string>;
  contentHash: string;
  exportAllowed: boolean;
  exportReason: string;
  parquetReady: false;
  rows: DatasetRow[];
  lineageRecords: DatasetLineageRow[];
}

export interface DatasetBuildPlan {
  ok: boolean;
  status: string;
  dryRun: boolean;
  weekLabel: string;
  artifacts: DatasetArtifactPlan[];
  blockers: string[];
  warnings: string[];
}

export interface DatasetRow {
  source_id: string;
  source_kind: string;
  team: string;
  agent: string;
  created_at: string;
  text: string;
  payload: Record<string, unknown>;
  lineage_hash: string;
  content_hash: string;
  pii_redactions: string[];
}

export interface DatasetLineageRow {
  data_id: string;
  source_event_id: number | null;
  source_team: string;
  source_agent: string;
  ingested_at: string;
  processed_by: string[];
  consumed_by: string[];
  content_hash: string;
  metadata: Record<string, unknown>;
}

export interface DatasetMetadataPersistResult {
  ok: boolean;
  dryRun: boolean;
  lineageRows: number;
  snapshotRows: number;
  warnings: string[];
}

function currentWeekLabel(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const diffDays = Math.floor((now.getTime() - start) / 86_400_000);
  const week = String(Math.floor(diffDays / 7) + 1).padStart(2, '0');
  return `${year}w${week}`;
}

function defaultOutDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, '../../output/datasets');
}

function recordsForCard(card: DatasetCard, records: readonly LibraryRecord[]): LibraryRecord[] {
  const teamRecords = records.filter((record) => record.team === card.team);
  if (card.dataset.endsWith('_reflexion_weekly')) {
    return teamRecords.filter((record) => (
      record.sourceKind === 'luna_reflexion'
      || record.sourceKind === 'dpo_preference'
      || /failure|error|reflexion|회고|오류/i.test(record.piiRedactedText)
    ));
  }
  return teamRecords;
}

function buildDatasetRows(card: DatasetCard, records: readonly LibraryRecord[]): {
  rows: DatasetRow[];
  lineageRecords: DatasetLineageRow[];
} {
  const selected = recordsForCard(card, records);
  const rows = selected.map((record) => {
    const dataId = `${card.dataset}:${record.sourceId}`;
    const lineage = buildLineageRecord({
      dataId,
      sourceEventId: Number(String(record.sourceId).split(':').at(-1)) || null,
      sourceTeam: record.team,
      sourceAgent: record.agent,
      payload: {
        sourceId: record.sourceId,
        sourceKind: record.sourceKind,
        contentHash: record.contentHash,
      },
      processedBy: ['sigma.dataset_builder'],
      consumedBy: [`sigma.dataset.${card.dataset}`],
    });
    return {
      source_id: record.sourceId,
      source_kind: record.sourceKind,
      team: record.team,
      agent: record.agent,
      created_at: record.createdAt,
      text: record.piiRedactedText,
      payload: record.payload,
      lineage_hash: lineage.contentHash,
      content_hash: record.contentHash,
      pii_redactions: record.redactions,
    };
  });

  return {
    rows,
    lineageRecords: selected.map((record, index) => ({
      data_id: `${card.dataset}:${record.sourceId}`,
      source_event_id: Number(String(record.sourceId).split(':').at(-1)) || null,
      source_team: record.team,
      source_agent: record.agent,
      ingested_at: record.createdAt,
      processed_by: ['sigma.dataset_builder'],
      consumed_by: [`sigma.dataset.${card.dataset}`],
      content_hash: rows[index]?.lineage_hash ?? record.contentHash,
      metadata: {
        dataset: card.dataset,
        sourceKind: record.sourceKind,
        sourceId: record.sourceId,
        recordContentHash: record.contentHash,
      },
    })),
  };
}

export function buildDatasetPlan(options: DatasetBuildOptions = {}): DatasetBuildPlan {
  const dryRun = options.dryRun !== false;
  const weekLabel = options.weekLabel ?? currentWeekLabel();
  const outDir = options.outDir ?? defaultOutDir();
  const cards = buildDatasetCards(options.teams ?? SIGMA_TEAMS);
  const records = options.records ?? [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  const artifacts = cards.map((card) => {
    const exportDecision = evaluateSensitiveExport({
      collection: card.team === 'justin' ? 'rag_legal' : `rag_${card.team}`,
      externalExport: true,
      masterApproved: options.masterApprovedExternalExport === true,
    });
    if (!exportDecision.allowed) warnings.push(`${card.dataset}:${exportDecision.reason}`);

    const datasetDir = path.join(outDir, card.team, `${card.dataset}_${weekLabel}`);
    const { rows, lineageRecords } = buildDatasetRows(card, records);
    const lineage = buildLineageRecord({
      dataId: `${card.dataset}_${weekLabel}`,
      sourceEventId: null,
      sourceTeam: card.team,
      sourceAgent: 'sigma-dataset-builder',
      payload: { schema: card.schema, weekLabel, rowHashes: rows.map((row) => row.content_hash) },
      processedBy: ['sigma.dataset_builder'],
    });
    const payload = JSON.stringify({ card, lineage, weekLabel, rows: rows.map((row) => row.content_hash) });
    const contentHash = crypto.createHash('sha256').update(payload).digest('hex');

    return {
      card: { ...card, rows: rows.length },
      datasetDir,
      contentHash,
      exportAllowed: exportDecision.allowed,
      exportReason: exportDecision.reason,
      parquetReady: false as const,
      rows,
      lineageRecords,
      files: {
        readme: path.join(datasetDir, 'README.md'),
        schema: path.join(datasetDir, 'schema.json'),
        stats: path.join(datasetDir, 'stats.json'),
        lineage: path.join(datasetDir, 'lineage.json'),
        data: path.join(datasetDir, 'data.jsonl'),
      },
    };
  });

  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'dataset_build_plan_ready' : 'dataset_build_plan_blocked',
    dryRun,
    weekLabel,
    artifacts,
    blockers,
    warnings: [...new Set(warnings)].sort(),
  };
}

export function writeDatasetPlan(plan: DatasetBuildPlan): string[] {
  if (plan.dryRun) return [];
  const written: string[] = [];
  for (const artifact of plan.artifacts) {
    fs.mkdirSync(artifact.datasetDir, { recursive: true });
    fs.writeFileSync(artifact.files.readme, [
      `# ${artifact.card.dataset}`,
      '',
      `team: ${artifact.card.team}`,
      `format: ${artifact.card.format}`,
      `week: ${plan.weekLabel}`,
      `lineage_required: ${artifact.card.lineageRequired}`,
      `external_export_allowed: ${artifact.exportAllowed}`,
      `export_reason: ${artifact.exportReason}`,
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(artifact.files.schema, `${JSON.stringify(artifact.card.schema, null, 2)}\n`, 'utf8');
    fs.writeFileSync(artifact.files.stats, `${JSON.stringify({
      rows: artifact.rows.length,
      contentHash: artifact.contentHash,
      parquetReady: artifact.parquetReady,
    }, null, 2)}\n`, 'utf8');
    fs.writeFileSync(artifact.files.lineage, `${JSON.stringify({
      contentHash: artifact.contentHash,
      dataset: artifact.card.dataset,
      lineageRows: artifact.lineageRecords,
    }, null, 2)}\n`, 'utf8');
    fs.writeFileSync(artifact.files.data, `${artifact.rows.map((row) => JSON.stringify(row)).join('\n')}${artifact.rows.length > 0 ? '\n' : ''}`, 'utf8');
    written.push(...Object.values(artifact.files));
  }
  return written;
}

const DATASET_TABLE_DDL = [
  `CREATE SCHEMA IF NOT EXISTS sigma`,
  `CREATE TABLE IF NOT EXISTS sigma.data_lineage (
    data_id TEXT PRIMARY KEY,
    source_event_id BIGINT,
    source_team TEXT NOT NULL,
    source_agent TEXT NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_by JSONB NOT NULL DEFAULT '[]',
    consumed_by JSONB NOT NULL DEFAULT '[]',
    content_hash TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sigma_data_lineage_source
    ON sigma.data_lineage (source_team, source_agent, ingested_at DESC)`,
  `CREATE TABLE IF NOT EXISTS sigma.dataset_snapshots (
    id BIGSERIAL PRIMARY KEY,
    team TEXT NOT NULL,
    dataset TEXT NOT NULL,
    week_label TEXT NOT NULL,
    schema JSONB NOT NULL DEFAULT '{}',
    stats JSONB NOT NULL DEFAULT '{}',
    lineage_hash TEXT NOT NULL,
    external_export_allowed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (team, dataset, week_label)
  )`,
];

async function ensureDatasetTables(): Promise<void> {
  for (const ddl of DATASET_TABLE_DDL) await pgPool.run('sigma', ddl);
}

export async function persistDatasetMetadata(
  plan: DatasetBuildPlan,
  opts: { confirm?: string } = {},
): Promise<DatasetMetadataPersistResult> {
  if (plan.dryRun || opts.confirm !== 'sigma-dataset-builder-apply') {
    return {
      ok: true,
      dryRun: true,
      lineageRows: 0,
      snapshotRows: 0,
      warnings: plan.dryRun ? [] : ['confirm_required:sigma-dataset-builder-apply'],
    };
  }

  const warnings: string[] = [];
  let lineageRows = 0;
  let snapshotRows = 0;
  await ensureDatasetTables();

  for (const artifact of plan.artifacts) {
    for (const row of artifact.lineageRecords) {
      try {
        const result = await pgPool.run('sigma', `
          INSERT INTO sigma.data_lineage
            (data_id, source_event_id, source_team, source_agent, ingested_at, processed_by, consumed_by, content_hash, metadata)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::jsonb)
          ON CONFLICT (data_id) DO UPDATE
            SET ingested_at = EXCLUDED.ingested_at,
                processed_by = EXCLUDED.processed_by,
                consumed_by = EXCLUDED.consumed_by,
                content_hash = EXCLUDED.content_hash,
                metadata = EXCLUDED.metadata
        `, [
          row.data_id,
          row.source_event_id,
          row.source_team,
          row.source_agent,
          row.ingested_at,
          JSON.stringify(row.processed_by),
          JSON.stringify(row.consumed_by),
          row.content_hash,
          JSON.stringify(row.metadata),
        ]);
        lineageRows += result.rowCount ?? 0;
      } catch (error) {
        warnings.push(`${row.data_id}:${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      const result = await pgPool.run('sigma', `
        INSERT INTO sigma.dataset_snapshots
          (team, dataset, week_label, schema, stats, lineage_hash, external_export_allowed)
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
        ON CONFLICT (team, dataset, week_label) DO UPDATE
          SET schema = EXCLUDED.schema,
              stats = EXCLUDED.stats,
              lineage_hash = EXCLUDED.lineage_hash,
              external_export_allowed = EXCLUDED.external_export_allowed,
              created_at = NOW()
      `, [
        artifact.card.team,
        artifact.card.dataset,
        plan.weekLabel,
        JSON.stringify(artifact.card.schema),
        JSON.stringify({
          rows: artifact.rows.length,
          contentHash: artifact.contentHash,
          parquetReady: artifact.parquetReady,
          externalExportReason: artifact.exportReason,
        }),
        artifact.contentHash,
        artifact.exportAllowed,
      ]);
      snapshotRows += result.rowCount ?? 0;
    } catch (error) {
      warnings.push(`${artifact.card.dataset}:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    ok: warnings.length === 0,
    dryRun: false,
    lineageRows,
    snapshotRows,
    warnings,
  };
}
