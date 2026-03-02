/**
 * shared/db.js — DuckDB 래퍼 (Phase 3-A ESM)
 *
 * 경로: bots/investment/db/investment.duckdb
 * 테이블: analysis, signals, trades, positions
 */

import { join, dirname } from 'path';
import { fileURLToPath }  from 'url';
import duckdb             from 'duckdb';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH   = join(__dirname, '..', 'db', 'investment.duckdb');

let _db   = null;
let _conn = null;

function getConn() {
  if (_conn) return _conn;
  _db   = new duckdb.Database(DB_PATH);
  _conn = _db.connect();
  return _conn;
}

/** Promise 래핑 query */
export function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    const conn = getConn();
    conn.all(sql, ...params, (err, rows) => {
      if (err) reject(err);
      else     resolve(rows || []);
    });
  });
}

/** Promise 래핑 run (INSERT / UPDATE / DELETE) */
export function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    const conn = getConn();
    conn.run(sql, ...params, (err) => {
      if (err) reject(err);
      else     resolve();
    });
  });
}

// ─── 스키마 초기화 ──────────────────────────────────────────────────

export async function initSchema() {
  await run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       VARCHAR NOT NULL,
      applied_at TIMESTAMP DEFAULT now()
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS analysis (
      id         VARCHAR DEFAULT gen_random_uuid()::VARCHAR,
      symbol     VARCHAR NOT NULL,
      analyst    VARCHAR NOT NULL,
      signal     VARCHAR NOT NULL,
      confidence DOUBLE,
      reasoning  TEXT,
      metadata   JSON,
      exchange   VARCHAR DEFAULT 'binance',
      created_at TIMESTAMP DEFAULT now()
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS signals (
      id          VARCHAR DEFAULT gen_random_uuid()::VARCHAR,
      symbol      VARCHAR NOT NULL,
      action      VARCHAR NOT NULL,
      amount_usdt DOUBLE,
      confidence  DOUBLE,
      reasoning   TEXT,
      status      VARCHAR DEFAULT 'pending',
      exchange    VARCHAR DEFAULT 'binance',
      created_at  TIMESTAMP DEFAULT now()
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS trades (
      id          VARCHAR DEFAULT gen_random_uuid()::VARCHAR,
      signal_id   VARCHAR,
      symbol      VARCHAR NOT NULL,
      side        VARCHAR NOT NULL,
      amount      DOUBLE,
      price       DOUBLE,
      total_usdt  DOUBLE,
      paper       BOOLEAN DEFAULT true,
      exchange    VARCHAR DEFAULT 'binance',
      executed_at TIMESTAMP DEFAULT now()
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS positions (
      symbol         VARCHAR PRIMARY KEY,
      amount         DOUBLE DEFAULT 0,
      avg_price      DOUBLE DEFAULT 0,
      unrealized_pnl DOUBLE DEFAULT 0,
      exchange       VARCHAR DEFAULT 'binance',
      updated_at     TIMESTAMP DEFAULT now()
    )
  `);

  try {
    const rows = await query(`SELECT version FROM schema_migrations WHERE version = 1`);
    if (rows.length === 0) {
      await run(`INSERT INTO schema_migrations (version, name) VALUES (1, 'initial_schema')`);
    }
  } catch { /* 무시 */ }

  console.log(`✅ DB 스키마 초기화 완료: ${DB_PATH}`);
}

// ─── analysis ───────────────────────────────────────────────────────

export async function insertAnalysis({ symbol, analyst, signal, confidence, reasoning, metadata, exchange = 'binance' }) {
  await run(
    `INSERT INTO analysis (symbol, analyst, signal, confidence, reasoning, metadata, exchange)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [symbol, analyst, signal, confidence ?? null, reasoning ?? null,
     metadata ? JSON.stringify(metadata) : null, exchange],
  );
}

export async function getRecentAnalysis(symbol, minutesBack = 30) {
  return query(
    `SELECT * FROM analysis
     WHERE symbol = ? AND created_at > now() - INTERVAL '${minutesBack} minutes'
     ORDER BY created_at DESC`,
    [symbol],
  );
}

// ─── signals ────────────────────────────────────────────────────────

export async function insertSignal({ symbol, action, amountUsdt, confidence, reasoning, exchange = 'binance' }) {
  const rows = await query(
    `INSERT INTO signals (symbol, action, amount_usdt, confidence, reasoning, status, exchange)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)
     RETURNING id`,
    [symbol, action, amountUsdt ?? null, confidence ?? null, reasoning ?? null, exchange],
  );
  return rows[0]?.id;
}

export async function updateSignalStatus(id, status) {
  await run(`UPDATE signals SET status = ? WHERE id = ?`, [status, id]);
}

export async function getPendingSignals(exchange) {
  if (exchange) {
    return query(`SELECT * FROM signals WHERE status = 'pending' AND exchange = ? ORDER BY created_at ASC`, [exchange]);
  }
  return query(`SELECT * FROM signals WHERE status = 'pending' ORDER BY created_at ASC`);
}

// ─── trades ─────────────────────────────────────────────────────────

export async function insertTrade({ signalId, symbol, side, amount, price, totalUsdt, paper, exchange = 'binance' }) {
  await run(
    `INSERT INTO trades (signal_id, symbol, side, amount, price, total_usdt, paper, exchange)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [signalId ?? null, symbol, side, amount, price, totalUsdt ?? null, paper !== false, exchange],
  );
}

export async function getTradeHistory(symbol, limit = 50) {
  const params = symbol ? [symbol] : [];
  const where  = symbol ? 'WHERE symbol = ?' : '';
  return query(`SELECT * FROM trades ${where} ORDER BY executed_at DESC LIMIT ${limit}`, params);
}

// ─── positions ──────────────────────────────────────────────────────

export async function upsertPosition({ symbol, amount, avgPrice, unrealizedPnl, exchange = 'binance' }) {
  await run(
    `INSERT INTO positions (symbol, amount, avg_price, unrealized_pnl, exchange, updated_at)
     VALUES (?, ?, ?, ?, ?, now())
     ON CONFLICT (symbol) DO UPDATE SET
       amount         = excluded.amount,
       avg_price      = excluded.avg_price,
       unrealized_pnl = excluded.unrealized_pnl,
       exchange       = excluded.exchange,
       updated_at     = excluded.updated_at`,
    [symbol, amount, avgPrice, unrealizedPnl ?? 0, exchange],
  );
}

export async function getPosition(symbol) {
  const rows = await query(`SELECT * FROM positions WHERE symbol = ?`, [symbol]);
  return rows[0] || null;
}

export async function getAllPositions() {
  return query(`SELECT * FROM positions WHERE amount > 0 ORDER BY symbol`);
}

export async function deletePosition(symbol) {
  await run(`DELETE FROM positions WHERE symbol = ?`, [symbol]);
}

// ─── 집계 ───────────────────────────────────────────────────────────

export async function getTodayPnl() {
  const rows = await query(`
    SELECT
      SUM(CASE WHEN side='sell' THEN total_usdt ELSE -total_usdt END) AS pnl,
      COUNT(*) AS trade_count
    FROM trades
    WHERE executed_at::DATE = current_date
  `);
  return rows[0] || { pnl: 0, trade_count: 0 };
}

export function close() {
  if (_conn) { _conn.close(); _conn = null; }
  if (_db)   { _db.close();   _db   = null; }
}

export default {
  query, run, initSchema,
  insertAnalysis, getRecentAnalysis,
  insertSignal, updateSignalStatus, getPendingSignals,
  insertTrade, getTradeHistory,
  upsertPosition, getPosition, getAllPositions, deletePosition,
  getTodayPnl,
  close,
};
