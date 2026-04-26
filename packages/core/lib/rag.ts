import { execFile } from 'node:child_process';
import pgPool = require('./pg-pool');

const { getEmbeddingsUrl, resolveEmbeddingModel } = require('./local-llm-client') as {
  getEmbeddingsUrl: () => string | null | undefined;
  resolveEmbeddingModel: (model?: string) => Promise<string>;
};

const eventLake = require('./event-lake') as {
  record: (input: {
    eventType: string;
    team?: string;
    botName?: string;
    severity?: string;
    title?: string;
    message?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }) => Promise<unknown>;
};

type RagCollection =
  | 'rag_operations'
  | 'rag_trades'
  | 'rag_tech'
  | 'rag_system_docs'
  | 'rag_reservations'
  | 'rag_market_data'
  | 'rag_schedule'
  | 'rag_work_docs'
  | 'rag_blog'
  | 'rag_video'
  | 'rag_research'
  | 'rag_experience'
  | 'rag_legal';

type RagRow = {
  id: number;
  content: string;
  metadata: Record<string, unknown>;
  source_bot: string;
  created_at: string;
  similarity: number;
};

type SearchOptions = {
  limit?: number;
  threshold?: number | null;
  filter?: Record<string, unknown> | null;
  sourceBot?: string | null;
};

type StoreOptions = {
  successOnly?: boolean;
  isSuccess?: boolean;
};

type StatsRow = {
  total?: string | number;
  oldest?: string | null;
  newest?: string | null;
};

type ExperienceInput = {
  userInput: string;
  intent: string;
  response: string;
  result: string | boolean;
  why?: string;
  details?: Record<string, unknown>;
  team?: string;
  sourceBot?: string;
  successOnly?: boolean;
};

const SCHEMA = 'reservation';
const DEFAULT_EMBED_MODEL = 'qwen3-embed-0.6b';
const EMBED_MODEL = /embed/i.test(process.env.EMBED_MODEL || '')
  ? String(process.env.EMBED_MODEL)
  : DEFAULT_EMBED_MODEL;
const EMBED_DIM = Number(process.env.EMBED_DIM) || 1024;

if (process.env.EMBED_MODEL && !/embed/i.test(process.env.EMBED_MODEL)) {
  console.warn(`[rag] EMBED_MODEL='${process.env.EMBED_MODEL}' 부적합 → '${DEFAULT_EMBED_MODEL}' 사용`);
}

function getEmbedUrl(): string {
  return process.env.EMBED_URL || getEmbeddingsUrl() || 'http://127.0.0.1:11434/v1/embeddings';
}

function execCurl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('curl', args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr?.trim() || stdout?.trim() || error.message;
        reject(new Error(detail));
        return;
      }
      resolve(stdout);
    });
  });
}

const VALID_COLLECTIONS: RagCollection[] = [
  'rag_operations',
  'rag_trades',
  'rag_tech',
  'rag_system_docs',
  'rag_reservations',
  'rag_market_data',
  'rag_schedule',
  'rag_work_docs',
  'rag_blog',
  'rag_video',
  'rag_research',
  'rag_experience',
  'rag_legal',
];

function _validateCollection(name: string): RagCollection {
  const table = (name.startsWith('rag_') ? name : `rag_${name}`) as RagCollection;
  if (!VALID_COLLECTIONS.includes(table)) {
    throw new Error(`유효하지 않은 컬렉션: ${name}. 허용: ${VALID_COLLECTIONS.join(', ')}`);
  }
  return table;
}

