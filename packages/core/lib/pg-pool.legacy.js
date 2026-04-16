'use strict';

const { Pool } = require('pg');
const os = require('os');
const env = require('./env');

const PG_CONFIG = {
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  user: process.env.PG_USER || os.userInfo().username,
  password: process.env.PG_PASSWORD || undefined,
  database: process.env.PG_DATABASE || 'jay',
  max: parseInt(
    process.env.PG_POOL_MAX || ((env.IS_OPS || env.IS_CLI) ? '2' : '4'),
    10
  ),
  idleTimeoutMillis: parseInt(
    process.env.PG_IDLE_TIMEOUT_MS || ((env.IS_OPS || env.IS_CLI) ? '5000' : '15000'),
    10
  ),
  allowExitOnIdle: true,
  connectionTimeoutMillis: 5000,
};

const VALID_SCHEMAS = new Set(['claude', 'reservation', 'investment', 'ska', 'worker', 'blog', 'agent', 'sigma', 'public']);
const _pools = new Map();

const MAX_RECONNECT_ATTEMPTS = 10;
const _reconnectState = new Map();
const RECONNECT_CODES = new Set(['ECONNREFUSED', '57P01', 'ECONNRESET', 'EPIPE']);
const RECONNECT_MESSAGES = ['connection terminated', 'connection destroyed', 'server closed the connection'];

function _isConnError(err) {
  if (!err) return false;
  return RECONNECT_CODES.has(err.code) ||
    RECONNECT_MESSAGES.some(m => err.message?.includes(m));
}

function _snapshotPoolStats(pool, schema = 'unknown') {
  if (!pool) {
    return { schema, total: 0, idle: 0, waiting: 0, active: 0, utilization: '0%' };
  }
  const active = pool.totalCount - pool.idleCount;
  return {
    schema,
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    active,
    utilization: pool.totalCount > 0 ? (active / pool.totalCount * 100).toFixed(1) + '%' : '0%',
  };
}

function _scheduleReconnect(schema, pool) {
  let state = _reconnectState.get(schema) || { timer: null, attempts: 0 };
  if (state.timer) return;
  const delay = Math.min(1000 * Math.pow(2, state.attempts), 30000);
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
    } catch {
      state.attempts++;
      _reconnectState.set(schema, state);
      if (state.attempts < MAX_RECONNECT_ATTEMPTS) {
        _scheduleReconnect(schema, pool);
      } else {
        console.error(`[pg-pool:${schema}] ❌ 재연결 최대 시도 초과 (${MAX_RECONNECT_ATTEMPTS}회) — 이후 자동 재시도 중단`);
        state.attempts = 0;
        _reconnectState.set(schema, state);
      }
    }
  }, delay);
  _reconnectState.set(schema, state);
}

