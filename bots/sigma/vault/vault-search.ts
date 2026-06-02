#!/usr/bin/env node
// @ts-nocheck

import path from 'node:path';
import { createRequire } from 'node:module';
import { createVaultEmbedding } from './vault-manager.ts';

const require = createRequire(import.meta.url);
const PROJECT_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../..',
);
const pgPool = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));

export interface VaultSearchOptions {
  topK?: number;
  sourceKinds?: string[];
  paraCategory?: string;
  minSimilarity?: number;
}

export interface VaultSearchResult {
  id: string;
  title: string;
  source: string | null;
  contentPreview: string | null;
  similarity: number;
  meta: Record<string, unknown>;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  const safeValue = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safeValue));
}

function normalizeSourceKinds(sourceKinds: string[] | undefined): string[] {
  return [...new Set((sourceKinds || [])
    .flatMap((item) => String(item || '').split(','))
    .map((item) => item.trim())
    .filter(Boolean))]
    .slice(0, 20);
}

function normalizeParaCategory(value: unknown): string | null {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  return ['inbox', 'projects', 'areas', 'resources', 'archives'].includes(normalized) ? normalized : null;
}

function normalizeMeta(meta: unknown): Record<string, unknown> {
  if (!meta) return {};
  if (typeof meta === 'object') return meta as Record<string, unknown>;
  try {
    return JSON.parse(String(meta));
  } catch {
    return {};
  }
}

export async function searchVault(query: string, opts: VaultSearchOptions = {}): Promise<{
  ok: boolean;
  results: VaultSearchResult[];
  warning?: string;
}> {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) return { ok: false, results: [], warning: 'query_required' };

  const topK = Math.floor(boundedNumber(opts.topK, 5, 1, 50));
  const sourceKinds = normalizeSourceKinds(opts.sourceKinds);
  const paraCategory = normalizeParaCategory(opts.paraCategory);
  const minSimilarity = opts.minSimilarity == null
    ? null
    : boundedNumber(opts.minSimilarity, 0, -1, 1);

  const embeddingResult = await createVaultEmbedding(normalizedQuery);
  if (!embeddingResult.embedding) {
    return {
      ok: false,
      results: [],
      warning: embeddingResult.warning || 'embedding_failed',
    };
  }

  const embeddingVector = `[${embeddingResult.embedding.join(',')}]`;
  const params: any[] = [embeddingVector];
  const filters = ['embedding IS NOT NULL'];
  let nextParam = 2;

  if (sourceKinds.length > 0) {
    filters.push(`source = ANY($${nextParam}::text[])`);
    params.push(sourceKinds);
    nextParam += 1;
  }

  if (paraCategory) {
    filters.push(`para_category = $${nextParam}`);
    params.push(paraCategory);
    nextParam += 1;
  }

  params.push(topK);
  const limitParam = nextParam;

  try {
    const rows = await pgPool.query('sigma', `
      SELECT
        id,
        title,
        source,
        LEFT(content, 200) AS content_preview,
        meta,
        1 - (embedding <=> $1::vector) AS similarity
      FROM sigma.vault_entries
      WHERE ${filters.join(' AND ')}
      ORDER BY embedding <=> $1::vector
      LIMIT $${limitParam}
    `, params);

    const results = (Array.isArray(rows) ? rows : rows?.rows ?? [])
      .map((row: any) => ({
        id: row.id,
        title: row.title,
        source: row.source || null,
        contentPreview: row.content_preview || null,
        similarity: Number(row.similarity),
        meta: normalizeMeta(row.meta),
      }))
      .filter((row: VaultSearchResult) => minSimilarity == null || row.similarity >= minSimilarity);

    return { ok: true, results };
  } catch (err: any) {
    return {
      ok: false,
      results: [],
      warning: `vault_search_failed:${err?.message || String(err)}`,
    };
  }
}

export default searchVault;
