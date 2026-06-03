#!/usr/bin/env node
// @ts-nocheck

import crypto from 'node:crypto';
import { collectLibraryRecords } from '../ts/lib/library-data-source.js';
import { createVaultEmbedding, VaultManager } from '../vault/vault-manager.ts';

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function argValue(name: string, fallback: string | null = null): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  const safeValue = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safeValue));
}

function countBy(items: any[], keyFn: (item: any) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function shortHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function titleForRecord(record: any): string {
  const payload = record.payload || {};
  const relPath = String(payload.relPath || '').replace(/^docs\/auto_dev\//, '');
  const firstText = String(record.piiRedactedText || record.text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 96);
  return `[claude_auto_dev] ${relPath || firstText || record.sourceId}`;
}

function tagsForRecord(record: any): string[] {
  const payload = record.payload || {};
  const tags = new Set(['sigma-library', 'claude', 'auto_dev', String(record.sourceKind || 'unknown')]);
  if (payload.outcome) tags.add(`outcome:${payload.outcome}`);
  if (payload.stage) tags.add(`stage:${payload.stage}`);
  if (payload.testPass === true) tags.add('test:pass');
  if (payload.testPass === false) tags.add('test:fail');
  return [...tags].slice(0, 12);
}

function entryForRecord(record: any) {
  return {
    title: titleForRecord(record),
    type: 'auto_dev_outcome',
    content: record.piiRedactedText || record.text,
    tags: tagsForRecord(record),
    filePath: `library/claude_auto_dev/${shortHash(record.sourceId)}`,
    source: record.sourceKind,
    meta: {
      contentHash: record.contentHash,
      sourceId: record.sourceId,
      sourceKind: record.sourceKind,
      team: record.team,
      agent: record.agent,
      createdAt: record.createdAt,
      constitutionAllowed: record.constitutionAllowed,
      redactions: record.redactions || [],
      payload: record.payload || {},
    },
  };
}

export async function runSigmaClaudeVaultFeed(options: {
  sinceHours?: number;
  limitPerSource?: number;
  dryRun?: boolean;
  write?: boolean;
  sampleEmbedding?: boolean;
} = {}) {
  const sinceHours = boundedNumber(options.sinceHours, 24 * 30, 1, 24 * 30);
  const limitPerSource = boundedNumber(options.limitPerSource, 80, 1, 500);
  const effectiveDryRun = options.dryRun !== false || options.write !== true;

  const sourceReport = await collectLibraryRecords({
    teams: ['claude'],
    sinceHours,
    limitPerSource,
  });

  const candidates = sourceReport.records
    .filter((record) => record.sourceKind === 'claude_auto_dev')
    .filter((record) => record.constitutionAllowed !== false)
    .filter((record) => String(record.piiRedactedText || record.text || '').trim().length > 0);
  const skipped = sourceReport.records.length - candidates.length;

  const embeddingProbeRecord = candidates.find((record) => record.piiRedactedText || record.text) || null;
  const embeddingProbe = embeddingProbeRecord && (options.sampleEmbedding !== false || effectiveDryRun)
    ? await createVaultEmbedding(embeddingProbeRecord.piiRedactedText || embeddingProbeRecord.text)
    : { embedding: null, dim: null, warning: 'embedding_probe_skipped' };

  const manager = effectiveDryRun ? null : new VaultManager();
  const results = [];
  if (manager) {
    for (const record of candidates) {
      const entry = entryForRecord(record);
      const persisted = await manager.addToInbox(entry);
      results.push({
        sourceKind: record.sourceKind,
        sourceId: record.sourceId,
        filePath: entry.filePath,
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
    ok: failed.length === 0 && sourceReport.ok,
    dryRun: effectiveDryRun,
    sinceHours,
    limitPerSource,
    source: sourceReport.stats,
    sourceWarnings: sourceReport.warnings,
    candidates: candidates.length,
    skipped,
    candidatesBySource: countBy(candidates, (record) => record.sourceKind),
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
    sample: candidates.slice(0, 3).map((record) => ({
      sourceKind: record.sourceKind,
      sourceId: record.sourceId,
      createdAt: record.createdAt,
      title: titleForRecord(record),
      filePath: entryForRecord(record).filePath,
      text: String(record.piiRedactedText || record.text || '').slice(0, 220),
    })),
    selfImprovementReady: sourceReport.records.some((record) => record.sourceKind === 'claude_auto_dev'),
    generatedAt: new Date().toISOString(),
    safety: {
      defaultDryRun: true,
      dbWriteRequiresWriteAndNoDryRun: true,
      writesOnlySigmaVaultEntries: true,
      liveTradeImpact: false,
    },
  };
}

async function main() {
  const json = hasFlag('json');
  const write = hasFlag('write');
  const noDryRun = hasFlag('no-dry-run');
  const result = await runSigmaClaudeVaultFeed({
    sinceHours: boundedNumber(argValue('since-hours', String(24 * 30)), 24 * 30, 1, 24 * 30),
    limitPerSource: boundedNumber(argValue('limit-per-source', '80'), 80, 1, 500),
    dryRun: !noDryRun,
    write,
  });
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`[sigma-claude-vault-feed] dryRun=${result.dryRun} candidates=${result.candidates} persisted=${result.persisted.ok}/${result.persisted.attempted} embedded=${result.persisted.embedded}`);
  }
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
    process.exitCode = 1;
  });
}
