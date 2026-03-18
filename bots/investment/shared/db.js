/**
 * shared/db.js — PostgreSQL investment 스키마 (Phase 4 마이그레이션)
 *
 * 위치: PostgreSQL jay DB, investment 스키마
 * 테이블: analysis, signals, trades, positions,
 *         strategy_pool, risk_log, asset_snapshot, schema_migrations
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pgPool = require('../../../packages/core/lib/pg-pool');

const SCHEMA = 'investment';
let _schemaInitPromise = null;

// ─── 기본 쿼리 래퍼 (외부 호환 API 유지) ──────────────────────────────

/** SELECT 쿼리 — rows 배열 반환 */
export function query(sql, params = []) {
  return pgPool.query(SCHEMA, sql, params);
}

/** INSERT / UPDATE / DELETE — { rowCount, rows } 반환 */
export function run(sql, params = []) {
  return pgPool.run(SCHEMA, sql, params);
}

/** 단일 행 SELECT — row 또는 null */
export function get(sql, params = []) {
  return pgPool.get(SCHEMA, sql, params);
}

// ─── 스키마 초기화 ──────────────────────────────────────────────────

export async function initSchema() {
  if (_schemaInitPromise) return _schemaInitPromise;

  _schemaInitPromise = (async () => {
  await run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TIMESTAMP DEFAULT now()
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS analysis (
      id         TEXT DEFAULT gen_random_uuid()::text,
      symbol     TEXT NOT NULL,
      analyst    TEXT NOT NULL,
      signal     TEXT NOT NULL,
      confidence DOUBLE PRECISION,
      reasoning  TEXT,
      metadata   JSONB,
      exchange   TEXT DEFAULT 'binance',
      created_at TIMESTAMP DEFAULT now()
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS signals (
      id          TEXT DEFAULT gen_random_uuid()::text,
      symbol      TEXT NOT NULL,
      action      TEXT NOT NULL,
      amount_usdt DOUBLE PRECISION,
      confidence  DOUBLE PRECISION,
      reasoning   TEXT,
      status      TEXT DEFAULT 'pending',
      exchange    TEXT DEFAULT 'binance',
      created_at  TIMESTAMP DEFAULT now()
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS trades (
      id          TEXT DEFAULT gen_random_uuid()::text,
      signal_id   TEXT,
      symbol      TEXT NOT NULL,
      side        TEXT NOT NULL,
      amount      DOUBLE PRECISION,
      price       DOUBLE PRECISION,
      total_usdt  DOUBLE PRECISION,
      paper       BOOLEAN DEFAULT true,
      exchange    TEXT DEFAULT 'binance',
      executed_at TIMESTAMP DEFAULT now()
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS positions (
      symbol         TEXT PRIMARY KEY,
      amount         DOUBLE PRECISION DEFAULT 0,
      avg_price      DOUBLE PRECISION DEFAULT 0,
      unrealized_pnl DOUBLE PRECISION DEFAULT 0,
      paper          BOOLEAN DEFAULT false,
      exchange       TEXT DEFAULT 'binance',
      updated_at     TIMESTAMP DEFAULT now()
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS strategy_pool (
      id                   TEXT DEFAULT gen_random_uuid()::text,
      strategy_name        TEXT UNIQUE NOT NULL,
      market               TEXT NOT NULL,
      source               TEXT,
      source_url           TEXT,
      entry_condition      TEXT,
      exit_condition       TEXT,
      risk_management      TEXT,
      applicable_timeframe TEXT,
      quality_score        DOUBLE PRECISION DEFAULT 0.0,
      summary              TEXT,
      applicable_now       BOOLEAN DEFAULT true,
      collected_at         TIMESTAMP DEFAULT now(),
      applied_count        INTEGER DEFAULT 0,
      win_rate             DOUBLE PRECISION
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS risk_log (
      id           TEXT DEFAULT gen_random_uuid()::text,
      trace_id     TEXT UNIQUE NOT NULL,
      symbol       TEXT,
      exchange     TEXT,
      decision     TEXT,
      risk_score   INTEGER,
      reason       TEXT,
      evaluated_at TIMESTAMP DEFAULT now()
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS asset_snapshot (
      id         TEXT DEFAULT gen_random_uuid()::text,
      equity     DOUBLE PRECISION NOT NULL,
      value_usd  DOUBLE PRECISION,
      snapped_at TIMESTAMP DEFAULT now()
    )
  `);

  // signals 컬럼 추가 (없으면 추가)
  for (const [col, type] of [
    ['trace_id',        'TEXT'],
    ['block_reason',    'TEXT'],
    ['block_code',      'TEXT'],
    ['block_meta',      'JSONB'],
    ['analyst_signals', 'TEXT'],  // 분석 봇 4인 신호 패턴 (예: "A:B|O:B|H:N|S:B")
  ]) {
    try { await run(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS ${col} ${type}`); } catch { /* 무시 */ }
  }

  // trades TP/SL 컬럼
  for (const [col, type] of [
    ['tp_price', 'DOUBLE PRECISION'], ['sl_price', 'DOUBLE PRECISION'],
    ['tp_order_id', 'TEXT'], ['sl_order_id', 'TEXT'],
    ['tp_sl_set', 'BOOLEAN DEFAULT false'],
  ]) {
    try { await run(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS ${col} ${type}`); } catch { /* 무시 */ }
  }

  try { await run(`ALTER TABLE positions ADD COLUMN IF NOT EXISTS paper BOOLEAN DEFAULT false`); } catch { /* 무시 */ }

  // ── screening_history (아르고스 동적 종목 스크리닝 이력) ──
  await run(`
    CREATE TABLE IF NOT EXISTS screening_history (
      id              TEXT DEFAULT gen_random_uuid()::text PRIMARY KEY,
      date            DATE NOT NULL,
      market          TEXT NOT NULL,
      core_symbols    JSONB,
      dynamic_symbols JSONB,
      screening_data  JSONB,
      created_at      TIMESTAMP DEFAULT now()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_screening_date ON screening_history(date, market)`);

  // ── dual_model_results (멀티 모델 경쟁 결과 상세 기록) ──
  await run(`
    CREATE TABLE IF NOT EXISTS dual_model_results (
      id                  TEXT DEFAULT gen_random_uuid()::text PRIMARY KEY,
      agent               TEXT NOT NULL,
      symbol              TEXT,
      cycle_id            TEXT,
      oss_response        TEXT,
      oss_signal          TEXT,
      oss_confidence      DOUBLE PRECISION,
      oss_reasoning       TEXT,
      oss_score           DOUBLE PRECISION,
      oss_parseable       BOOLEAN DEFAULT false,
      oss_latency_ms      INTEGER,
      oss_input_tokens    INTEGER DEFAULT 0,
      oss_output_tokens   INTEGER DEFAULT 0,
      scout_response      TEXT,
      scout_signal        TEXT,
      scout_confidence    DOUBLE PRECISION,
      scout_reasoning     TEXT,
      scout_score         DOUBLE PRECISION,
      scout_parseable     BOOLEAN DEFAULT false,
      scout_latency_ms    INTEGER,
      scout_input_tokens  INTEGER DEFAULT 0,
      scout_output_tokens INTEGER DEFAULT 0,
      winner              TEXT NOT NULL,
      win_reason          TEXT,
      score_diff          DOUBLE PRECISION,
      signals_agree       BOOLEAN DEFAULT false,
      created_at          TIMESTAMP DEFAULT now()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_dual_agent    ON dual_model_results(agent, created_at)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_dual_winner   ON dual_model_results(winner, created_at)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_dual_symbol   ON dual_model_results(symbol, created_at)`);

  // 스키마 버전 기록
  try {
    for (const [v, name] of [
      [1, 'initial_schema'],
      [2, 'strategy_pool_risk_log_asset_snapshot'],
      [3, 'trades_tp_sl_columns'],
      [4, 'screening_history_dual_model_results'],
    ]) {
      await run(
        `INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [v, name],
      );
    }
  } catch { /* 무시 */ }

  console.log(`✅ DB 스키마 초기화 완료 (investment 스키마)`);
  })();

  try {
    await _schemaInitPromise;
    return _schemaInitPromise;
  } catch (e) {
    _schemaInitPromise = null;
    throw e;
  }
}

// ─── analysis ───────────────────────────────────────────────────────

export async function insertAnalysis({ symbol, analyst, signal, confidence, reasoning, metadata, exchange = 'binance' }) {
  await run(
    `INSERT INTO analysis (symbol, analyst, signal, confidence, reasoning, metadata, exchange)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [symbol, analyst, signal, confidence ?? null, reasoning ?? null,
     metadata ? JSON.stringify(metadata) : null, exchange],
  );
}

export async function getRecentAnalysis(symbol, minutesBack = 30, exchange = null) {
  if (exchange) {
    return query(
      `SELECT * FROM analysis
       WHERE symbol = $1 AND exchange = $2
         AND created_at > now() - INTERVAL '1 minute' * $3
       ORDER BY created_at DESC`,
      [symbol, exchange, minutesBack],
    );
  }
  return query(
    `SELECT * FROM analysis
     WHERE symbol = $1 AND created_at > now() - INTERVAL '1 minute' * $2
     ORDER BY created_at DESC`,
    [symbol, minutesBack],
  );
}

// ─── signals ────────────────────────────────────────────────────────

export async function insertSignal({ symbol, action, amountUsdt, confidence, reasoning, exchange = 'binance', analystSignals = null }) {
  const rows = await query(
    `INSERT INTO signals (symbol, action, amount_usdt, confidence, reasoning, status, exchange, analyst_signals)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
     RETURNING id`,
    [symbol, action, amountUsdt ?? null, confidence ?? null, reasoning ?? null, exchange, analystSignals ?? null],
  );
  return rows[0]?.id;
}

export async function updateSignalStatus(id, status) {
  await run(`UPDATE signals SET status = $1 WHERE id = $2`, [status, id]);
}

export async function updateSignalAmount(id, amountUsdt) {
  await run(`UPDATE signals SET amount_usdt = $1 WHERE id = $2`, [amountUsdt, id]);
}

export async function updateSignalBlock(id, {
  status = null,
  reason = null,
  code = null,
  meta = null,
} = {}) {
  if (!id) return;

  const sets = [];
  const params = [];

  if (status) {
    params.push(status);
    sets.push(`status = $${params.length}`);
  }
  if (reason !== null) {
    params.push(reason);
    sets.push(`block_reason = $${params.length}`);
  }
  if (code !== null) {
    params.push(code);
    sets.push(`block_code = $${params.length}`);
  }
  if (meta !== null) {
    params.push(meta ? JSON.stringify(meta) : null);
    sets.push(`block_meta = $${params.length}`);
  }
  if (sets.length === 0) return;

  params.push(id);
  await run(`UPDATE signals SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
}

export async function getSignalById(id) {
  return get(`SELECT * FROM signals WHERE id = $1`, [id]);
}

export async function getPendingSignals(exchange) {
  if (exchange) {
    return query(`SELECT * FROM signals WHERE status = 'pending' AND exchange = $1 ORDER BY created_at ASC`, [exchange]);
  }
  return query(`SELECT * FROM signals WHERE status = 'pending' ORDER BY created_at ASC`);
}

export async function getApprovedSignals(exchange) {
  if (exchange) {
    return query(`SELECT * FROM signals WHERE status = 'approved' AND exchange = $1 ORDER BY created_at ASC`, [exchange]);
  }
  return query(`SELECT * FROM signals WHERE status = 'approved' ORDER BY created_at ASC`);
}

// ─── trades ─────────────────────────────────────────────────────────

export async function insertTrade({ signalId, symbol, side, amount, price, totalUsdt, paper, exchange = 'binance', tpPrice = null, slPrice = null, tpOrderId = null, slOrderId = null, tpSlSet = false }) {
  await run(
    `INSERT INTO trades (signal_id, symbol, side, amount, price, total_usdt, paper, exchange, tp_price, sl_price, tp_order_id, sl_order_id, tp_sl_set)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [signalId ?? null, symbol, side, amount, price, totalUsdt ?? null, paper !== false, exchange,
     tpPrice, slPrice, tpOrderId, slOrderId, tpSlSet ?? false],
  );
}

export async function getTradeHistory(symbol, limit = 50) {
  if (symbol) {
    return query(`SELECT * FROM trades WHERE symbol = $1 ORDER BY executed_at DESC LIMIT $2`, [symbol, limit]);
  }
  return query(`SELECT * FROM trades ORDER BY executed_at DESC LIMIT $1`, [limit]);
}

export async function getLatestTradeBySignalId(signalId) {
  return get(`SELECT * FROM trades WHERE signal_id = $1 ORDER BY executed_at DESC LIMIT 1`, [signalId]);
}

// ─── positions ──────────────────────────────────────────────────────

export async function upsertPosition({ symbol, amount, avgPrice, unrealizedPnl, exchange = 'binance', paper = false }) {
  await run(
    `INSERT INTO positions (symbol, amount, avg_price, unrealized_pnl, paper, exchange, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (symbol) DO UPDATE SET
       amount         = EXCLUDED.amount,
       avg_price      = EXCLUDED.avg_price,
       unrealized_pnl = EXCLUDED.unrealized_pnl,
       paper          = EXCLUDED.paper,
       exchange       = EXCLUDED.exchange,
       updated_at     = EXCLUDED.updated_at`,
    [symbol, amount, avgPrice, unrealizedPnl ?? 0, paper === true, exchange],
  );
}

export async function getPosition(symbol) {
  return get(`SELECT * FROM positions WHERE symbol = $1`, [symbol]);
}

export async function getLivePosition(symbol) {
  return get(`SELECT * FROM positions WHERE symbol = $1 AND paper = false`, [symbol]);
}

export async function getPaperPosition(symbol) {
  return get(`SELECT * FROM positions WHERE symbol = $1 AND paper = true`, [symbol]);
}

export async function getAllPositions(exchange = null, paper = null) {
  if (exchange && paper !== null) {
    return query(
      `SELECT * FROM positions WHERE amount > 0 AND exchange = $1 AND paper = $2 ORDER BY symbol`,
      [exchange, paper === true],
    );
  }
  if (exchange) {
    return query(`SELECT * FROM positions WHERE amount > 0 AND exchange = $1 ORDER BY symbol`, [exchange]);
  }
  if (paper !== null) {
    return query(`SELECT * FROM positions WHERE amount > 0 AND paper = $1 ORDER BY symbol`, [paper === true]);
  }
  return query(`SELECT * FROM positions WHERE amount > 0 ORDER BY symbol`);
}

export async function getPaperPositions(exchange = null) {
  if (exchange) {
    return query(`SELECT * FROM positions WHERE amount > 0 AND paper = true AND exchange = $1 ORDER BY updated_at ASC`, [exchange]);
  }
  return query(`SELECT * FROM positions WHERE amount > 0 AND paper = true ORDER BY updated_at ASC`);
}

export async function deletePosition(symbol) {
  await run(`DELETE FROM positions WHERE symbol = $1`, [symbol]);
}

// ─── 집계 ───────────────────────────────────────────────────────────

export async function getTodayPnl() {
  const rows = await query(`
    SELECT
      SUM(CASE WHEN side='sell' THEN total_usdt ELSE -total_usdt END) AS pnl,
      COUNT(*) AS trade_count
    FROM trades
    WHERE executed_at::date = current_date
  `);
  return rows[0] || { pnl: 0, trade_count: 0 };
}

export async function insertScreeningHistory({ market, core = [], dynamic = [], screeningData = null }) {
  await run(`
    INSERT INTO screening_history (date, market, core_symbols, dynamic_symbols, screening_data)
    VALUES (CURRENT_DATE, $1, $2, $3, $4)
  `, [
    market,
    JSON.stringify(core),
    JSON.stringify(dynamic),
    screeningData ? JSON.stringify(screeningData) : null,
  ]);
}

export async function getRecentScreeningSymbols(market, limit = 3) {
  const rows = await query(`
    SELECT market, dynamic_symbols, core_symbols, screening_data, created_at
    FROM screening_history
    WHERE market = $1 OR market = 'all'
    ORDER BY created_at DESC
    LIMIT $2
  `, [market, limit]);

  const symbols = [];
  for (const row of rows) {
    const screeningData = row.screening_data && typeof row.screening_data === 'object'
      ? row.screening_data
      : row.screening_data ? JSON.parse(row.screening_data) : null;

    const dynamic = row.market === 'all'
      ? (screeningData?.[market]?.dynamic || [])
      : Array.isArray(row.dynamic_symbols)
        ? row.dynamic_symbols
        : JSON.parse(row.dynamic_symbols || '[]');
    const core = row.market === 'all'
      ? (screeningData?.[market]?.core || [])
      : Array.isArray(row.core_symbols)
        ? row.core_symbols
        : row.core_symbols && typeof row.core_symbols === 'object'
          ? Object.values(row.core_symbols).flat()
          : JSON.parse(row.core_symbols || '[]');
    for (const sym of [...dynamic, ...core]) {
      if (sym && !symbols.includes(sym)) symbols.push(sym);
    }
  }

  return symbols;
}

// ─── strategy_pool ───────────────────────────────────────────────────

export async function upsertStrategy(s) {
  await run(`
    INSERT INTO strategy_pool
      (strategy_name, market, source, source_url,
       entry_condition, exit_condition, risk_management,
       applicable_timeframe, quality_score, summary, applicable_now, collected_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
    ON CONFLICT (strategy_name) DO UPDATE SET
      quality_score        = EXCLUDED.quality_score,
      summary              = EXCLUDED.summary,
      applicable_now       = EXCLUDED.applicable_now,
      collected_at         = EXCLUDED.collected_at
  `, [
    s.strategy_name, s.market, s.source ?? null, s.source_url ?? null,
    s.entry_condition ?? null, s.exit_condition ?? null, s.risk_management ?? null,
    s.applicable_timeframe ?? null, s.quality_score ?? 0, s.summary ?? null,
    s.applicable_now !== false,
  ]);
}

export async function getActiveStrategies(market = 'all', limit = 5) {
  const marketFilter = market === 'all' ? '' : `AND (market = '${market}' OR market = 'all')`;
  return query(`
    SELECT * FROM strategy_pool
    WHERE applicable_now = true
      AND quality_score >= 0.6
      AND collected_at > now() - INTERVAL '7 days'
      ${marketFilter}
    ORDER BY quality_score DESC
    LIMIT ${limit}
  `);
}

export async function recordStrategyResult(strategyName, won) {
  await run(`
    UPDATE strategy_pool
    SET applied_count = applied_count + 1,
        win_rate = (COALESCE(win_rate, 0.5) * applied_count + $1) / (applied_count + 1)
    WHERE strategy_name = $2
  `, [won ? 1 : 0, strategyName]);
}

// ─── risk_log ────────────────────────────────────────────────────────

export async function insertRiskLog({ traceId, symbol, exchange, decision, riskScore, reason }) {
  await run(
    `INSERT INTO risk_log (trace_id, symbol, exchange, decision, risk_score, reason)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [traceId, symbol ?? null, exchange ?? null, decision, riskScore ?? null, reason ?? null],
  );
}

// ─── asset_snapshot ──────────────────────────────────────────────────

export async function insertAssetSnapshot(equity, valueUsd = null) {
  await run(`INSERT INTO asset_snapshot (equity, value_usd) VALUES ($1,$2)`, [equity, valueUsd]);
}

export async function getLatestEquity() {
  const row = await get(`SELECT equity FROM asset_snapshot ORDER BY snapped_at DESC LIMIT 1`);
  return row?.equity ?? null;
}

export async function getEquityHistory(limit = 200) {
  return query(`SELECT equity, snapped_at FROM asset_snapshot ORDER BY snapped_at ASC LIMIT $1`, [limit]);
}

export function close() {
  // pgPool 관리 — 개별 close 불필요 (pgPool.closeAll()로 전체 종료)
}

export default {
  query, run, get, initSchema,
  insertAnalysis, getRecentAnalysis,
  insertSignal, updateSignalStatus, updateSignalAmount, updateSignalBlock, getSignalById, getPendingSignals, getApprovedSignals,
  insertTrade, getTradeHistory, getLatestTradeBySignalId,
  upsertPosition, getPosition, getLivePosition, getPaperPosition, getAllPositions, getPaperPositions, deletePosition,
  getTodayPnl,
  insertScreeningHistory,
  getRecentScreeningSymbols,
  upsertStrategy, getActiveStrategies, recordStrategyResult,
  insertRiskLog,
  insertAssetSnapshot, getLatestEquity, getEquityHistory,
  close,
};
