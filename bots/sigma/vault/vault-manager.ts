// @ts-nocheck
'use strict';

// Week 3 Day 15-16: 시그마 Vault Manager (DB 통합)
// sigma.vault_entries + sigma.vault_audit 테이블 연동
// 파일 기반 vault (ts/lib/vault-manager.ts)와 DB를 동기화하는 상위 레이어

import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import {
  attachLibraryCoordsToMeta,
  inferRawLibraryCoords,
  normalizeLibraryCoords,
} from '../shared/library-coords.ts';
const require = createRequire(import.meta.url);
const PROJECT_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../..'
);

const { getEmbeddingsUrl } = require(path.join(PROJECT_ROOT, 'packages/core/lib/local-llm-client.js'));
const LOCAL_MODEL_EMBED = process.env.EMBED_MODEL || 'qwen3-embed-0.6b';
const VAULT_EMBED_DIM = Number(process.env.SIGMA_VAULT_EMBED_DIM || 1024);

export async function createVaultEmbedding(text: string): Promise<{ embedding: number[] | null; dim: number | null; warning?: string }> {
  try {
    const url: string = getEmbeddingsUrl();
    if (!url) return { embedding: null, dim: null, warning: 'embedding_url_missing' };
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: LOCAL_MODEL_EMBED, input: text }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const payload = await resp.json() as any;
    const embedding = payload?.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) throw new Error('embedding missing');
    if (embedding.length !== VAULT_EMBED_DIM) {
      return {
        embedding: null,
        dim: embedding.length,
        warning: `embedding_dimension_mismatch:${embedding.length}!=${VAULT_EMBED_DIM}`,
      };
    }
    return { embedding: embedding as number[], dim: embedding.length };
  } catch (err: any) {
    const warning = err?.message || String(err);
    console.warn(`[vault-manager] 임베딩 생성 실패 (graceful): ${warning}`);
    return { embedding: null, dim: null, warning };
  }
}

export interface VaultEntry {
  id?: string;
  title: string;
  type?: string;
  content?: string;
  tags?: string[];
  paraCategory?: 'inbox' | 'projects' | 'areas' | 'resources' | 'archives';
  filePath?: string;
  source?: string;
  meta?: Record<string, unknown>;
  libraryCoords?: Record<string, unknown>;
}

export interface VaultAuditRecord {
  entryId?: string;
  action: 'created' | 'classified' | 'moved' | 'archived' | 'tagged' | 'deduped' | 'revised';
  fromCategory?: string;
  toCategory?: string;
  classifier?: 'rule' | 'llm' | 'manual';
  confidence?: number;
  reasoning?: string;
  applied?: boolean;
  dryRun?: boolean;
}

const COORD_COLUMNS = ['abstraction_level', 'time_stage', 'validation_state', 'prediction_state', 'prediction_horizon'];

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function parseMeta(meta: unknown): Record<string, unknown> {
  if (!meta) return {};
  if (typeof meta === 'object') return meta as Record<string, unknown>;
  try {
    return JSON.parse(String(meta));
  } catch {
    return {};
  }
}

function originalFilePath(filePath?: string | null): string | null {
  const normalized = String(filePath || '').trim();
  if (!normalized) return null;
  return normalized.split('#rev-')[0];
}

export function buildVaultRawHash(entry: Partial<VaultEntry>, rawFilePath = originalFilePath(entry.filePath) || null): string {
  return crypto.createHash('sha256').update(stableJson({
    title: entry.title || '',
    type: entry.type || 'note',
    content: entry.content || null,
    source: entry.source || 'vault',
    filePath: rawFilePath,
  })).digest('hex');
}

export class VaultManager {
  private pgPool: any;
  private embeddingFactory: any;
  private coordColumnCache: Promise<boolean> | null = null;

