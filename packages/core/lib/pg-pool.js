'use strict';

/**
 * packages/core/lib/pg-pool.js — PostgreSQL 커넥션 풀 싱글톤
 *
 * 사용법:
 *   const pgPool = require('./pg-pool');
 *
 *   // 직접 쿼리
 *   const rows = await pgPool.query('claude', 'SELECT * FROM agent_state WHERE agent = $1', ['dexter']);
 *   await pgPool.run('reservation', 'INSERT INTO alerts (msg) VALUES ($1)', ['hello']);
 *
 *   // better-sqlite3 호환 API
 *   const stmt = pgPool.prepare('claude', 'SELECT * FROM messages WHERE id = $1');
 *   const row  = await stmt.get(42);
 *   const rows = await stmt.all();
 *   await stmt.run(42);
 *
 *   // ? → $N 자동 변환 (기존 코드 호환)
 *   const rows = await pgPool.query('claude', 'SELECT * FROM t WHERE a = ? AND b = ?', [1, 2]);
 *
 * 커넥션 설정:
 *   환경변수 PG_HOST / PG_PORT / PG_USER / PG_PASSWORD / PG_DATABASE
 *   기본값: localhost:5432, OS 사용자명, 패스워드 없음, DB=jay
 *
 * 스키마:
 *   getPool(schema) → search_path를 해당 스키마로 설정한 풀 반환
 *   지원 스키마: claude | reservation | investment | ska
 */

const { Pool } = require('pg');
const os = require('os');

// ── 설정 ──────────────────────────────────────────────────────────────

const PG_CONFIG = {
  host:     process.env.PG_HOST     || 'localhost',
  port:     parseInt(process.env.PG_PORT || '5432', 10),
  user:     process.env.PG_USER     || os.userInfo().username,
  password: process.env.PG_PASSWORD || undefined,
  database: process.env.PG_DATABASE || 'jay',
  max:      10,           // 풀 최대 연결 수
  idleTimeoutMillis:    60000,
  connectionTimeoutMillis: 5000,
};

// 유효 스키마 목록
const VALID_SCHEMAS = new Set(['claude', 'reservation', 'investment', 'ska', 'public']);

// 스키마별 풀 싱글톤 맵
const _pools = new Map();

// ── 내부 헬퍼 ─────────────────────────────────────────────────────────

/**
 * ? 플레이스홀더를 $1, $2 ... 로 변환
 * 이미 $N 형식이면 그대로 반환
 */
function parameterize(sql) {
  if (!sql || !sql.includes('?')) return sql;
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

/**
 * 스키마별 커넥션 풀 반환 (싱글톤)
 */
function getPool(schema) {
  if (!VALID_SCHEMAS.has(schema)) {
    throw new Error(`[pg-pool] 유효하지 않은 스키마: ${schema}`);
  }
  if (_pools.has(schema)) return _pools.get(schema);

  const pool = new Pool({
    ...PG_CONFIG,
    // 커넥션 획득 시 search_path 설정
    options: `-c search_path=${schema},public`,
  });

  // 커넥션 오류 로깅
  pool.on('error', (err) => {
    console.error(`[pg-pool:${schema}] 커넥션 오류:`, err.message);
  });

  _pools.set(schema, pool);
  return pool;
}

// ── 공개 API ──────────────────────────────────────────────────────────

/**
 * SELECT 쿼리 — rows 배열 반환
 * @param {string}   schema  스키마명
 * @param {string}   sql     SQL (? 또는 $N 플레이스홀더)
 * @param {Array}    params  파라미터 배열
 * @returns {Promise<Array>}
 */
async function query(schema, sql, params = []) {
  const pool = getPool(schema);
  const { rows } = await pool.query(parameterize(sql), params);
  return rows;
}

/**
 * INSERT/UPDATE/DELETE — { rowCount, rows } 반환
 */
async function run(schema, sql, params = []) {
  const pool = getPool(schema);
  const result = await pool.query(parameterize(sql), params);
  return { rowCount: result.rowCount, rows: result.rows };
}

/**
 * 단일 행 SELECT — row 또는 null 반환
 */
async function get(schema, sql, params = []) {
  const rows = await query(schema, sql, params);
  return rows[0] || null;
}

/**
 * better-sqlite3 호환 prepare() 인터페이스
 * stmt.get(...params) / stmt.all(...params) / stmt.run(...params)
 *
 * 주의: 결과가 Promise이므로 소비자에서 await 필요
 */
function prepare(schema, sql) {
  const normalized = parameterize(sql);
  return {
    get:  (...args) => get(schema, normalized, args.flat()),
    all:  (...args) => query(schema, normalized, args.flat()),
    run:  (...args) => run(schema, normalized, args.flat()),
  };
}

/**
 * 트랜잭션 실행
 * @param {string}   schema
 * @param {Function} fn  async (client) => { ... }
 */
async function transaction(schema, fn) {
  const pool = getPool(schema);
  const client = await pool.connect();
  try {
    await client.query(`SET search_path = ${schema}, public`);
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 연결 테스트
 */
async function ping(schema = 'public') {
  try {
    const rows = await query(schema, 'SELECT 1 AS ok');
    return rows[0]?.ok === 1;
  } catch {
    return false;
  }
}

/**
 * 전체 풀 종료 (프로세스 종료 시)
 */
async function closeAll() {
  for (const [schema, pool] of _pools) {
    await pool.end();
    _pools.delete(schema);
  }
}

module.exports = {
  getPool,
  parameterize,
  query,
  run,
  get,
  prepare,
  transaction,
  ping,
  closeAll,
};
