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
 *   reservation.rag_experience  OpenClaw/에이전트 경험 triplet
 *
 * 사용법:
 *   const rag = require('../../../packages/core/lib/rag');
 *   await rag.initSchema();
 *   await rag.store('operations', '루나 크립토 사이클 오류', { bot: 'dexter' }, 'dexter');
 *   const hits = await rag.search('operations', '루나 오류', { limit: 5 });
 *
 * 임베딩: 로컬 MLX Qwen3-Embedding-0.6B (1024차원)
 * 인덱스: HNSW (고속 근사 검색)
 */

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
  'rag_video',         // 비디오팀 — 편집 이력, 피드백, EDL 패턴
  'rag_research',      // 다윈팀 — 논문 스캔 결과 / 적합성 평가
  'rag_experience',    // 에이전트 자기학습 — 질문/응답/결과 triplet
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

  console.log('[RAG] 스키마 초기화 완료 (rag_operations, rag_trades, rag_tech, rag_video, rag_experience)');
}

// ── 임베딩 생성 ──────────────────────────────────────────────────────

/**
 * 로컬 MLX embeddings 엔드포인트로 텍스트 임베딩 생성
 * @param {string} text
 * @returns {Promise<number[]>}
 */
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

/**
 * 에이전트 경험 triplet 저장
 * @param {object} params
 * @param {string} params.userInput
 * @param {string} params.intent
 * @param {string} params.response
 * @param {string} params.result
 * @param {string} [params.why]
 * @param {object} [params.details]
 * @param {string} [params.team]
 * @param {string} [params.sourceBot]
 * @returns {Promise<number>}
 */
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
  const isSuccess = normalizedResult === 'success' || normalizedResult === 'ok' || result === true;
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

/**
 * 유사 경험 검색 (성공 경험만)
 * @param {string} query
 * @param {object} [opts]
 * @param {string|null} [opts.intent]
 * @param {string|null} [opts.team]
 * @param {number} [opts.limit]
 * @param {number|null} [opts.threshold]
 * @returns {Promise<Array>}
 */
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
