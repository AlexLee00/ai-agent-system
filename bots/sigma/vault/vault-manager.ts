// @ts-nocheck
'use strict';

// Week 3 Day 15-16: 시그마 Vault Manager (DB 통합)
// sigma.vault_entries + sigma.vault_audit 테이블 연동
// 파일 기반 vault (ts/lib/vault-manager.ts)와 DB를 동기화하는 상위 레이어

import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PROJECT_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../..'
);

const { getEmbeddingsUrl } = require(path.join(PROJECT_ROOT, 'packages/core/lib/local-llm-client'));
const LOCAL_MODEL_EMBED = process.env.EMBED_MODEL || 'qwen3-embed-0.6b';

async function createVaultEmbedding(text: string): Promise<number[] | null> {
  try {
    const url: string = getEmbeddingsUrl();
    if (!url) return null;
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
    return embedding as number[];
  } catch (err: any) {
    console.warn(`[vault-manager] 임베딩 생성 실패 (graceful): ${err?.message || err}`);
    return null;
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
}

export interface VaultAuditRecord {
  entryId?: string;
  action: 'created' | 'classified' | 'moved' | 'archived' | 'tagged';
  fromCategory?: string;
  toCategory?: string;
  classifier?: 'rule' | 'llm' | 'manual';
  confidence?: number;
  reasoning?: string;
  applied?: boolean;
  dryRun?: boolean;
}

export class VaultManager {
  private pgPool: any;

  constructor() {
    this.pgPool = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));
  }

  async addToInbox(entry: VaultEntry): Promise<{ ok: boolean; id?: string; message: string; embedded: boolean }> {
    try {
      // 임베딩 생성 (graceful — 서버 미가동/실패 시 NULL 적재, 적재 자체는 진행)
      const textToEmbed = entry.content || entry.title;
      const embedding = await createVaultEmbedding(textToEmbed);
      const embeddingStr = embedding ? `[${embedding.join(',')}]` : null;

      const rows = await this.pgPool.query('sigma', `
        INSERT INTO sigma.vault_entries (title, type, content, tags, para_category, file_path, source, meta, embedding)
        VALUES ($1, $2, $3, $4, 'inbox', $5, $6, $7, $8::vector)
        ON CONFLICT (file_path) WHERE file_path IS NOT NULL
        DO UPDATE SET
          title = EXCLUDED.title,
          type = EXCLUDED.type,
          content = EXCLUDED.content,
          tags = EXCLUDED.tags,
          source = EXCLUDED.source,
          meta = sigma.vault_entries.meta || EXCLUDED.meta,
          embedding = COALESCE(EXCLUDED.embedding, sigma.vault_entries.embedding),
          updated_at = NOW()
        RETURNING id
      `, [
        entry.title,
        entry.type || 'note',
        entry.content || null,
        entry.tags || [],
        entry.filePath || null,
        entry.source || 'vault',
        JSON.stringify(entry.meta || {}),
        embeddingStr,
      ]);

      const id = rows?.[0]?.id || rows?.rows?.[0]?.id;

      await this._writeAudit({
        entryId: id,
        action: 'created',
        toCategory: 'inbox',
        classifier: 'manual',
        applied: true,
      });

      return { ok: true, id, message: `inbox에 추가됨 (id=${id})`, embedded: embedding !== null };
    } catch (err: any) {
      return { ok: false, message: `addToInbox 실패: ${err?.message || err}`, embedded: false };
    }
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
