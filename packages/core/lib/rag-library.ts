import pgPool = require('./pg-pool');
import rag = require('./rag');

type SchemaIndexRow = {
  id: number;
  collection: string;
  title: string;
  category: string | null;
  tags: string[] | null;
  agent: string | null;
  doc_count: number | string | null;
  chunk_count: number | string | null;
  date_range_start: string | null;
  date_range_end: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type SummaryRow = {
  id: number;
  doc_id: number;
  source_collection: string;
  summary: string;
  keywords: string[] | null;
  agent: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  similarity?: number;
};

type SearchSchemaOptions = {
  category?: string | null;
  agent?: string | null;
  collection?: string | null;
  limit?: number;
};

type UpsertSchemaIndexInput = {
  collection: string;
  title: string;
  category?: string | null;
  tags?: string[] | null;
  agent?: string | null;
  docCount?: number;
  chunkCount?: number;
  dateRangeStart?: string | null;
  dateRangeEnd?: string | null;
  metadata?: Record<string, unknown> | null;
};

type UpsertSummaryInput = {
  docId: number;
  sourceCollection: string;
  summary: string;
  keywords?: string[] | null;
  agent?: string | null;
  metadata?: Record<string, unknown> | null;
};

type SearchSummaryOptions = {
  collections?: string[];
  agent?: string | null;
  limit?: number;
  threshold?: number | null;
};

type LibrarySearchOptions = {
  category?: string | null;
  agent?: string | null;
  summaryLimit?: number;
  schemaLimit?: number;
  threshold?: number | null;
};

type LibrarySearchResult = {
  schemas: SchemaIndexRow[];
  summaries: SummaryRow[];
};

const SCHEMA = 'rag';

async function ensureLibrarySchema(): Promise<void> {
  await pgPool.run(SCHEMA, 'CREATE SCHEMA IF NOT EXISTS rag', []);
  await pgPool.run(SCHEMA, 'CREATE EXTENSION IF NOT EXISTS vector', []);

  await pgPool.run(SCHEMA, `
    CREATE TABLE IF NOT EXISTS rag.schema_index (
      id SERIAL PRIMARY KEY,
      collection VARCHAR(50) NOT NULL,
      title TEXT NOT NULL,
      category VARCHAR(50),
      tags TEXT[] DEFAULT '{}',
      agent VARCHAR(50),
      doc_count INTEGER DEFAULT 0,
      chunk_count INTEGER DEFAULT 0,
      date_range_start DATE,
      date_range_end DATE,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `, []);
  await pgPool.run(SCHEMA, `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rag_schema_index_collection_title
    ON rag.schema_index (collection, title)
  `, []);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_rag_schema_index_collection
    ON rag.schema_index (collection)
  `, []);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_rag_schema_index_agent
    ON rag.schema_index (agent)
  `, []);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_rag_schema_index_category
    ON rag.schema_index (category)
  `, []);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_rag_schema_index_tags
    ON rag.schema_index USING gin (tags)
  `, []);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_rag_schema_index_metadata
    ON rag.schema_index USING gin (metadata)
  `, []);

  await pgPool.run(SCHEMA, `
    CREATE TABLE IF NOT EXISTS rag.summary (
      id SERIAL PRIMARY KEY,
      doc_id BIGINT NOT NULL,
      source_collection VARCHAR(50) NOT NULL,
      summary TEXT NOT NULL,
      keywords TEXT[] DEFAULT '{}',
      agent VARCHAR(50),
      embedding vector(${rag.EMBED_DIM}),
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `, []);
  await pgPool.run(SCHEMA, `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rag_summary_collection_doc
    ON rag.summary (source_collection, doc_id)
  `, []);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_rag_summary_embedding
    ON rag.summary USING hnsw (embedding vector_cosine_ops)
  `, []);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_rag_summary_collection
    ON rag.summary (source_collection)
  `, []);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_rag_summary_agent
    ON rag.summary (agent)
  `, []);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_rag_summary_keywords
    ON rag.summary USING gin (keywords)
  `, []);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_rag_summary_metadata
    ON rag.summary USING gin (metadata)
  `, []);
}

function buildKeywordLikeConditions(query: string, fields: string[], params: unknown[], startIndex: number): { sql: string; nextIndex: number } {
  const tokens = String(query || '')
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .slice(0, 8);

  if (!tokens.length) return { sql: '', nextIndex: startIndex };

  const clauses: string[] = [];
  let idx = startIndex;
  for (const token of tokens) {
    const parts = fields.map((field) => `${field} ILIKE $${idx}`);
    clauses.push(`(${parts.join(' OR ')})`);
    params.push(`%${token}%`);
    idx += 1;
  }
  return { sql: clauses.join(' AND '), nextIndex: idx };
}

