'use strict';

/**
 * packages/core/lib/rag.js — RAG (Retrieval-Augmented Generation) 모듈
 *
 * PostgreSQL + pgvector 기반 벡터 검색
 * 별도 DB 없이 기존 reservation 스키마 활용
 *
 * 테이블:
 *   reservation.rag_operations  운영 이슈·알림 (덱스터, 제이)
 *   reservation.rag_trades      투자 매매 기록 (루나팀)
 *   reservation.rag_tech        기술 인텔리전스 (아처)
 *
 * 사용법:
 *   const rag = require('../../../packages/core/lib/rag');
 *   await rag.initSchema();
 *   await rag.store('operations', '루나 크립토 사이클 오류', { bot: 'dexter' }, 'dexter');
 *   const hits = await rag.search('operations', '루나 오류', { limit: 5 });
 *
 * 임베딩: OpenAI text-embedding-3-small (1536차원, $0.02/1M tokens)
 * 인덱스: HNSW (고속 근사 검색)
 */

const https  = require('https');
const pgPool = require('./pg-pool');
const { getOpenAIKey } = require('./llm-keys');

const SCHEMA = 'reservation';
const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIM   = 1536;

// 허용 컬렉션 (SQL Injection 방지용 화이트리스트)
// 기존 rag-system(ChromaDB) 컬렉션 대응 포함
const VALID_COLLECTIONS = [
  // 신규 (이번 세션 추가)
  'rag_operations',    // 운영 이슈·알림 (덱스터, 제이)
  'rag_trades',        // 투자 매매 기록 (루나팀)
  'rag_tech',          // 기술 인텔리전스 (아처)
  // 기존 rag-system 대응 (ChromaDB 마이그레이션)
  'rag_system_docs',   // 시스템 운영 가이드 (TOOLS.md 등)
  'rag_reservations',  // 스카팀 예약 이력
  'rag_market_data',   // 루나팀 주식·암호화폐 뉴스/공시
  'rag_schedule',      // 일정/메모 (미래 확장)
  'rag_work_docs',     // 업무문서 (미래 확장)
  'rag_blog',          // 블로그팀 — 과거 포스팅 / 인기 패턴 / 실전 사례
];

function _validateCollection(name) {
  const table = name.startsWith('rag_') ? name : `rag_${name}`;
  if (!VALID_COLLECTIONS.includes(table)) {
    throw new Error(`유효하지 않은 컬렉션: ${name}. 허용: ${VALID_COLLECTIONS.join(', ')}`);
  }
  return table;
}

// ── 스키마 초기화 ────────────────────────────────────────────────────

/**
 * RAG 테이블 생성 (idempotent)
 * 시스템 시작 시 1회 호출
 */
async function initSchema() {
  // pgvector 확장이 없으면 생성
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
    // HNSW 인덱스 (cosine similarity, 고속 근사 검색)
    await pgPool.run(SCHEMA, `
      CREATE INDEX IF NOT EXISTS ${table}_embedding_hnsw_idx
      ON ${SCHEMA}.${table} USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
    `, []);
    // 메타데이터 GIN 인덱스 (JSONB 필터용)
    await pgPool.run(SCHEMA, `
      CREATE INDEX IF NOT EXISTS ${table}_metadata_gin_idx
      ON ${SCHEMA}.${table} USING gin (metadata)
    `, []);
  }

  console.log('[RAG] 스키마 초기화 완료 (rag_operations, rag_trades, rag_tech)');
}

// ── 임베딩 생성 ──────────────────────────────────────────────────────

/**
 * OpenAI text-embedding-3-small로 텍스트 임베딩 생성
 * @param {string} text
 * @returns {Promise<number[]>}  1536차원 벡터
 */
