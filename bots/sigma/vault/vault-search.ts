#!/usr/bin/env node
// @ts-nocheck

import path from 'node:path';
import { createRequire } from 'node:module';
import { createVaultEmbedding } from './vault-manager.ts';
import {
  buildLayerRoute,
  coordsMatchFilters,
  isLayerSearchEnabled,
  normalizeCoordFilters,
} from './layer-router.ts';
import { normalizeLibraryCoords } from '../shared/library-coords.ts';
import { KNOWLEDGE_TYPES, resolveVaultTier } from './vault-tiering.js';
import { buildVaultKnowledgeGraph, queryRelatedRecords } from './vault-knowledge-graph.js';

const require = createRequire(import.meta.url);
const PROJECT_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../..',
);
const pgPool = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));
const KG_SEARCH_ENV = 'SIGMA_KG_SEARCH_ENABLED';
const KG_SEARCH_MAX_HOPS = 2;
const KG_SEARCH_RESULT_LIMIT = 5;
const KG_SEARCH_SOURCE_LIMIT = 2000;

export interface VaultSearchOptions {
  topK?: number;
  sourceKinds?: string[];
  types?: string[];
  sourceRefIds?: Array<string | number>;
  groupBySourceRef?: boolean;
  paraCategory?: string;
  minSimilarity?: number;
  layerSearchEnabled?: boolean;
  intent?: string;
  coordFilters?: Record<string, unknown>;
  includeRoutingDebug?: boolean;
  deps?: Record<string, unknown>;
}

export interface VaultSearchResult {
  id: string;
  title: string;
  source: string | null;
  contentPreview: string | null;
  similarity: number;
  meta: Record<string, unknown>;
  libraryCoords?: Record<string, unknown>;
}

export interface VaultKnowledgeGraphSearchRecord {
  id: string;
  title: string;
  source: string | null;
  contentPreview: string | null;
  meta: Record<string, unknown>;
  hop: number;
  confidence: number;
}

export interface VaultKnowledgeGraphSearchResult {
  enabled: true;
  maxHops: number;
  resultLimit: number;
  matchedNodes: Array<{ id: string; type: string; label: string }>;
  results: VaultKnowledgeGraphSearchRecord[];
  warning?: string;
}

export interface VaultSearchResponse {
  ok: boolean;
  results: VaultSearchResult[];
  warning?: string;
  routing?: Record<string, unknown> | null;
  knowledgeGraph?: VaultKnowledgeGraphSearchResult;
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

function normalizeRows(rows: unknown): any[] {
  return Array.isArray(rows) ? rows : (rows as any)?.rows ?? [];
}

function isKnowledgeGraphSearchEnabled(env: Record<string, string | undefined>): boolean {
  return String(env[KG_SEARCH_ENV] || '').trim().toLowerCase() === 'true';
}

async function searchKnowledgeGraph(query: string, queryReadonly: any): Promise<VaultKnowledgeGraphSearchResult> {
  const rows = normalizeRows(await queryReadonly('sigma', `
    SELECT
      id::text,
      title,
      type,
      source,
      tags,
      meta,
      created_at,
      LEFT(content, 200) AS content_preview
    FROM sigma.vault_entries
    WHERE COALESCE(status, 'captured') <> 'archived'
      AND (meta->>'merged_into') IS NULL
      AND (
        type = ANY($1::text[])
        OR LOWER(COALESCE(meta->>'vaultTier', meta->>'vault_tier', '')) = 'knowledge'
      )
    ORDER BY created_at DESC, id DESC
    LIMIT $2
  `, [[...KNOWLEDGE_TYPES], KG_SEARCH_SOURCE_LIMIT]));
  const knowledgeRows = rows.filter((row) => resolveVaultTier(row).tier === 'knowledge');
  const related = queryRelatedRecords(
    buildVaultKnowledgeGraph(knowledgeRows),
    query,
    KG_SEARCH_MAX_HOPS,
    KG_SEARCH_RESULT_LIMIT,
  );
  const rowById = new Map(knowledgeRows.map((row) => [String(row.id), row]));
  return {
    enabled: true,
    maxHops: KG_SEARCH_MAX_HOPS,
    resultLimit: KG_SEARCH_RESULT_LIMIT,
    matchedNodes: related.matchedNodes.map((node) => ({ id: node.id, type: node.type, label: node.label })),
    results: related.records.flatMap(({ record, hop, confidence }) => {
      const row = rowById.get(record.id);
      if (!row) return [];
      return [{
        id: record.id,
        title: record.title,
        source: row.source || null,
        contentPreview: row.content_preview || null,
        meta: normalizeMeta(row.meta),
        hop,
        confidence,
      }];
    }),
  };
}

const DEFAULT_COORDS: Record<string, string> = {
  abstraction_level: 'L0',
  time_stage: 'raw',
  validation_state: 'unverified',
  prediction_state: 'none',
};

const SOURCE_REF_ID_SQL = `COALESCE(
  NULLIF(meta->>'sourceId', ''),
  NULLIF(meta->>'source_id', ''),
  NULLIF(meta->'source_ref'->>'id', ''),
  NULLIF(meta->'sourceRef'->>'id', ''),
  NULLIF(meta->>'post_id', ''),
  NULLIF(meta->>'postId', ''),
  NULLIF(meta->>'blog_post_id', ''),
  NULLIF(meta->>'blogPostId', '')
)`;

function normalizeFilterValues(values: unknown, limit: number): string[] {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean))]
    .slice(0, limit);
}