async function initSchema(): Promise<void> {
  await pgPool.run(SCHEMA, 'CREATE EXTENSION IF NOT EXISTS vector', []);

  const createTable = (tableName: string): string => `
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.${tableName} (
      id          BIGSERIAL PRIMARY KEY,
      content     TEXT        NOT NULL,
      embedding   vector(${EMBED_DIM}),
      metadata    JSONB       NOT NULL DEFAULT '{}',
      source_bot  TEXT        NOT NULL DEFAULT 'unknown',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  for (const table of VALID_COLLECTIONS) {
    await pgPool.run(SCHEMA, createTable(table), []);
    await pgPool.run(SCHEMA, `
      CREATE INDEX IF NOT EXISTS ${table}_embedding_hnsw_idx
      ON ${SCHEMA}.${table} USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
    `, []);
    await pgPool.run(SCHEMA, `
      CREATE INDEX IF NOT EXISTS ${table}_metadata_gin_idx
      ON ${SCHEMA}.${table} USING gin (metadata)
    `, []);
  }

  console.log('[RAG] 스키마 초기화 완료 (rag_operations, rag_trades, rag_tech, rag_video, rag_experience)');
}

async function createEmbedding(text: string): Promise<number[]> {
  const embedModel = await resolveEmbeddingModel(EMBED_MODEL);
  const payload = JSON.stringify({
    model: embedModel,
    input: text.slice(0, 8000),
  });

  const raw = await execCurl([
    '-sS',
    '-m', '30',
    getEmbedUrl(),
    '-H', 'Content-Type: application/json',
    '-d', payload,
  ]);

  const resp = JSON.parse(raw) as {
    error?: { message?: string };
    data?: Array<{ embedding?: number[] }>;
  };
  if (resp.error) throw new Error(resp.error.message || JSON.stringify(resp.error));
  const vec = resp.data?.[0]?.embedding;
  if (!Array.isArray(vec) || vec.length !== EMBED_DIM) {
    throw new Error(`임베딩 차원 오류: ${vec?.length ?? '없음'} (기대: ${EMBED_DIM})`);
  }
  return vec;
}

// 배치 임베딩 — 최대 BATCH_EMBED_SIZE개씩 묶어서 단일 API 호출 (Step 1)
const BATCH_EMBED_SIZE = 16;

async function createEmbeddingBatch(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  if (texts.length === 1) return [await createEmbedding(texts[0])];

  const embedModel = await resolveEmbeddingModel(EMBED_MODEL);
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_EMBED_SIZE) {
    const chunk = texts.slice(i, i + BATCH_EMBED_SIZE).map((t) => t.slice(0, 8000));
    const payload = JSON.stringify({ model: embedModel, input: chunk });

    const raw = await execCurl([
      '-sS',
      '-m', String(30 + chunk.length * 5),
      getEmbedUrl(),
      '-H', 'Content-Type: application/json',
      '-d', payload,
    ]);

    const resp = JSON.parse(raw) as {
      error?: { message?: string };
      data?: Array<{ embedding?: number[]; index?: number }>;
    };
    if (resp.error) throw new Error(resp.error.message || JSON.stringify(resp.error));
    const data = resp.data || [];
    // data는 index 순서 보장 (OpenAI 호환 스펙)
    for (let j = 0; j < chunk.length; j++) {
      const item = data.find((d) => d.index === j) || data[j];
      const vec = item?.embedding;
      if (!Array.isArray(vec) || vec.length !== EMBED_DIM) {
        throw new Error(`배치 임베딩 차원 오류 [${i + j}]: ${vec?.length ?? '없음'} (기대: ${EMBED_DIM})`);
      }
      results.push(vec);
    }
  }

  return results;
}

async function store(
  collection: string,
  content: string,
  metadata: Record<string, unknown> = {},
  sourceBot = 'unknown',
  options: StoreOptions = {},
): Promise<number | null> {
  if (options.successOnly && !options.isSuccess) {
    console.log(`[rag] Strict Write: 실패 결과 저장 건너뜀 (${sourceBot}/${collection})`);
    return null;
  }
  const table = _validateCollection(collection);
  const embedding = await createEmbedding(content);
  const vecStr = `[${embedding.join(',')}]`;

  const rows = await pgPool.query<{ id: number }>(SCHEMA, `
    INSERT INTO ${SCHEMA}.${table} (content, embedding, metadata, source_bot)
    VALUES ($1, $2::vector, $3, $4)
    RETURNING id
  `, [content, vecStr, JSON.stringify(metadata), sourceBot]);

  return rows[0]?.id ?? null;
}

async function storeBatch(
  collection: string,
  items: Array<{ content: string; metadata?: Record<string, unknown> }>,
  sourceBot = 'unknown',
): Promise<Array<number | null>> {
  if (!items.length) return [];
  const table = _validateCollection(collection);

  // 배치 임베딩 — 단일 API 호출로 전체 처리
  const embeddings = await createEmbeddingBatch(items.map((item) => item.content));

  const ids: Array<number | null> = [];
  for (let i = 0; i < items.length; i++) {
    const { content, metadata = {} } = items[i];
    const vecStr = `[${embeddings[i].join(',')}]`;
    try {
      const rows = await pgPool.query<{ id: number }>(SCHEMA, `
        INSERT INTO ${SCHEMA}.${table} (content, embedding, metadata, source_bot)
        VALUES ($1, $2::vector, $3, $4)
        RETURNING id
      `, [content, vecStr, JSON.stringify(metadata), sourceBot]);
      ids.push(rows[0]?.id ?? null);
    } catch (err: unknown) {
      console.warn(`[rag] storeBatch 항목 ${i} 실패: ${err instanceof Error ? err.message : err}`);
      ids.push(null);
    }
  }
  return ids;
}

async function search(collection: string, query: string, opts: SearchOptions = {}): Promise<RagRow[]> {
  const table = _validateCollection(collection);
  const { limit = 5, threshold = null, filter = null, sourceBot = null } = opts;

  const embedding = await createEmbedding(query);
  const vecStr = `[${embedding.join(',')}]`;

  const conditions: string[] = [];
  const params: unknown[] = [vecStr, limit];
  let idx = 3;

  if (threshold !== null) {
    conditions.push(`1 - (embedding <=> $1::vector) >= $${idx++}`);
    params.push(threshold);
  }
  if (sourceBot) {
    conditions.push(`source_bot = $${idx++}`);
    params.push(sourceBot);
  }
  if (filter && typeof filter === 'object') {
    conditions.push(`metadata @> $${idx++}`);
    params.push(JSON.stringify(filter));
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  return pgPool.query<RagRow>(SCHEMA, `
    SELECT
      id,
      content,
      metadata,
      source_bot,
      created_at,
      1 - (embedding <=> $1::vector) AS similarity
    FROM ${SCHEMA}.${table}
    ${whereClause}
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  `, params);
}

async function cleanOld(collection: string, days = 30): Promise<number> {
  const table = _validateCollection(collection);
  const rows = await pgPool.query<{ id: number }>(SCHEMA, `
    DELETE FROM ${SCHEMA}.${table}
    WHERE created_at < now() - ($1 * INTERVAL '1 day')
    RETURNING id
  `, [days]);
  return rows.length;
}

async function stats(collection: string): Promise<{ total: number; oldest: string | null; newest: string | null }> {
  const table = _validateCollection(collection);
  const rows = await pgPool.query<StatsRow>(SCHEMA, `
    SELECT
      COUNT(*)        AS total,
      MIN(created_at) AS oldest,
      MAX(created_at) AS newest
    FROM ${SCHEMA}.${table}
  `, []);
  const row = rows[0] || {};
  return {
    total: Number.parseInt(String(row.total ?? '0'), 10),
    oldest: row.oldest ?? null,
    newest: row.newest ?? null,
  };
}

async function storeExperience({
  userInput,
  intent,
  response,
  result,
  why = '',
  details = {},
  team = 'general',
  sourceBot = 'hub',
  successOnly = true,
}: ExperienceInput): Promise<number | null> {
  const content = String(userInput || '').trim();
  if (!content) throw new Error('storeExperience: userInput is required');
  if (!intent) throw new Error('storeExperience: intent is required');
  if (!response) throw new Error('storeExperience: response is required');
  if (result == null || result === '') throw new Error('storeExperience: result is required');
  const normalizedWhy = String(why || '').trim();
  const normalizedResult = String(result).trim().toLowerCase();
  const isSuccess = normalizedResult === 'success' || normalizedResult === 'ok' || String(result) === 'true';
  if (successOnly && !isSuccess) {
    console.log(`[rag] Strict Write: 실패 경험 저장 건너뜀 (${sourceBot}, result=${result})`);
    return null;
  }

  const metadata: Record<string, unknown> = {
    intent,
    response,
    result,
    team,
    timestamp: new Date().toISOString(),
    ...(normalizedWhy ? { why: normalizedWhy } : {}),
    ...details,
  };
  const storedContent = normalizedWhy ? `${content}\n[이유: ${normalizedWhy}]` : content;
  const id = await store('experience', storedContent, metadata, sourceBot, { successOnly, isSuccess });
  eventLake.record({
    eventType: 'experience_recorded',
    team,
    botName: sourceBot,
    severity: isSuccess ? 'info' : 'warn',
    title: intent,
    message: storedContent.slice(0, 500),
    tags: ['experience', intent, isSuccess ? 'success' : 'failure'],
    metadata: {
      rag_id: id,
      result,
      why: normalizedWhy,
    },
  }).catch(() => {});
  return id;
}

async function searchExperience(
  query: string,
  opts: { intent?: string | null; team?: string | null; limit?: number; threshold?: number | null } = {},
): Promise<RagRow[]> {
  const { intent = null, team = null, limit = 5, threshold = null } = opts;
  const filter: Record<string, unknown> = { result: 'success' };
  if (intent) filter.intent = intent;
  if (team) filter.team = team;
  return search('experience', query, { limit, threshold, filter });
}

export = {
  initSchema,
  createEmbedding,
  createEmbeddingBatch,
  store,
  storeBatch,
  search,
  cleanOld,
  stats,
  storeExperience,
  searchExperience,
  VALID_COLLECTIONS,
  EMBED_MODEL,
  EMBED_DIM,
};
