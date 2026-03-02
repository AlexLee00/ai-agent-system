'use strict';

/**
 * lib/db.js — DuckDB 래퍼 (투자 이력 전용)
 *
 * 위치: bots/invest/db/invest.duckdb
 * 테이블: analysis, signals, trades, positions
 *
 * DuckDB Node.js API는 콜백 기반 → Promise 래핑 사용
 */

const path = require('path');
const duckdb = require('duckdb');

const DB_PATH = path.join(__dirname, '..', 'db', 'invest.duckdb');

let _db = null;
let _conn = null;

function getConn() {
  if (_conn) return _conn;
  _db = new duckdb.Database(DB_PATH);
  _conn = _db.connect();
  return _conn;
}

/** Promise 래핑 query */
function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    const conn = getConn();
    conn.all(sql, ...params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

/** Promise 래핑 run (INSERT/UPDATE/DELETE) */
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    const conn = getConn();
    conn.run(sql, ...params, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ─── 스키마 버전 관리 ───────────────────────────────────────────────

async function initMigrationsTable() {
  await run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        VARCHAR NOT NULL,
      applied_at  TIMESTAMP DEFAULT now()
    )
  `);
}

async function getAppliedMigrations() {
  try {
    const rows = await query(`SELECT version FROM schema_migrations ORDER BY version ASC`);
    return new Set(rows.map(r => r.version));
  } catch {
    return new Set();
  }
}

async function recordMigration(version, name) {
  await run(
    `INSERT INTO schema_migrations (version, name) VALUES (?, ?)`,
    [version, name]
  );
}

async function getSchemaVersion() {
  try {
    const rows = await query(`SELECT MAX(version) as v FROM schema_migrations`);
    return rows[0]?.v ?? 0;
  } catch {
    return 0;
  }
}

// ─── 스키마 초기화 ──────────────────────────────────────────────────

async function initSchema() {
  // 마이그레이션 테이블 먼저 생성
  await initMigrationsTable();

  // 분석가 결과
  await run(`
    CREATE TABLE IF NOT EXISTS analysis (
      id        VARCHAR DEFAULT gen_random_uuid()::VARCHAR,
      symbol    VARCHAR NOT NULL,
      analyst   VARCHAR NOT NULL,
      signal    VARCHAR NOT NULL,
      confidence DOUBLE,
      reasoning TEXT,
      metadata  JSON,
      created_at TIMESTAMP DEFAULT now()
    )
  `);

  // 매매 신호 (LLM 판단 결과)
  await run(`
    CREATE TABLE IF NOT EXISTS signals (
      id          VARCHAR DEFAULT gen_random_uuid()::VARCHAR,
      symbol      VARCHAR NOT NULL,
      action      VARCHAR NOT NULL,
      amount_usdt DOUBLE,
      confidence  DOUBLE,
      reasoning   TEXT,
      status      VARCHAR DEFAULT 'pending',
      created_at  TIMESTAMP DEFAULT now()
    )
  `);

  // 실행된 거래 (드라이런 포함)
  await run(`
    CREATE TABLE IF NOT EXISTS trades (
      id          VARCHAR DEFAULT gen_random_uuid()::VARCHAR,
      signal_id   VARCHAR,
      symbol      VARCHAR NOT NULL,
      side        VARCHAR NOT NULL,
      amount      DOUBLE,
      price       DOUBLE,
      total_usdt  DOUBLE,
      dry_run     BOOLEAN DEFAULT true,
      executed_at TIMESTAMP DEFAULT now()
    )
  `);

  // 현재 포지션
  await run(`
    CREATE TABLE IF NOT EXISTS positions (
      symbol          VARCHAR PRIMARY KEY,
      amount          DOUBLE DEFAULT 0,
      avg_price       DOUBLE DEFAULT 0,
      unrealized_pnl  DOUBLE DEFAULT 0,
      updated_at      TIMESTAMP DEFAULT now()
    )
  `);

  // 초기 마이그레이션 기록 (이미 적용된 경우 스킵)
  const applied = await getAppliedMigrations();
  if (!applied.has(1)) {
    await recordMigration(1, 'initial_schema');
  }

  // Migration v2: exchange 컬럼 추가 (binance/kis 구분)
  if (!applied.has(2)) {
    const alterations = [
      `ALTER TABLE analysis   ADD COLUMN IF NOT EXISTS exchange VARCHAR DEFAULT 'binance'`,
      `ALTER TABLE signals    ADD COLUMN IF NOT EXISTS exchange VARCHAR DEFAULT 'binance'`,
      `ALTER TABLE trades     ADD COLUMN IF NOT EXISTS exchange VARCHAR DEFAULT 'binance'`,
      `ALTER TABLE positions  ADD COLUMN IF NOT EXISTS exchange VARCHAR DEFAULT 'binance'`,
    ];
    for (const sql of alterations) {
      try { await run(sql); } catch (e) {
        // DuckDB가 IF NOT EXISTS 미지원 버전이면 무시
        if (!e.message.includes('already exists')) throw e;
      }
    }
    await recordMigration(2, 'add_exchange_column');
    console.log('  ✅ Migration v2: exchange 컬럼 추가 완료');
  }

  const ver = await getSchemaVersion();
  console.log(`✅ DB 스키마 초기화 완료 (v${ver}):`, DB_PATH);
}

// ─── analysis ──────────────────────────────────────────────────────

async function insertAnalysis({ symbol, analyst, signal, confidence, reasoning, metadata, exchange = 'binance' }) {
  await run(
    `INSERT INTO analysis (symbol, analyst, signal, confidence, reasoning, metadata, exchange)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [symbol, analyst, signal, confidence || null, reasoning || null, metadata ? JSON.stringify(metadata) : null, exchange]
  );
}