  constructor(deps: Record<string, unknown> = {}) {
    this.pgPool = deps.pgPool || require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));
    this.embeddingFactory = deps.embeddingFactory || createVaultEmbedding;
  }

  async addToInbox(entry: VaultEntry): Promise<{ ok: boolean; id?: string; message: string; embedded: boolean; embeddingDim?: number | null; embeddingWarning?: string | null }> {
    try {
      const rawFilePath = originalFilePath(entry.filePath);
      const rawHash = buildVaultRawHash(entry, rawFilePath);
      const baseCoords = normalizeLibraryCoords(entry.libraryCoords || inferRawLibraryCoords({
        title: entry.title,
        content: entry.content,
        source: entry.source,
        tags: entry.tags,
        meta: entry.meta,
      }));
      const baseMeta = {
        ...attachLibraryCoordsToMeta(entry.meta || {}, baseCoords),
        rawContentHash: rawHash,
      };
      if (rawFilePath) baseMeta.rawOriginalFilePath = rawFilePath;

      let effectiveFilePath = entry.filePath || null;
      let effectiveMeta = baseMeta;

      if (rawFilePath) {
        const existing = await this._findEntryByFilePath(rawFilePath);
        if (existing) {
          const existingMeta = parseMeta(existing.meta);
          const existingHash = existingMeta.rawContentHash || buildVaultRawHash({
            title: existing.title,
            type: existing.type,
            content: existing.content,
            source: existing.source,
            filePath: rawFilePath,
          }, rawFilePath);
          if (existingHash === rawHash) {
            await this._writeAudit({
              entryId: existing.id,
              action: 'deduped',
              toCategory: existing.para_category || 'inbox',
              classifier: 'manual',
              reasoning: `raw unchanged for ${rawFilePath}`,
              applied: true,
            });
            return {
              ok: true,
              id: existing.id,
              message: `중복 raw 유지 (id=${existing.id})`,
              embedded: false,
              embeddingDim: null,
              embeddingWarning: null,
            };
          }

          effectiveFilePath = `${rawFilePath}#rev-${rawHash.slice(0, 8)}`;
          effectiveMeta = {
            ...baseMeta,
            rawRevisionOf: existing.id,
            rawOriginalFilePath: rawFilePath,
          };
          const existingRevision = await this._findEntryByFilePath(effectiveFilePath);
          if (existingRevision) {
            await this._writeAudit({
              entryId: existingRevision.id,
              action: 'deduped',
              toCategory: existingRevision.para_category || 'inbox',
              classifier: 'manual',
              reasoning: `revision already exists for ${rawFilePath}`,
              applied: true,
            });
            return {
              ok: true,
              id: existingRevision.id,
              message: `기존 revision 유지 (id=${existingRevision.id})`,
              embedded: false,
              embeddingDim: null,
              embeddingWarning: null,
            };
          }
        }
      }

      // 임베딩 생성 (graceful — 서버 미가동/실패 시 NULL 적재, 적재 자체는 진행)
      const textToEmbed = entry.content || entry.title;
      const embeddingResult = await this.embeddingFactory(textToEmbed);
      const embedding = embeddingResult.embedding;
      const embeddingStr = embedding ? `[${embedding.join(',')}]` : null;
      const hasCoordColumns = await this._hasCoordColumns();
      const columns = ['title', 'type', 'content', 'tags', 'para_category', 'file_path', 'source', 'meta', 'embedding'];
      const values = ['$1', '$2', '$3', '$4', "'inbox'", '$5', '$6', '$7', '$8::vector'];
      const params = [
        entry.title,
        entry.type || 'note',
        entry.content || null,
        entry.tags || [],
        effectiveFilePath,
        entry.source || 'vault',
        JSON.stringify(effectiveMeta),
        embeddingStr,
      ];
      if (hasCoordColumns) {
        for (const column of COORD_COLUMNS) {
          columns.push(column);
          params.push(baseCoords[column]);
          values.push(`$${params.length}`);
        }
      }

      const rows = await this.pgPool.query('sigma', `
        INSERT INTO sigma.vault_entries (${columns.join(', ')})
        VALUES (${values.join(', ')})
        ON CONFLICT (file_path) WHERE file_path IS NOT NULL
        DO NOTHING
        RETURNING id
      `, params);

      let id = rows?.[0]?.id || rows?.rows?.[0]?.id;
      if (!id && effectiveFilePath) {
        const existing = await this._findEntryByFilePath(effectiveFilePath);
        id = existing?.id;
      }

      await this._writeAudit({
        entryId: id,
        action: effectiveFilePath !== (entry.filePath || null) ? 'revised' : 'created',
        toCategory: 'inbox',
        classifier: 'manual',
        reasoning: effectiveFilePath !== (entry.filePath || null)
          ? `immutable raw revision for ${rawFilePath}`
          : undefined,
        applied: true,
      });

      return {
        ok: true,
        id,
        message: `inbox에 추가됨 (id=${id})`,
        embedded: embedding !== null,
        embeddingDim: embeddingResult.dim,
        embeddingWarning: embeddingResult.warning || null,
      };
    } catch (err: any) {
      return { ok: false, message: `addToInbox 실패: ${err?.message || err}`, embedded: false, embeddingDim: null, embeddingWarning: err?.message || String(err) };
    }
  }

  private async _findEntryByFilePath(filePath: string): Promise<Record<string, unknown> | null> {
    const rows = await this.pgPool.query('sigma', `
      SELECT id, title, type, content, source, file_path, para_category, meta
      FROM sigma.vault_entries
      WHERE file_path = $1
      LIMIT 1
    `, [filePath]);
    return (Array.isArray(rows) ? rows : rows?.rows ?? [])[0] || null;
  }

  private async _hasCoordColumns(): Promise<boolean> {
    if (!this.coordColumnCache) {
      this.coordColumnCache = this.pgPool.query('sigma', `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'sigma'
          AND table_name = 'vault_entries'
          AND column_name = ANY($1::text[])
      `, [COORD_COLUMNS])
        .then((rows: any[]) => {
          const set = new Set((Array.isArray(rows) ? rows : rows?.rows ?? []).map((row) => row.column_name));
          return COORD_COLUMNS.every((column) => set.has(column));
        })
        .catch(() => false);
    }
    return this.coordColumnCache;
  }

  async listInbox(): Promise<VaultEntry[]> {
    try {
      const rows = await this.pgPool.query('sigma', `
        SELECT id, title, type, content, tags, para_category, file_path, source, meta, created_at
        FROM sigma.vault_entries
        WHERE para_category = 'inbox' AND status != 'archived'
        ORDER BY created_at DESC
        LIMIT 100
      `, []);
      return (Array.isArray(rows) ? rows : rows?.rows ?? []).map((r: any) => ({
        id: r.id,
        title: r.title,
        type: r.type,
        content: r.content,
        tags: r.tags,
        paraCategory: r.para_category,
        filePath: r.file_path,
        source: r.source,
        meta: r.meta,
      }));
    } catch (_) {
      return [];
    }
  }

  async moveToProject(id: string, projectName: string, opts: { dryRun?: boolean; reasoning?: string } = {}): Promise<{ ok: boolean; message: string }> {
    return this._moveTo(id, 'projects', { subDir: projectName, ...opts });
  }

  async moveToArea(id: string, areaName: string, opts: { dryRun?: boolean; reasoning?: string } = {}): Promise<{ ok: boolean; message: string }> {
    return this._moveTo(id, 'areas', { subDir: areaName, ...opts });
  }

  async moveToResource(id: string, resourceName: string, opts: { dryRun?: boolean; reasoning?: string } = {}): Promise<{ ok: boolean; message: string }> {
    return this._moveTo(id, 'resources', { subDir: resourceName, ...opts });
  }

  async archive(id: string, reason: string, opts: { dryRun?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
    return this._moveTo(id, 'archives', { reasoning: reason, ...opts });
  }

  private async _moveTo(
    id: string,
    toCategory: string,
    opts: { subDir?: string; dryRun?: boolean; reasoning?: string; classifier?: 'rule' | 'llm' | 'manual'; confidence?: number } = {},
  ): Promise<{ ok: boolean; message: string }> {
    const dryRun = opts.dryRun ?? false;
    try {
      // 현재 카테고리 조회
      const rows = await this.pgPool.query(
        'sigma',
        `SELECT para_category FROM sigma.vault_entries WHERE id = $1`,
        [id],
      );
      const current = (Array.isArray(rows) ? rows : rows?.rows ?? [])[0];
      if (!current) return { ok: false, message: `entry not found: ${id}` };

      const fromCategory = current.para_category;

      if (!dryRun) {
        await this.pgPool.query(
          'sigma',
          `UPDATE sigma.vault_entries SET para_category = $1, status = $2 WHERE id = $3`,
          [toCategory, toCategory === 'archives' ? 'archived' : 'classified', id],
        );
      }

      await this._writeAudit({
        entryId: id,
        action: toCategory === 'archives' ? 'archived' : 'moved',
        fromCategory,
        toCategory,
        classifier: opts.classifier || 'manual',
        confidence: opts.confidence,
        reasoning: opts.reasoning,
        applied: !dryRun,
        dryRun,
      });

      return { ok: true, message: `${dryRun ? '[DRY-RUN] ' : ''}${fromCategory} → ${toCategory} (id=${id})` };
    } catch (err: any) {
      return { ok: false, message: `moveTo 실패: ${err?.message || err}` };
    }
  }

  private async _writeAudit(record: VaultAuditRecord): Promise<void> {
    try {
      await this.pgPool.query('sigma', `
        INSERT INTO sigma.vault_audit
          (entry_id, action, from_category, to_category, classifier, confidence, reasoning, applied, dry_run)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        record.entryId || null,
        record.action,
        record.fromCategory || null,
        record.toCategory || null,
        record.classifier || 'manual',
        record.confidence ?? null,
        record.reasoning || null,
        record.applied ?? true,
        record.dryRun ?? false,
      ]);
    } catch (_) {
      // audit 실패는 무시 (main flow 보호)
    }
  }

  async getStats(days = 7): Promise<{ total: number; byCategory: Record<string, number>; recent: number }> {
    try {
      const since = new Date(Date.now() - days * 86400_000).toISOString();
      const [totalRows, catRows, recentRows] = await Promise.allSettled([
        this.pgPool.query('sigma', `SELECT count(*) AS cnt FROM sigma.vault_entries`, []),
        this.pgPool.query('sigma', `SELECT para_category, count(*) AS cnt FROM sigma.vault_entries GROUP BY para_category`, []),
        this.pgPool.query('sigma', `SELECT count(*) AS cnt FROM sigma.vault_entries WHERE created_at > $1`, [since]),
      ]);

      const total = parseInt((totalRows.status === 'fulfilled' ? totalRows.value : [])?.[0]?.cnt || '0', 10);
      const byCategory: Record<string, number> = {};
      if (catRows.status === 'fulfilled') {
        for (const row of (catRows.value || [])) byCategory[row.para_category] = parseInt(row.cnt || '0', 10);
      }
      const recent = parseInt((recentRows.status === 'fulfilled' ? recentRows.value : [])?.[0]?.cnt || '0', 10);
      return { total, byCategory, recent };
    } catch (_) {
      return { total: 0, byCategory: {}, recent: 0 };
    }
  }
}

export default VaultManager;
