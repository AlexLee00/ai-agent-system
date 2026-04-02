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
 *   // 풀 모니터링
 *   const stats = pgPool.getPoolStats(); // 전체 스키마 통계
 *   const stats = pgPool.getPoolStats('claude'); // 특정 스키마
 *
 * 커넥션 설정:
 *   환경변수 PG_HOST / PG_PORT / PG_USER / PG_PASSWORD / PG_DATABASE
 *   기본값: localhost:5432, OS 사용자명, 패스워드 없음, DB=jay
 *
 * 스키마:
 *   getPool(schema) → search_path를 해당 스키마로 설정한 풀 반환
 *   지원 스키마: claude | reservation | investment | ska | agent
 */

const { Pool } = require('pg');
const os = require('os');
const env = require('./env');

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
const VALID_SCHEMAS = new Set(['claude', 'reservation', 'investment', 'ska', 'worker', 'blog', 'agent', 'public']);

// 스키마별 풀 싱글톤 맵
const _pools = new Map();

// ── 재연결 관리 ────────────────────────────────────────────────────────

const MAX_RECONNECT_ATTEMPTS = 10;
const _reconnectState = new Map(); // schema → { timer, attempts }

// 재연결이 필요한 에러 코드/메시지
const RECONNECT_CODES    = new Set(['ECONNREFUSED', '57P01', 'ECONNRESET', 'EPIPE']);
const RECONNECT_MESSAGES = ['connection terminated', 'connection destroyed', 'server closed the connection'];

function _isConnError(err) {
  if (!err) return false;
  return RECONNECT_CODES.has(err.code) ||
    RECONNECT_MESSAGES.some(m => err.message?.includes(m));
}

function _snapshotPoolStats(pool, schema = 'unknown') {
  if (!pool) {
    return {
      schema,
      total: 0,
      idle: 0,
      waiting: 0,
      active: 0,
      utilization: '0%',
    };
  }
  const active = pool.totalCount - pool.idleCount;
  return {
    schema,
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    active,
    utilization: pool.totalCount > 0
      ? (active / pool.totalCount * 100).toFixed(1) + '%'
      : '0%',
  };
}

function _scheduleReconnect(schema, pool) {
  let state = _reconnectState.get(schema) || { timer: null, attempts: 0 };
  if (state.timer) return;  // 이미 재연결 진행 중

  const delay = Math.min(1000 * Math.pow(2, state.attempts), 30000);  // 최대 30초
  console.warn(`[pg-pool:${schema}] ${delay / 1000}초 후 재연결 시도 (${state.attempts + 1}/${MAX_RECONNECT_ATTEMPTS})`);

  state.timer = setTimeout(async () => {
    state.timer = null;
    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      console.log(`[pg-pool:${schema}] ✅ 재연결 성공`);
      state.attempts = 0;
      _reconnectState.set(schema, state);
    } catch (e) {
      state.attempts++;
      _reconnectState.set(schema, state);
      if (state.attempts < MAX_RECONNECT_ATTEMPTS) {
        _scheduleReconnect(schema, pool);
      } else {
        console.error(`[pg-pool:${schema}] ❌ 재연결 최대 시도 초과 (${MAX_RECONNECT_ATTEMPTS}회) — 이후 자동 재시도 중단`);
        state.attempts = 0;  // 리셋 (다음 에러 시 재시도 가능)
        _reconnectState.set(schema, state);
      }
    }
  }, delay);
  _reconnectState.set(schema, state);
}

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
 * 풀 생성 시 자동 재연결 핸들러 등록
 */
function getPool(schema) {
  if (!VALID_SCHEMAS.has(schema)) {
    throw new Error(`[pg-pool] 유효하지 않은 스키마: ${schema}`);
  }
  if (!/^[a-z_]+$/.test(schema)) {
    throw new Error(`[pg-pool] 스키마명 형식 오류: ${schema}`);
  }
  if (_pools.has(schema)) return _pools.get(schema);

  const pool = new Pool({
    ...PG_CONFIG,
    options: `-c search_path=${schema},public`,
  });

  pool.on('error', (err) => {
    console.error(`[pg-pool:${schema}] 커넥션 오류:`, err.message);
    if (_isConnError(err)) {
      console.warn(`[pg-pool:${schema}] PostgreSQL 연결 끊김 감지 — 재연결 예약`);
      _scheduleReconnect(schema, pool);
    }
  });

  _pools.set(schema, pool);
  return pool;
}