async function upsertSchemaIndex(input: UpsertSchemaIndexInput): Promise<number | null> {
  await ensureLibrarySchema();
  const rows = await pgPool.query<{ id: number }>(SCHEMA, `
    INSERT INTO rag.schema_index (
      collection,
      title,
      category,
      tags,
      agent,
      doc_count,
      chunk_count,
      date_range_start,
      date_range_end,
      metadata,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
    ON CONFLICT (collection, title)
    DO UPDATE SET
      category = EXCLUDED.category,
      tags = EXCLUDED.tags,
      agent = EXCLUDED.agent,
      doc_count = EXCLUDED.doc_count,
      chunk_count = EXCLUDED.chunk_count,
      date_range_start = EXCLUDED.date_range_start,
      date_range_end = EXCLUDED.date_range_end,
      metadata = EXCLUDED.metadata,
      updated_at = NOW()
    RETURNING id
  `, [
    input.collection,
    input.title,
    input.category || null,
    input.tags || [],
    input.agent || null,
    input.docCount || 0,
    input.chunkCount || 0,
    input.dateRangeStart || null,
    input.dateRangeEnd || null,
    JSON.stringify(input.metadata || {}),
  ]);
  return rows[0]?.id ?? null;
}

async function searchSchemaIndex(query: string, opts: SearchSchemaOptions = {}): Promise<SchemaIndexRow[]> {
  await ensureLibrarySchema();
  const { category = null, agent = null, collection = null, limit = 10 } = opts;
  const params: unknown[] = [];
  const where: string[] = [];
  let idx = 1;

  if (collection) {
    where.push(`collection = $${idx++}`);
    params.push(collection);
  }
  if (category) {
    where.push(`category = $${idx++}`);
    params.push(category);
  }
  if (agent) {
    where.push(`agent = $${idx++}`);
    params.push(agent);
  }

  const keywordFields = ['collection', 'title', "COALESCE(category, '')", "array_to_string(tags, ' ')", "COALESCE(agent, '')"];
  const keyword = buildKeywordLikeConditions(query, keywordFields, params, idx);
  if (keyword.sql) {
    where.push(keyword.sql);
    idx = keyword.nextIndex;
  }

  params.push(limit);
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return pgPool.query<SchemaIndexRow>(SCHEMA, `
    SELECT *
    FROM rag.schema_index
    ${whereClause}
    ORDER BY updated_at DESC, id DESC
    LIMIT $${idx}
  `, params);
}

async function upsertSummary(input: UpsertSummaryInput): Promise<number | null> {
  await ensureLibrarySchema();
  const embedding = await rag.createEmbedding(input.summary);
  const vecStr = `[${embedding.join(',')}]`;
  const rows = await pgPool.query<{ id: number }>(SCHEMA, `
    INSERT INTO rag.summary (
      doc_id,
      source_collection,
      summary,
      keywords,
      agent,
      embedding,
      metadata,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6::vector, $7, NOW())
    ON CONFLICT (source_collection, doc_id)
    DO UPDATE SET
      summary = EXCLUDED.summary,
      keywords = EXCLUDED.keywords,
      agent = EXCLUDED.agent,
      embedding = EXCLUDED.embedding,
      metadata = EXCLUDED.metadata,
      updated_at = NOW()
    RETURNING id
  `, [
    input.docId,
    input.sourceCollection,
    input.summary,
    input.keywords || [],
    input.agent || null,
    vecStr,
    JSON.stringify(input.metadata || {}),
  ]);
  return rows[0]?.id ?? null;
}

async function searchSummaries(query: string, opts: SearchSummaryOptions = {}): Promise<SummaryRow[]> {
  await ensureLibrarySchema();
  const { collections = [], agent = null, limit = 10, threshold = 0.6 } = opts;
  const embedding = await rag.createEmbedding(query);
  const vecStr = `[${embedding.join(',')}]`;
  const params: unknown[] = [vecStr];
  const where: string[] = [];
  let idx = 2;

  if (collections.length > 0) {
    where.push(`source_collection = ANY($${idx++})`);
    params.push(collections);
  }
  if (agent) {
    where.push(`agent = $${idx++}`);
    params.push(agent);
  }
  if (threshold !== null) {
    where.push(`1 - (embedding <=> $1::vector) >= $${idx++}`);
    params.push(threshold);
  }

  params.push(limit);
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return pgPool.query<SummaryRow>(SCHEMA, `
    SELECT
      *,
      1 - (embedding <=> $1::vector) AS similarity
    FROM rag.summary
    ${whereClause}
    ORDER BY embedding <=> $1::vector
    LIMIT $${idx}
  `, params);
}

async function librarySearch(query: string, opts: LibrarySearchOptions = {}): Promise<LibrarySearchResult> {
  const schemas = await searchSchemaIndex(query, {
    category: opts.category,
    agent: opts.agent,
    limit: opts.schemaLimit || 10,
  });
  const collections = [...new Set(schemas.map((row) => row.collection).filter(Boolean))];
  const summaries = collections.length
    ? await searchSummaries(query, {
        collections,
        agent: opts.agent,
        limit: opts.summaryLimit || 10,
        threshold: opts.threshold ?? 0.6,
      })
    : [];

  return { schemas, summaries };
}

export = {
  ensureLibrarySchema,
  upsertSchemaIndex,
  searchSchemaIndex,
  upsertSummary,
  searchSummaries,
  librarySearch,
};
