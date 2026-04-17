'use strict';

/**
 * semantic-cache.ts — 시맨틱 LLM 응답 캐시 (Phase 4 Step 3)
 *
 * pgvector로 쿼리 임베딩 비교 → 유사도 0.95+ → 캐시 히트 반환.
 * 신규 응답은 캐시에 저장하여 동일/유사 요청 재계산 방지.
 *
 * 사용 예시:
 *   const cached = await semanticCache.get(prompt, { purpose: 'blog-insight', threshold: 0.95 });
 *   if (cached) return cached;
 *   const result = await callLLM(prompt);
 *   await semanticCache.set(prompt, result, { purpose: 'blog-insight', ttlDays: 7 });
 */

import pgPool = require('./pg-pool');
import rag = require('./rag');

const SCHEMA = 'rag';
const CACHE_TABLE = 'semantic_cache';
const DEFAULT_THRESHOLD = 0.95;
const DEFAULT_TTL_DAYS = 7;

type CacheGetOptions = {
  purpose?: string;
  threshold?: number;
};

type CacheSetOptions = {
  purpose?: string;
  ttlDays?: number;
  metadata?: Record<string, unknown>;
};

type CacheRow = {
  id: number;
  response: string;
  similarity: number;
};

async function ensureSchema(): Promise<void> {
  await pgPool.run(SCHEMA, `
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.${CACHE_TABLE} (
      id         SERIAL PRIMARY KEY,
      purpose    VARCHAR(80) NOT NULL DEFAULT 'general',
      query_hash TEXT NOT NULL,
      query_text TEXT NOT NULL,
      response   TEXT NOT NULL,
      embedding  vector(${rag.EMBED_DIM}),
      hit_count  INTEGER DEFAULT 0,
      expires_at TIMESTAMP,
      metadata   JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `, []);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS ${CACHE_TABLE}_embedding_hnsw_idx
    ON ${SCHEMA}.${CACHE_TABLE} USING hnsw (embedding vector_cosine_ops)
  `, []);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS ${CACHE_TABLE}_purpose_idx
    ON ${SCHEMA}.${CACHE_TABLE} (purpose)
  `, []);
}

let schemaReady = false;
async function getSchema(): Promise<void> {
  if (schemaReady) return;
  await ensureSchema();
  schemaReady = true;
}

async function get(queryText: string, opts: CacheGetOptions = {}): Promise<string | null> {
  try {
    await getSchema();
    const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
    const purpose = opts.purpose || 'general';
    const embedding = await rag.createEmbedding(queryText);
    const vecStr = `[${embedding.join(',')}]`;

    const rows = await pgPool.query<CacheRow>(SCHEMA, `
      SELECT id, response,
             1 - (embedding <=> $1::vector) AS similarity
      FROM ${SCHEMA}.${CACHE_TABLE}
      WHERE
        purpose = $2
        AND (expires_at IS NULL OR expires_at > NOW())
        AND 1 - (embedding <=> $1::vector) >= $3
      ORDER BY embedding <=> $1::vector
      LIMIT 1
    `, [vecStr, purpose, threshold]);

    if (!rows.length) return null;

    // 히트 카운트 증가 (비동기, 실패 무시)
    pgPool.run(SCHEMA, `
      UPDATE ${SCHEMA}.${CACHE_TABLE} SET hit_count = hit_count + 1 WHERE id = $1
    `, [rows[0].id]).catch(() => {});

    return rows[0].response;
  } catch {
    return null;
  }
}

async function set(queryText: string, response: string, opts: CacheSetOptions = {}): Promise<void> {
  try {
    await getSchema();
    const purpose = opts.purpose || 'general';
    const ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS;
    const embedding = await rag.createEmbedding(queryText);
    const vecStr = `[${embedding.join(',')}]`;
    const queryHash = Buffer.from(queryText.slice(0, 256)).toString('base64').slice(0, 64);
    const expiresAt = ttlDays > 0 ? `NOW() + INTERVAL '${ttlDays} days'` : 'NULL';

    await pgPool.run(SCHEMA, `
      INSERT INTO ${SCHEMA}.${CACHE_TABLE}
        (purpose, query_hash, query_text, response, embedding, expires_at, metadata)
      VALUES ($1, $2, $3, $4, $5::vector, ${expiresAt}, $6)
      ON CONFLICT DO NOTHING
    `, [purpose, queryHash, queryText.slice(0, 4000), response.slice(0, 8000), vecStr, JSON.stringify(opts.metadata || {})]);
  } catch {
    // 캐시 저장 실패는 무시 (서비스 중단 방지)
  }
}

async function getOrCompute(
  queryText: string,
  compute: () => Promise<string | null>,
  opts: CacheGetOptions & CacheSetOptions = {},
): Promise<string | null> {
  const cached = await get(queryText, opts);
  if (cached !== null) return cached;

  const result = await compute();
  if (result !== null) {
    await set(queryText, result, opts);
  }
  return result;
}

async function cleanExpired(): Promise<number> {
  try {
    await getSchema();
    const rows = await pgPool.query<{ cnt: string }>(SCHEMA, `
      DELETE FROM ${SCHEMA}.${CACHE_TABLE}
      WHERE expires_at IS NOT NULL AND expires_at < NOW()
      RETURNING id
    `, []);
    return rows.length;
  } catch {
    return 0;
  }
}

export = { get, set, getOrCompute, cleanExpired, ensureSchema };