/**
 * 연결 에러 시 자동 재시도하는 안전 쿼리 실행 (내부 전용)
 * 연결 에러: 최대 3회 재시도 / 기타 에러: 즉시 throw
 */
async function _safeQuery(pool, sql, params) {
  const MAX_ATTEMPTS = 3;
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await pool.query(sql, params);
    } catch (e) {
      lastErr = e;
      const schema = pool?.options?.options?.match(/search_path=([^,]+)/)?.[1] || 'unknown';
      const stats = _snapshotPoolStats(pool, schema);
      if (!_isConnError(e)) throw e;  // 연결 에러 아니면 즉시 throw
      if (attempt < MAX_ATTEMPTS - 1) {
        const wait = 1000 * (attempt + 1);
        console.warn(`[pg-pool:${schema}] 쿼리 재시도 ${attempt + 1}/${MAX_ATTEMPTS} (${wait}ms 대기): ${e.message} | pool=${JSON.stringify(stats)}`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        console.error(`[pg-pool:${schema}] 쿼리 최종 실패: ${e.message} | pool=${JSON.stringify(stats)} | sql=${String(sql).slice(0, 140)}`);
      }
    }
  }
  throw lastErr;
}

// ── Hub API 경유 (DEV 환경) ───────────────────────────────────────────

async function _queryViaHub(schema, sql, params = []) {
  const { queryOpsDb } = require('./hub-client');
  const result = await queryOpsDb(parameterize(sql), schema, params);
  if (!result) return { rows: [], rowCount: 0 };
  return { rows: result.rows || [], rowCount: result.rowCount || 0 };
}

const _useHub = !env.IS_OPS && !!env.HUB_BASE_URL && !process.env.PG_DIRECT;

// ── 공개 API ──────────────────────────────────────────────────────────

/**
 * SELECT 쿼리 — rows 배열 반환
 * @param {string}   schema  스키마명
 * @param {string}   sql     SQL (? 또는 $N 플레이스홀더)
 * @param {Array}    params  파라미터 배열
 * @returns {Promise<Array>}
 */
async function query(schema, sql, params = []) {
  if (_useHub) {
    const result = await _queryViaHub(schema, sql, params);
    return result.rows;
  }
  const pool = getPool(schema);
  const { rows } = await _safeQuery(pool, parameterize(sql), params);
  return rows;
}

/**
 * INSERT/UPDATE/DELETE — { rowCount, rows } 반환
 */
async function run(schema, sql, params = []) {
  if (_useHub) {
    return _queryViaHub(schema, sql, params);
  }
  const pool = getPool(schema);
  const result = await _safeQuery(pool, parameterize(sql), params);
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
    try { await pool.end(); } catch { /* 무시 */ }
    _pools.delete(schema);
  }
}

// ── 커넥션 풀 모니터링 ────────────────────────────────────────────────

/**
 * 커넥션 풀 상태 조회
 * @param {string} [schema]  스키마명 (생략 시 전체 반환)
 * @returns {{ total, idle, waiting, active, utilization } | Object | null}
 */
function getPoolStats(schema) {
  if (schema) {
    const pool = _pools.get(schema);
    if (!pool) return null;
    const active = pool.totalCount - pool.idleCount;
    return {
      schema,
      total:       pool.totalCount,
      idle:        pool.idleCount,
      waiting:     pool.waitingCount,
      active,
      utilization: pool.totalCount > 0
        ? (active / pool.totalCount * 100).toFixed(1) + '%'
        : '0%',
    };
  }
  const all = {};
  for (const [s, p] of _pools) {
    const active = p.totalCount - p.idleCount;
    all[s] = {
      schema:      s,
      total:       p.totalCount,
      idle:        p.idleCount,
      waiting:     p.waitingCount,
      active,
      utilization: p.totalCount > 0
        ? (active / p.totalCount * 100).toFixed(1) + '%'
        : '0%',
    };
  }
  return all;
}