function buildVectorSearchSql({
  filters,
  limitParam,
  coordSelect,
  orderBy,
  groupBySourceRef,
}: {
  filters: string[];
  limitParam: number;
  coordSelect: string;
  orderBy: string;
  groupBySourceRef: boolean;
}): string {
  if (!groupBySourceRef) {
    return `
      SELECT
        id,
        title,
        source,
        LEFT(content, 200) AS content_preview,
        meta,
        1 - (embedding <=> $1::vector) AS similarity
        ${coordSelect}
      FROM sigma.vault_entries
      WHERE ${filters.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT $${limitParam}
    `;
  }
  const outerOrderBy = orderBy.startsWith('created_at')
    ? 'created_at DESC, similarity DESC, id DESC'
    : 'similarity DESC, id DESC';
  return `
    WITH ranked AS (
      SELECT
        id,
        title,
        source,
        LEFT(content, 200) AS content_preview,
        meta,
        created_at,
        1 - (embedding <=> $1::vector) AS similarity,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(${SOURCE_REF_ID_SQL}, id::text)
          ORDER BY ${orderBy}, id DESC
        ) AS source_group_rank
        ${coordSelect}
      FROM sigma.vault_entries
      WHERE ${filters.join(' AND ')}
    )
    SELECT id, title, source, content_preview, meta, similarity${coordSelect}
    FROM ranked
    WHERE source_group_rank = 1
    ORDER BY ${outerOrderBy}
    LIMIT $${limitParam}
  `;
}

function extractLibraryCoords(row: any): Record<string, unknown> {
  const meta = normalizeMeta(row.meta);
  return normalizeLibraryCoords({
    ...(meta.libraryCoords || {}),
    abstraction_level: row.abstraction_level || meta.libraryCoords?.abstraction_level,
    time_stage: row.time_stage || meta.libraryCoords?.time_stage,
    validation_state: row.validation_state || meta.libraryCoords?.validation_state,
    prediction_state: row.prediction_state || meta.libraryCoords?.prediction_state,
    prediction_horizon: row.prediction_horizon || meta.libraryCoords?.prediction_horizon,
  });
}

