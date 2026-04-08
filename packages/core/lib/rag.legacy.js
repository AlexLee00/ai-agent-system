'use strict';

const { execFile } = require('child_process');
const pgPool = require('./pg-pool');
const { getEmbeddingsUrl } = require('./local-llm-client');
const eventLake = require('./event-lake');

const SCHEMA = 'reservation';
const EMBED_MODEL = process.env.EMBED_MODEL || 'qwen3-embed-0.6b';
const EMBED_DIM   = Number(process.env.EMBED_DIM) || 1024;

function getEmbedUrl() {
  return process.env.EMBED_URL || getEmbeddingsUrl() || 'http://127.0.0.1:11434/v1/embeddings';
}

function execCurl(args) {
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

const VALID_COLLECTIONS = [
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
];

function _validateCollection(name) {
  const table = name.startsWith('rag_') ? name : `rag_${name}`;
  if (!VALID_COLLECTIONS.includes(table)) {
    throw new Error(`유효하지 않은 컬렉션: ${name}. 허용: ${VALID_COLLECTIONS.join(', ')}`);
  }
  return table;
}

async function initSchema() {
  await pgPool.run(SCHEMA, 'CREATE EXTENSION IF NOT EXISTS vector', []);

  const createTable = (tableName) => `
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

async function createEmbedding(text) {
  const payload = JSON.stringify({
    model: EMBED_MODEL,
    input: text.slice(0, 8000),
  });

  const raw = await execCurl([
    '-sS',
    '-m', '30',
    getEmbedUrl(),
    '-H', 'Content-Type: application/json',
    '-d', payload,
  ]);

  const resp = JSON.parse(raw);
  if (resp.error) throw new Error(resp.error.message || JSON.stringify(resp.error));
  const vec = resp.data?.[0]?.embedding;
  if (!Array.isArray(vec) || vec.length !== EMBED_DIM) {
    throw new Error(`임베딩 차원 오류: ${vec?.length ?? '없음'} (기대: ${EMBED_DIM})`);
  }
  return vec;
}

async function store(collection, content, metadata = {}, sourceBot = 'unknown', options = {}) {
  if (options.successOnly && !options.isSuccess) {
    console.log(`[rag] Strict Write: 실패 결과 저장 건너뜀 (${sourceBot}/${collection})`);
    return null;
  }
  const table = _validateCollection(collection);
  const embedding = await createEmbedding(content);
  const vecStr = `[${embedding.join(',')}]`;

  const rows = await pgPool.query(SCHEMA, `
    INSERT INTO ${SCHEMA}.${table} (content, embedding, metadata, source_bot)
    VALUES ($1, $2::vector, $3, $4)
    RETURNING id
  `, [content, vecStr, JSON.stringify(metadata), sourceBot]);

  return rows[0].id;
}

async function storeBatch(collection, items, sourceBot = 'unknown') {
  const ids = [];
  for (const item of items) {
    const id = await store(collection, item.content, item.metadata || {}, sourceBot);
    ids.push(id);
  }
  return ids;
}

async function search(collection, query, opts = {}) {
  const table = _validateCollection(collection);
  const { limit = 5, threshold = null, filter = null, sourceBot = null } = opts;

  const embedding = await createEmbedding(query);
  const vecStr = `[${embedding.join(',')}]`;

  const conditions = [];
  const params = [vecStr, limit];
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

  const rows = await pgPool.query(SCHEMA, `
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

  return rows;
}

async function cleanOld(collection, days = 30) {
  const table = _validateCollection(collection);
  const rows = await pgPool.query(SCHEMA, `
    DELETE FROM ${SCHEMA}.${table}
    WHERE created_at < now() - ($1 * INTERVAL '1 day')
    RETURNING id
  `, [days]);
  return rows.length;
}

async function stats(collection) {
  const table = _validateCollection(collection);
  const rows = await pgPool.query(SCHEMA, `
    SELECT
      COUNT(*)        AS total,
      MIN(created_at) AS oldest,
      MAX(created_at) AS newest
    FROM ${SCHEMA}.${table}
  `, []);
  const r = rows[0] || {};
  return {
    total:  parseInt(r.total ?? '0', 10),
    oldest: r.oldest ?? null,
    newest: r.newest ?? null,
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
  sourceBot = 'openclaw',
  successOnly = true,
}) {
  const content = String(userInput || '').trim();
  if (!content) throw new Error('storeExperience: userInput is required');
  if (!intent) throw new Error('storeExperience: intent is required');
  if (!response) throw new Error('storeExperience: response is required');
  if (!result) throw new Error('storeExperience: result is required');
  const normalizedWhy = String(why || '').trim();
  const normalizedResult = String(result).trim().toLowerCase();
  const isSuccess = normalizedResult === 'success' || normalizedResult === 'ok' || String(result) === 'true';
  if (successOnly && !isSuccess) {
    console.log(`[rag] Strict Write: 실패 경험 저장 건너뜀 (${sourceBot}, result=${result})`);
    return null;
  }

  const metadata = {
    intent,
    response,
    result,
    team,
    timestamp: new Date().toISOString(),
    ...(normalizedWhy ? { why: normalizedWhy } : {}),
    ...details,
  };
  const storedContent = normalizedWhy
    ? `${content}\n[이유: ${normalizedWhy}]`
    : content;
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

async function searchExperience(query, opts = {}) {
  const { intent = null, team = null, limit = 5, threshold = null } = opts;
  const filter = { result: 'success' };
  if (intent) filter.intent = intent;
  if (team) filter.team = team;
  return search('experience', query, { limit, threshold, filter });
}

module.exports = {
  initSchema,
  createEmbedding,
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