/**
 * 모든 활성 스키마의 풀 상태 배열 반환
 * @returns {Array<{ schema, total, idle, waiting, active, utilization }>}
 */
function getAllPoolStats() {
  const result = [];
  for (const [s, p] of _pools) {
    const active = p.totalCount - p.idleCount;
    result.push({
      schema:      s,
      total:       p.totalCount,
      idle:        p.idleCount,
      waiting:     p.waitingCount,
      active,
      utilization: p.totalCount > 0
        ? (active / p.totalCount * 100).toFixed(1) + '%'
        : '0%',
    });
  }
  return result;
}

/**
 * 커넥션 풀 건강 상태 점검
 * @param {number} [threshold=0.8] 사용률 경고 임계값 (80%)
 * @returns {{ stats: Array, issues: Array }}
 */
function checkPoolHealth(threshold = 0.8) {
  const stats  = getAllPoolStats();
  const issues = [];
  const maxPool = PG_CONFIG.max;  // 풀 최대 커넥션 수

  for (const s of stats) {
    if (s.total >= maxPool * threshold) {
      issues.push({
        schema: s.schema,
        status: 'warning',
        detail: `커넥션 ${s.total}/${maxPool} (${s.utilization} 사용)`,
      });
    }
    if (s.waiting > 5) {
      issues.push({
        schema: s.schema,
        status: 'warning',
        detail: `대기 쿼리 ${s.waiting}건 — 풀 부족 가능`,
      });
    }
  }

  return { stats, issues };
}

/**
 * 단일 클라이언트 커넥션 획득 (카오스 테스트 / 트랜잭션 수동 관리용)
 * 반드시 사용 후 client.release() 호출 필요
 * @param {string} schema
 * @returns {Promise<import('pg').PoolClient>}
 */
async function getClient(schema) {
  const pool   = getPool(schema);
  const client = await pool.connect();
  await client.query(`SET search_path = ${schema}, public`);
  return client;
}

// 1분마다 풀 80%+ 사용 시 경고 (프로세스 종료 방해 안 함)
const _monitorTimer = setInterval(() => {
  for (const [schema, pool] of _pools) {
    const total = pool.totalCount;
    if (total > 0) {
      const active = total - pool.idleCount;
      const highUtilization = active / total > 0.8;
      // total=1 또는 2에서는 짧은 정상 사용도 경고가 과도하게 찍힐 수 있다.
      // 실제 운영 노이즈를 줄이기 위해 어느 정도 풀 크기가 생기거나 대기열이 있을 때만 경고한다.
      const shouldWarn = highUtilization && (total >= 3 || pool.waitingCount > 0 || active >= 2);
      if (shouldWarn) {
        console.warn(`[pg-pool:${schema}] ⚠️ 커넥션 풀 80%+ 사용: ${active}/${total} (대기: ${pool.waitingCount})`);
      }
    }
  }
}, 60000);
_monitorTimer.unref();  // 프로세스 종료 방해 안 함

// ── Graceful Shutdown ─────────────────────────────────────────────────

let _closing = false;
async function _gracefulClose(signal) {
  if (_closing) return;
  _closing = true;
  console.log(`[pg-pool] ${signal} 수신 — 커넥션 풀 종료`);
  await closeAll().catch(() => {});
  // process.exit() 미호출 — 소비자 코드의 핸들러에 위임
}

process.on('SIGTERM', () => { _gracefulClose('SIGTERM').catch(() => {}); });
process.on('SIGINT',  () => { _gracefulClose('SIGINT').catch(() => {}); });

// ── 모듈 내보내기 ─────────────────────────────────────────────────────

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
  getPoolStats,
  getAllPoolStats,
  checkPoolHealth,
  getClient,
};