async function detectCoordColumns(queryReadonly: any): Promise<Set<string>> {
  try {
    const rows = await queryReadonly('sigma', `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'sigma'
        AND table_name = 'vault_entries'
        AND column_name = ANY($1::text[])
    `, [['abstraction_level', 'time_stage', 'validation_state', 'prediction_state', 'prediction_horizon']]);
    return new Set(normalizeRows(rows).map((row) => row.column_name));
  } catch {
    return new Set();
  }
}

function addCoordSqlFilter(filters: string[], params: any[], nextParam: number, key: string, values: string[], hasColumn: boolean): number {
  if (!values || values.length === 0) return nextParam;
  const keyParam = nextParam + 1;
  const defaultParam = nextParam + 2;
  const coordExpr = hasColumn
    ? `COALESCE(${key}, meta->'libraryCoords'->>$${keyParam}, $${defaultParam})`
    : `COALESCE(meta->'libraryCoords'->>$${keyParam}, $${defaultParam})`;
  params.push(values, key, DEFAULT_COORDS[key] || '');
  filters.push(`${coordExpr} = ANY($${nextParam}::text[])`);
  return nextParam + 3;
}

export async function searchVault(query: string, opts: VaultSearchOptions = {}): Promise<VaultSearchResponse> {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) return { ok: false, results: [], warning: 'query_required' };

  const topK = Math.floor(boundedNumber(opts.topK, 5, 1, 50));
  const sourceKinds = normalizeSourceKinds(opts.sourceKinds);
  const types = normalizeFilterValues(opts.types, 50);
  const sourceRefIds = normalizeFilterValues(opts.sourceRefIds, 2000);
  const groupBySourceRef = opts.groupBySourceRef === true;
  const paraCategory = normalizeParaCategory(opts.paraCategory);
  const minSimilarity = opts.minSimilarity == null
    ? null
    : boundedNumber(opts.minSimilarity, 0, -1, 1);

  const deps = opts.deps || {};
  const embeddingFactory = deps.embeddingFactory || createVaultEmbedding;
  const queryReadonly = deps.queryReadonly || pgPool.queryReadonly || pgPool.query;
  const env = deps.env || process.env;
  const knowledgeGraphEnabled = isKnowledgeGraphSearchEnabled(env);
  const layerEnabled = Boolean(opts.layerSearchEnabled ?? isLayerSearchEnabled());
  const layerRoute = layerEnabled
    ? buildLayerRoute(normalizedQuery, { intent: opts.intent, coordFilters: opts.coordFilters })
    : null;

  const embeddingResult = await embeddingFactory(normalizedQuery);
  if (!embeddingResult.embedding) {
    return {
      ok: false,
      results: [],
      warning: embeddingResult.warning || 'embedding_failed',
      routing: opts.includeRoutingDebug ? layerRoute : undefined,
    };
  }

  const embeddingVector = `[${embeddingResult.embedding.join(',')}]`;
  const params: any[] = [embeddingVector];
  const filters = ['embedding IS NOT NULL', "(meta->>'merged_into') IS NULL"];
  let nextParam = 2;
  const coordColumns = layerRoute ? await detectCoordColumns(queryReadonly) : new Set();

  if (sourceKinds.length > 0) {
    filters.push(`source = ANY($${nextParam}::text[])`);
    params.push(sourceKinds);
    nextParam += 1;
  }

  if (types.length > 0) {
    filters.push(`type = ANY($${nextParam}::text[])`);
    params.push(types);
    nextParam += 1;
  }

  if (sourceRefIds.length > 0) {
    filters.push(`${SOURCE_REF_ID_SQL} = ANY($${nextParam}::text[])`);
    params.push(sourceRefIds);
    nextParam += 1;
  }

  if (paraCategory) {
    filters.push(`para_category = $${nextParam}`);
    params.push(paraCategory);
    nextParam += 1;
  }

  const broadFilters = [...filters];
  const broadParams = [...params];
  const broadLimitParam = nextParam;

  if (layerRoute) {
    const coordFilters = normalizeCoordFilters(layerRoute.coordFilters);
    for (const key of ['abstraction_level', 'time_stage', 'validation_state', 'prediction_state']) {
      nextParam = addCoordSqlFilter(filters, params, nextParam, key, coordFilters[key], coordColumns.has(key));
    }
  }

  const effectiveLimit = layerRoute ? Math.min(100, Math.max(topK, topK * 5)) : topK;
  params.push(effectiveLimit);
  const limitParam = nextParam;
  const coordSelect = coordColumns.size > 0
    ? `, ${[...coordColumns].join(', ')}`
    : '';
  const orderBy = layerRoute?.coordFilters?.order === 'latest'
    ? 'created_at DESC, embedding <=> $1::vector'
    : 'embedding <=> $1::vector';

  try {
    const rows = await queryReadonly('sigma', buildVectorSearchSql({
      filters,
      limitParam,
      coordSelect,
      orderBy,
      groupBySourceRef,
    }), params);

    const coordFilters = normalizeCoordFilters(layerRoute?.coordFilters || {});
    const normalizeResults = (searchRows: unknown, applyLayerFilters: boolean) => normalizeRows(searchRows)
      .map((row: any) => {
        const libraryCoords = extractLibraryCoords(row);
        const result = {
          id: row.id,
          title: row.title,
          source: row.source || null,
          contentPreview: row.content_preview || null,
          similarity: Number(row.similarity),
          meta: normalizeMeta(row.meta),
        };
        if (layerRoute || opts.includeRoutingDebug) result.libraryCoords = libraryCoords;
        return result;
      })
      .filter((row: VaultSearchResult) => !applyLayerFilters || coordsMatchFilters(row.libraryCoords, coordFilters))
      .filter((row: VaultSearchResult) => minSimilarity == null || row.similarity >= minSimilarity)
      .slice(0, topK);
    let results = normalizeResults(rows, Boolean(layerRoute));
    let layerFallbackReason: string | null = null;

    if (layerRoute && results.length < topK) {
      const layerResultCount = results.length;
      const fallbackRows = await queryReadonly('sigma', buildVectorSearchSql({
        filters: broadFilters,
        limitParam: broadLimitParam,
        coordSelect,
        orderBy: 'embedding <=> $1::vector',
        groupBySourceRef,
      }), [...broadParams, topK]);
      const seenIds = new Set(results.map((row) => String(row.id)));
      for (const row of normalizeResults(fallbackRows, false)) {
        if (seenIds.has(String(row.id))) continue;
        results.push(row);
        seenIds.add(String(row.id));
        if (results.length >= topK) break;
      }
      layerFallbackReason = layerResultCount === 0
        ? 'layer_empty_fallback'
        : 'layer_sparse_fallback';
    }

    const response: VaultSearchResponse = {
      ok: true,
      results,
    };
    if (layerRoute) {
      response.routing = {
        ...layerRoute,
        reason: layerFallbackReason || layerRoute.reason,
        coordColumnsPresent: [...coordColumns].sort(),
        fallback: coordColumns.size === 0 ? 'meta.libraryCoords' : 'coord_columns_or_meta',
      };
    } else if (opts.includeRoutingDebug) {
      response.routing = null;
    }
    if (knowledgeGraphEnabled) {
      try {
        response.knowledgeGraph = await searchKnowledgeGraph(normalizedQuery, queryReadonly);
      } catch (error: any) {
        response.knowledgeGraph = {
          enabled: true,
          maxHops: KG_SEARCH_MAX_HOPS,
          resultLimit: KG_SEARCH_RESULT_LIMIT,
          matchedNodes: [],
          results: [],
          warning: `kg_search_unavailable:${error?.message || String(error)}`,
        };
      }
    }
    return response;
  } catch (err: any) {
    return {
      ok: false,
      results: [],
      warning: `vault_search_failed:${err?.message || String(err)}`,
      routing: opts.includeRoutingDebug ? layerRoute : undefined,
    };
  }
}

export default searchVault;