async function getRecentAnalysis(symbol, minutesBack = 30) {
  return query(
    `SELECT * FROM analysis
     WHERE symbol = ? AND created_at > now() - INTERVAL '${minutesBack} minutes'
     ORDER BY created_at DESC`,
    [symbol]
  );
}

// ─── signals ───────────────────────────────────────────────────────

async function insertSignal({ symbol, action, amountUsdt, confidence, reasoning, exchange = 'binance' }) {
  const rows = await query(
    `INSERT INTO signals (symbol, action, amount_usdt, confidence, reasoning, status, exchange)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)
     RETURNING id`,
    [symbol, action, amountUsdt || null, confidence || null, reasoning || null, exchange]
  );
  return rows[0]?.id;
}

async function updateSignalStatus(id, status) {
  await run(`UPDATE signals SET status = ? WHERE id = ?`, [status, id]);
}

/**
 * 대기 신호 조회
 * @param {string} [exchange]  거래소 필터 ('binance' | 'kis' | undefined=전체)
 */
async function getPendingSignals(exchange) {
  if (exchange) {
    return query(`SELECT * FROM signals WHERE status = 'pending' AND exchange = ? ORDER BY created_at ASC`, [exchange]);
  }
  return query(`SELECT * FROM signals WHERE status = 'pending' ORDER BY created_at ASC`);
}

// ─── trades ────────────────────────────────────────────────────────

async function insertTrade({ signalId, symbol, side, amount, price, totalUsdt, dryRun, exchange = 'binance' }) {
  await run(
    `INSERT INTO trades (signal_id, symbol, side, amount, price, total_usdt, dry_run, exchange)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [signalId || null, symbol, side, amount, price, totalUsdt || null, dryRun !== false, exchange]
  );
}

async function getTradeHistory(symbol, limit = 50) {
  const params = symbol ? [symbol] : [];
  const where = symbol ? 'WHERE symbol = ?' : '';
  return query(
    `SELECT * FROM trades ${where} ORDER BY executed_at DESC LIMIT ${limit}`,
    params
  );
}

// ─── positions ─────────────────────────────────────────────────────

async function upsertPosition({ symbol, amount, avgPrice, unrealizedPnl, exchange = 'binance' }) {
  await run(
    `INSERT INTO positions (symbol, amount, avg_price, unrealized_pnl, updated_at, exchange)
     VALUES (?, ?, ?, ?, now(), ?)
     ON CONFLICT (symbol) DO UPDATE SET
       amount         = excluded.amount,
       avg_price      = excluded.avg_price,
       unrealized_pnl = excluded.unrealized_pnl,
       updated_at     = excluded.updated_at,
       exchange       = excluded.exchange`,
    [symbol, amount, avgPrice, unrealizedPnl || 0, exchange]
  );
}

async function getPosition(symbol) {
  const rows = await query(`SELECT * FROM positions WHERE symbol = ?`, [symbol]);
  return rows[0] || null;
}

async function getAllPositions() {
  return query(`SELECT * FROM positions WHERE amount > 0 ORDER BY symbol`);
}

async function deletePosition(symbol) {
  await run(`DELETE FROM positions WHERE symbol = ?`, [symbol]);
}

// ─── 집계 ──────────────────────────────────────────────────────────

async function getTodayPnl() {
  const rows = await query(`
    SELECT
      SUM(CASE WHEN side='sell' THEN total_usdt ELSE -total_usdt END) as pnl,
      COUNT(*) as trade_count
    FROM trades
    WHERE executed_at::DATE = current_date
  `);
  return rows[0] || { pnl: 0, trade_count: 0 };
}

function close() {
  if (_conn) { _conn.close(); _conn = null; }
  if (_db)   { _db.close();   _db = null; }
}

module.exports = {
  query, run, initSchema,
  // 마이그레이션
  initMigrationsTable, getAppliedMigrations, recordMigration, getSchemaVersion,
  // analysis
  insertAnalysis, getRecentAnalysis,
  // signals
  insertSignal, updateSignalStatus, getPendingSignals,
  // trades
  insertTrade, getTradeHistory,
  // positions
  upsertPosition, getPosition, getAllPositions, deletePosition,
  // 집계
  getTodayPnl,
  close,
};