async function createEmbedding(text) {
  const apiKey = getOpenAIKey();
  if (!apiKey) throw new Error('OpenAI API 키 없음 — RAG 임베딩 불가');

  const body = JSON.stringify({
    model: EMBED_MODEL,
    input: text.slice(0, 8000),  // 최대 8000자 (토큰 절약)
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.openai.com',
      path:     '/v1/embeddings',
      method:   'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const resp = JSON.parse(data);
          if (resp.error) throw new Error(resp.error.message);
          const vec = resp.data?.[0]?.embedding;
          if (!Array.isArray(vec) || vec.length !== EMBED_DIM) {
            throw new Error(`임베딩 차원 오류: ${vec?.length ?? '없음'}`);
          }
          resolve(vec);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('임베딩 타임아웃')); });
    req.write(body);
    req.end();
  });
}

// ── 저장 ────────────────────────────────────────────────────────────

/**
 * 텍스트를 임베딩하여 지정 컬렉션에 저장
 *
 * @param {string} collection  'operations' | 'trades' | 'tech' (또는 'rag_operations' 등)
 * @param {string} content     저장할 텍스트
 * @param {object} metadata    추가 메타데이터 (JSONB)
 * @param {string} sourceBot   생성 봇 이름 (예: 'dexter', 'luna', 'archer')
 * @returns {Promise<number>}  삽입된 행 id
 */
async function store(collection, content, metadata = {}, sourceBot = 'unknown') {
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

/**
 * 여러 텍스트를 일괄 저장 (임베딩 1건씩 순차 — API 제한)
 * @param {string} collection
 * @param {{ content, metadata }[]} items
 * @param {string} sourceBot
 * @returns {Promise<number[]>}  삽입된 id 배열
 */
async function storeBatch(collection, items, sourceBot = 'unknown') {
  const ids = [];
  for (const item of items) {
    const id = await store(collection, item.content, item.metadata || {}, sourceBot);
    ids.push(id);
  }
  return ids;
}

// ── 검색 ────────────────────────────────────────────────────────────

/**
 * 유사도 검색 (코사인 유사도 기반)
 *
 * @param {string} collection        검색 대상 컬렉션
 * @param {string} query             검색 쿼리 텍스트
 * @param {object} opts
 * @param {number}  [opts.limit=5]   최대 결과 수
 * @param {number}  [opts.threshold] 유사도 임계값 (0~1, 미설정 시 무제한)
 * @param {object}  [opts.filter]    JSONB 메타데이터 필터 (예: { bot: 'dexter' })
 * @param {string}  [opts.sourceBot] source_bot 필터
 * @returns {Promise<Array<{ id, content, metadata, source_bot, created_at, similarity }>>}
 */
async function search(collection, query, opts = {}) {
  const table = _validateCollection(collection);
  const { limit = 5, threshold = null, filter = null, sourceBot = null } = opts;

  const embedding = await createEmbedding(query);
  const vecStr = `[${embedding.join(',')}]`;

  // WHERE 절 동적 구성
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
    // JSONB @> 연산자로 메타데이터 필터
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

// ── 삭제 / 유지보수 ──────────────────────────────────────────────────

/**
 * 오래된 벡터 정리 (N일 이상)
 * @param {string} collection
 * @param {number} days
 * @returns {Promise<number>}  삭제 건수
 */
async function cleanOld(collection, days = 30) {
  const table = _validateCollection(collection);
  const rows = await pgPool.query(SCHEMA, `
    DELETE FROM ${SCHEMA}.${table}
    WHERE created_at < now() - ($1 * INTERVAL '1 day')
    RETURNING id
  `, [days]);
  return rows.length;
}

/**
 * 컬렉션 통계 조회
 * @param {string} collection
 * @returns {Promise<{ total, oldest, newest }>}
 */
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

module.exports = {
  initSchema,
  createEmbedding,
  store,
  storeBatch,
  search,
  cleanOld,
  stats,
  VALID_COLLECTIONS,
  EMBED_MODEL,
  EMBED_DIM,
};
