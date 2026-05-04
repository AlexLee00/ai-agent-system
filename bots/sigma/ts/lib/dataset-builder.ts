import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SIGMA_TEAMS,
  buildDatasetCards,
  buildLineageRecord,
  evaluateSensitiveExport,
  type DatasetCard,
  type SigmaTeam,
} from './intelligent-library.js';

export interface DatasetBuildOptions {
  weekLabel?: string;
  teams?: readonly SigmaTeam[];
  outDir?: string;
  dryRun?: boolean;
  masterApprovedExternalExport?: boolean;
}

export interface DatasetArtifactPlan {
  card: DatasetCard;
  datasetDir: string;
  files: Record<'readme' | 'schema' | 'stats' | 'lineage' | 'data', string>;
  contentHash: string;
  exportAllowed: boolean;
  exportReason: string;
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

export function buildDatasetPlan(options: DatasetBuildOptions = {}): DatasetBuildPlan {
  const dryRun = options.dryRun !== false;
  const weekLabel = options.weekLabel ?? currentWeekLabel();
  const outDir = options.outDir ?? defaultOutDir();
  const cards = buildDatasetCards(options.teams ?? SIGMA_TEAMS);
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
    const lineage = buildLineageRecord({
      dataId: `${card.dataset}_${weekLabel}`,
      sourceEventId: null,
      sourceTeam: card.team,
      sourceAgent: 'sigma-dataset-builder',
      payload: { schema: card.schema, weekLabel },
      processedBy: ['sigma.dataset_builder'],
    });
    const payload = JSON.stringify({ card, lineage, weekLabel });
    const contentHash = crypto.createHash('sha256').update(payload).digest('hex');

    return {
      card,
      datasetDir,
      contentHash,
      exportAllowed: exportDecision.allowed,
      exportReason: exportDecision.reason,
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
    fs.writeFileSync(artifact.files.stats, `${JSON.stringify({ rows: artifact.card.rows, contentHash: artifact.contentHash }, null, 2)}\n`, 'utf8');
    fs.writeFileSync(artifact.files.lineage, `${JSON.stringify({ contentHash: artifact.contentHash, dataset: artifact.card.dataset }, null, 2)}\n`, 'utf8');
    fs.writeFileSync(artifact.files.data, '', 'utf8');
    written.push(...Object.values(artifact.files));
  }
  return written;
}