function parameterize(sql) {
  if (!sql || !sql.includes('?')) return sql;
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

function getPool(schema) {
  if (!VALID_SCHEMAS.has(schema)) throw new Error(`[pg-pool] 유효하지 않은 스키마: ${schema}`);
  if (!/^[a-z_]+$/.test(schema)) throw new Error(`[pg-pool] 스키마명 형식 오류: ${schema}`);
  if (_pools.has(schema)) return _pools.get(schema);
  const pool = new Pool({ ...PG_CONFIG, options: `-c search_path=${schema},public` });
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
      if (!_isConnError(e)) throw e;
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

async function _queryViaHub(schema, sql, params = []) {
  const { queryOpsDb } = require('./hub-client');
  const result = await queryOpsDb(parameterize(sql), schema, params);
  if (!result) return { rows: [], rowCount: 0 };
  return { rows: result.rows || [], rowCount: result.rowCount || 0 };
}

const _useHub = !env.IS_OPS && !env.IS_CLI && !!env.HUB_BASE_URL && !process.env.PG_DIRECT;

function _shouldUseHub(schema, sql) {
  if (!_useHub) return false;
  // Claude still emits mixed maintenance traffic from long-lived runtime paths.
  // Keep it on direct PG until that runtime is fully normalized.
  if (schema === 'claude') return false;
  return _isReadOnlySql(sql);
}

function _isReadOnlySql(sql) {
  const normalized = String(sql || '').trim().toLowerCase();
  if (!normalized) return false;
  return normalized.startsWith('select') ||
    normalized.startsWith('with') ||
    normalized.startsWith('explain');
}

async function query(schema, sql, params = []) {
  if (_shouldUseHub(schema, sql)) {
    const result = await _queryViaHub(schema, sql, params);
    return result.rows;
  }
  const pool = getPool(schema);
  const { rows } = await _safeQuery(pool, parameterize(sql), params);
  return rows;
}

async function run(schema, sql, params = []) {
  if (_shouldUseHub(schema, sql)) return _queryViaHub(schema, sql, params);
  const pool = getPool(schema);
  const result = await _safeQuery(pool, parameterize(sql), params);
  return { rowCount: result.rowCount, rows: result.rows };
}

async function get(schema, sql, params = []) {
  const rows = await query(schema, sql, params);
  return rows[0] || null;
}

function prepare(schema, sql) {
  const normalized = parameterize(sql);
  return {
    get: (...args) => get(schema, normalized, args.flat()),
    all: (...args) => query(schema, normalized, args.flat()),
    run: (...args) => run(schema, normalized, args.flat()),
  };
}

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

async function ping(schema = 'public') {
  try {
    const rows = await query(schema, 'SELECT 1 AS ok');
    return rows[0]?.ok === 1;
  } catch {
    return false;
  }
}

async function closeAll() {
  for (const [schema, pool] of _pools) {
    try { await pool.end(); } catch {}
    _pools.delete(schema);
  }
}

function getPoolStats(schema) {
  if (schema) {
    const pool = _pools.get(schema);
    if (!pool) return null;
    return _snapshotPoolStats(pool, schema);
  }
  const all = {};
  for (const [s, p] of _pools) {
    all[s] = _snapshotPoolStats(p, s);
  }
  return all;
}

function getAllPoolStats() {
  const result = [];
  for (const [s, p] of _pools) {
    result.push(_snapshotPoolStats(p, s));
  }
  return result;
}

function checkPoolHealth(threshold = 0.8) {
  const stats = getAllPoolStats();
  const issues = [];
  const maxPool = PG_CONFIG.max;
  for (const s of stats) {
    if (s.total >= maxPool * threshold) {
      issues.push({ schema: s.schema, status: 'warning', detail: `커넥션 ${s.total}/${maxPool} (${s.utilization} 사용)` });
    }
    if (s.waiting > 5) {
      issues.push({ schema: s.schema, status: 'warning', detail: `대기 쿼리 ${s.waiting}건 — 풀 부족 가능` });
    }
  }
  return { stats, issues };
}

async function getClient(schema) {
  const pool = getPool(schema);
  const client = await pool.connect();
  await client.query(`SET search_path = ${schema}, public`);
  return client;
}

const _monitorTimer = setInterval(() => {
  for (const [schema, pool] of _pools) {
    const total = pool.totalCount;
    if (total > 0) {
      const active = total - pool.idleCount;
      const highUtilization = active / total > 0.8;
      const shouldWarn = highUtilization && (total >= 3 || pool.waitingCount > 0 || active >= 2);
      if (shouldWarn) {
        console.warn(`[pg-pool:${schema}] ⚠️ 커넥션 풀 80%+ 사용: ${active}/${total} (대기: ${pool.waitingCount})`);
      }
    }
  }
}, 60000);
_monitorTimer.unref();

let _closing = false;
async function _gracefulClose(signal) {
  if (_closing) return;
  _closing = true;
  console.log(`[pg-pool] ${signal} 수신 — 커넥션 풀 종료`);
  await closeAll().catch(() => {});
}

process.on('SIGTERM', () => { _gracefulClose('SIGTERM').catch(() => {}); });
process.on('SIGINT',  () => { _gracefulClose('SIGINT').catch(() => {}); });

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
