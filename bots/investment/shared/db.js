/**
 * shared/db.js — PostgreSQL investment 스키마 (Phase 4 마이그레이션)
 *
 * 위치: PostgreSQL jay DB, investment 스키마
 * 테이블: analysis, signals, trades, positions,
 *         strategy_pool, risk_log, asset_snapshot,
 *         runtime_config_suggestion_log, schema_migrations
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pgPool = require('../../../packages/core/lib/pg-pool');
import { getInvestmentTradeMode } from './secrets.js';
import { getSignalDedupeWindowMinutes } from './runtime-config.js';

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
      symbol         TEXT NOT NULL,
      amount         DOUBLE PRECISION DEFAULT 0,
      avg_price      DOUBLE PRECISION DEFAULT 0,
      unrealized_pnl DOUBLE PRECISION DEFAULT 0,
      paper          BOOLEAN DEFAULT false,
      exchange       TEXT DEFAULT 'binance',
      trade_mode     TEXT DEFAULT 'normal',
      UNIQUE(symbol, exchange, paper, trade_mode),
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

  await run(`
    CREATE TABLE IF NOT EXISTS runtime_config_suggestion_log (
      id                TEXT DEFAULT gen_random_uuid()::text PRIMARY KEY,
      period_days       INTEGER NOT NULL,
      actionable_count  INTEGER DEFAULT 0,
      market_summary    JSONB NOT NULL,
      suggestions       JSONB NOT NULL,
      review_status     TEXT DEFAULT 'pending',
      review_note       TEXT,
      reviewed_at       TIMESTAMP,
      applied_at        TIMESTAMP,
      captured_at       TIMESTAMP DEFAULT now()
    )
  `);
  await run(`
    CREATE INDEX IF NOT EXISTS idx_runtime_config_suggestion_log_captured_at
    ON runtime_config_suggestion_log(captured_at DESC)
  `);
  for (const [col, type] of [
    ['reviewed_at', 'TIMESTAMP'],
    ['applied_at', 'TIMESTAMP'],
    ['policy_snapshot', 'JSONB'],
  ]) {
    try { await run(`ALTER TABLE runtime_config_suggestion_log ADD COLUMN IF NOT EXISTS ${col} ${type}`); } catch { /* 무시 */ }
  }

  // signals 컬럼 추가 (없으면 추가)
  for (const [col, type] of [
    ['trace_id',        'TEXT'],
    ['block_reason',    'TEXT'],
    ['block_code',      'TEXT'],
    ['block_meta',      'JSONB'],
    ['analyst_signals', 'TEXT'],  // 분석 봇 4인 신호 패턴 (예: "A:B|O:B|H:N|S:B")
    ['trade_mode',      `TEXT DEFAULT 'normal'`],
  ]) {
    try { await run(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS ${col} ${type}`); } catch { /* 무시 */ }
  }

  // trades TP/SL 컬럼
  for (const [col, type] of [
    ['tp_price', 'DOUBLE PRECISION'], ['sl_price', 'DOUBLE PRECISION'],
    ['tp_order_id', 'TEXT'], ['sl_order_id', 'TEXT'],
    ['tp_sl_set', 'BOOLEAN DEFAULT false'],
    ['trade_mode', `TEXT DEFAULT 'normal'`],
  ]) {
    try { await run(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS ${col} ${type}`); } catch { /* 무시 */ }
  }

  try { await run(`ALTER TABLE positions ADD COLUMN IF NOT EXISTS paper BOOLEAN DEFAULT false`); } catch { /* 무시 */ }
  try { await run(`ALTER TABLE positions ADD COLUMN IF NOT EXISTS trade_mode TEXT DEFAULT 'normal'`); } catch { /* 무시 */ }
  try { await run(`UPDATE positions SET trade_mode = 'normal' WHERE trade_mode IS NULL`); } catch { /* 무시 */ }
  try { await run(`ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_pkey`); } catch { /* 무시 */ }
  try { await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_scope_unique ON positions(symbol, exchange, paper, trade_mode)`); } catch { /* 무시 */ }

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
      [5, 'runtime_config_suggestion_log'],
      [6, 'positions_trade_mode_scope'],
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

export async function insertSignal({ symbol, action, amountUsdt, confidence, reasoning, exchange = 'binance', analystSignals = null, tradeMode = null }) {
  const effectiveTradeMode = tradeMode || getInvestmentTradeMode();
  const rows = await query(
    `INSERT INTO signals (symbol, action, amount_usdt, confidence, reasoning, status, exchange, analyst_signals, trade_mode)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8)
     RETURNING id`,
    [symbol, action, amountUsdt ?? null, confidence ?? null, reasoning ?? null, exchange, analystSignals ?? null, effectiveTradeMode],
  );
  return rows[0]?.id;
}

export async function getRecentSignalDuplicate({
  symbol,
  action,
  exchange = 'binance',
  tradeMode = null,
  minutesBack = 180,
} = {}) {
  const effectiveTradeMode = tradeMode || getInvestmentTradeMode();
  return get(
    `SELECT *
       FROM signals
      WHERE symbol = $1
        AND action = $2
        AND exchange = $3
        AND COALESCE(trade_mode, 'normal') = $4
        AND created_at > now() - INTERVAL '1 minute' * $5
      ORDER BY created_at DESC
      LIMIT 1`,
    [symbol, action, exchange, effectiveTradeMode, minutesBack],
  );
}

export async function getRecentBlockedSignalByCode({
  symbol,
  action = null,
  exchange = 'binance',
  tradeMode = null,
  blockCode,
  minutesBack = 1440,
} = {}) {
  if (!symbol || !blockCode) return null;
  const effectiveTradeMode = tradeMode || getInvestmentTradeMode();
  const conditions = [
    `symbol = $1`,
    `exchange = $2`,
    `COALESCE(trade_mode, 'normal') = $3`,
    `COALESCE(block_code, '') = $4`,
    `created_at > now() - INTERVAL '1 minute' * $5`,
  ];
  const params = [symbol, exchange, effectiveTradeMode, blockCode, minutesBack];

  if (action) {
    params.push(action);
    conditions.push(`action = $${params.length}`);
  }

  return get(
    `SELECT *
       FROM signals
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT 1`,
    params,
  );
}

export async function insertSignalIfFresh({
  symbol,
  action,
  amountUsdt,
  confidence,
  reasoning,
  exchange = 'binance',
  analystSignals = null,
  tradeMode = null,
  dedupeWindowMinutes = null,
} = {}) {
  const effectiveTradeMode = tradeMode || getInvestmentTradeMode();
  const effectiveWindow = Number.isFinite(Number(dedupeWindowMinutes)) && Number(dedupeWindowMinutes) > 0
    ? Math.round(Number(dedupeWindowMinutes))
    : getSignalDedupeWindowMinutes();
  const duplicate = await getRecentSignalDuplicate({
    symbol,
    action,
    exchange,
    tradeMode: effectiveTradeMode,
    minutesBack: effectiveWindow,
  });

  if (duplicate) {
    return {
      id: duplicate.id,
      duplicate: true,
      existingSignal: duplicate,
      dedupeWindowMinutes: effectiveWindow,
    };
  }

  const id = await insertSignal({
    symbol,
    action,
    amountUsdt,
    confidence,
    reasoning,
    exchange,
    analystSignals,
    tradeMode: effectiveTradeMode,
  });

  return {
    id,
    duplicate: false,
    existingSignal: null,
    dedupeWindowMinutes: effectiveWindow,
  };
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

export async function getPendingSignals(exchange, tradeMode = null) {
  const conditions = [`status = 'pending'`];
  const params = [];

  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }
  if (tradeMode) {
    params.push(tradeMode);
    conditions.push(`COALESCE(trade_mode, 'normal') = $${params.length}`);
  }

  return query(
    `SELECT * FROM signals WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC`,
    params,
  );
}

export async function getApprovedSignals(exchange, tradeMode = null) {
  const conditions = [`status = 'approved'`];
  const params = [];

  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }
  if (tradeMode) {
    params.push(tradeMode);
    conditions.push(`COALESCE(trade_mode, 'normal') = $${params.length}`);
  }

  return query(
    `SELECT * FROM signals WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC`,
    params,
  );
}

// ─── trades ─────────────────────────────────────────────────────────

export async function insertTrade({ signalId, symbol, side, amount, price, totalUsdt, paper, exchange = 'binance', tpPrice = null, slPrice = null, tpOrderId = null, slOrderId = null, tpSlSet = false, tradeMode = null }) {
  const effectiveTradeMode = tradeMode || getInvestmentTradeMode();
  await run(
    `INSERT INTO trades (signal_id, symbol, side, amount, price, total_usdt, paper, exchange, tp_price, sl_price, tp_order_id, sl_order_id, tp_sl_set, trade_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [signalId ?? null, symbol, side, amount, price, totalUsdt ?? null, paper !== false, exchange,
     tpPrice, slPrice, tpOrderId, slOrderId, tpSlSet ?? false, effectiveTradeMode],
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

export async function getSameDayTrade({
  symbol,
  side,
  exchange = null,
  tradeMode = null,
} = {}) {
  const conditions = [`symbol = $1`, `side = $2`, `executed_at::date = CURRENT_DATE`];
  const params = [symbol, side];

  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }
  if (tradeMode) {
    params.push(tradeMode);
    conditions.push(`COALESCE(trade_mode, 'normal') = $${params.length}`);
  }

  return get(
    `SELECT * FROM trades WHERE ${conditions.join(' AND ')} ORDER BY executed_at DESC LIMIT 1`,
    params,
  );
}

// ─── positions ──────────────────────────────────────────────────────

export async function upsertPosition({ symbol, amount, avgPrice, unrealizedPnl, exchange = 'binance', paper = false, tradeMode = null }) {
  const effectiveTradeMode = paper === true
    ? (tradeMode || getInvestmentTradeMode())
    : 'normal';
  await run(
    `INSERT INTO positions (symbol, amount, avg_price, unrealized_pnl, paper, exchange, trade_mode, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (symbol, exchange, paper, trade_mode) DO UPDATE SET
       amount         = EXCLUDED.amount,
       avg_price      = EXCLUDED.avg_price,
       unrealized_pnl = EXCLUDED.unrealized_pnl,
       paper          = EXCLUDED.paper,
       exchange       = EXCLUDED.exchange,
       trade_mode     = EXCLUDED.trade_mode,
       updated_at     = EXCLUDED.updated_at`,
    [symbol, amount, avgPrice, unrealizedPnl ?? 0, paper === true, exchange, effectiveTradeMode],
  );
}

export async function getPosition(symbol, { exchange = null, paper = null, tradeMode = null } = {}) {
  const conditions = [`symbol = $1`];
  const params = [symbol];

  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }
  if (paper !== null) {
    params.push(paper === true);
    conditions.push(`paper = $${params.length}`);
    if (paper === true) {
      params.push(tradeMode || getInvestmentTradeMode());
      conditions.push(`COALESCE(trade_mode, 'normal') = $${params.length}`);
    }
  }

  const orderBy = paper === null
    ? `ORDER BY paper ASC, updated_at DESC`
    : `ORDER BY updated_at DESC`;

  return get(`SELECT * FROM positions WHERE ${conditions.join(' AND ')} ${orderBy} LIMIT 1`, params);
}

export async function getLivePosition(symbol, exchange = null) {
  return getPosition(symbol, { exchange, paper: false });
}

export async function getPaperPosition(symbol, exchange = null, tradeMode = null) {
  return getPosition(symbol, { exchange, paper: true, tradeMode });
}

export async function getAllPositions(exchange = null, paper = null, tradeMode = null) {
  if (exchange && paper === true && tradeMode) {
    return query(
      `SELECT * FROM positions WHERE amount > 0 AND exchange = $1 AND paper = true AND COALESCE(trade_mode, 'normal') = $2 ORDER BY symbol`,
      [exchange, tradeMode],
    );
  }
  if (paper === true && tradeMode) {
    return query(
      `SELECT * FROM positions WHERE amount > 0 AND paper = true AND COALESCE(trade_mode, 'normal') = $1 ORDER BY symbol`,
      [tradeMode],
    );
  }
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

export async function getPaperPositions(exchange = null, tradeMode = null) {
  if (exchange && tradeMode) {
    return query(
      `SELECT * FROM positions WHERE amount > 0 AND paper = true AND exchange = $1 AND COALESCE(trade_mode, 'normal') = $2 ORDER BY updated_at ASC`,
      [exchange, tradeMode],
    );
  }
  if (exchange) {
    return query(`SELECT * FROM positions WHERE amount > 0 AND paper = true AND exchange = $1 ORDER BY updated_at ASC`, [exchange]);
  }
  if (tradeMode) {
    return query(`SELECT * FROM positions WHERE amount > 0 AND paper = true AND COALESCE(trade_mode, 'normal') = $1 ORDER BY updated_at ASC`, [tradeMode]);
  }
  return query(`SELECT * FROM positions WHERE amount > 0 AND paper = true ORDER BY updated_at ASC`);
}

export async function getOpenPositions(exchange = null, paper = false, tradeMode = null) {
  if (exchange && tradeMode) {
    return query(
      `SELECT p.symbol, p.amount, p.avg_price, p.unrealized_pnl, p.exchange, p.paper,
              COALESCE(p.trade_mode, 'normal') AS trade_mode,
              COALESCE(
                (
                  SELECT MIN(tj.entry_time)
                  FROM trade_journal tj
                  WHERE tj.symbol = p.symbol
                    AND tj.exchange = p.exchange
                    AND tj.is_paper = p.paper
                    AND COALESCE(tj.trade_mode, 'normal') = COALESCE(p.trade_mode, 'normal')
                    AND tj.status = 'open'
                ),
                (EXTRACT(EPOCH FROM p.updated_at) * 1000)::bigint
              ) AS entry_time,
              p.updated_at
       FROM positions p
       WHERE p.amount > 0 AND p.exchange = $1 AND p.paper = $2 AND COALESCE(p.trade_mode, 'normal') = $3
       ORDER BY entry_time ASC`,
      [exchange, paper === true, tradeMode],
    );
  }
  if (exchange) {
    return query(
      `SELECT p.symbol, p.amount, p.avg_price, p.unrealized_pnl, p.exchange, p.paper,
              COALESCE(p.trade_mode, 'normal') AS trade_mode,
              COALESCE(
                (
                  SELECT MIN(tj.entry_time)
                  FROM trade_journal tj
                  WHERE tj.symbol = p.symbol
                    AND tj.exchange = p.exchange
                    AND tj.is_paper = p.paper
                    AND COALESCE(tj.trade_mode, 'normal') = COALESCE(p.trade_mode, 'normal')
                    AND tj.status = 'open'
                ),
                (EXTRACT(EPOCH FROM p.updated_at) * 1000)::bigint
              ) AS entry_time,
              p.updated_at
       FROM positions p
       WHERE p.amount > 0 AND p.exchange = $1 AND p.paper = $2
       ORDER BY entry_time ASC`,
      [exchange, paper === true],
    );
  }
  return query(
    `SELECT p.symbol, p.amount, p.avg_price, p.unrealized_pnl, p.exchange, p.paper,
            COALESCE(p.trade_mode, 'normal') AS trade_mode,
            COALESCE(
              (
                SELECT MIN(tj.entry_time)
                FROM trade_journal tj
                WHERE tj.symbol = p.symbol
                  AND tj.exchange = p.exchange
                  AND tj.is_paper = p.paper
                  AND COALESCE(tj.trade_mode, 'normal') = COALESCE(p.trade_mode, 'normal')
                  AND tj.status = 'open'
              ),
              (EXTRACT(EPOCH FROM p.updated_at) * 1000)::bigint
            ) AS entry_time,
            p.updated_at
     FROM positions p
     WHERE p.amount > 0 AND p.paper = $1
     ORDER BY entry_time ASC`,
    [paper === true],
  );
}

export async function deletePosition(symbol, { exchange = null, paper = null, tradeMode = null } = {}) {
  const conditions = [`symbol = $1`];
  const params = [symbol];

  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }
  if (paper !== null) {
    params.push(paper === true);
    conditions.push(`paper = $${params.length}`);
  }
  if (tradeMode || paper !== null) {
    const effectiveMode = tradeMode || getInvestmentTradeMode();
    params.push(effectiveMode);
    conditions.push(`COALESCE(trade_mode, 'normal') = $${params.length}`);
  }

  await run(`DELETE FROM positions WHERE ${conditions.join(' AND ')}`, params);
}

// ─── 집계 ───────────────────────────────────────────────────────────

export async function getTodayPnl() {
  const rows = await query(`
    SELECT
      COALESCE(SUM(pnl_net), 0) AS pnl,
      COUNT(*) AS trade_count
    FROM trade_journal
    WHERE status = 'closed'
      AND exit_time IS NOT NULL
      AND to_timestamp(exit_time / 1000.0)::date = current_date
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

// ─── runtime_config_suggestion_log ───────────────────────────────────

export async function insertRuntimeConfigSuggestionLog({
  periodDays,
  actionableCount = 0,
  marketSummary,
  suggestions,
  policySnapshot = null,
  reviewStatus = 'pending',
  reviewNote = null,
}) {
  const row = await get(
    `INSERT INTO runtime_config_suggestion_log (
       period_days,
       actionable_count,
       market_summary,
       suggestions,
       policy_snapshot,
       review_status,
       review_note
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, captured_at`,
    [
      periodDays,
      actionableCount,
      JSON.stringify(marketSummary ?? {}),
      JSON.stringify(suggestions ?? []),
      JSON.stringify(policySnapshot ?? {}),
      reviewStatus,
      reviewNote,
    ],
  );
  return row || null;
}

export async function getRecentRuntimeConfigSuggestionLogs(limit = 10) {
  return query(
    `SELECT id, period_days, actionable_count, market_summary, suggestions, policy_snapshot, review_status, review_note, reviewed_at, applied_at, captured_at
     FROM runtime_config_suggestion_log
     ORDER BY captured_at DESC
     LIMIT $1`,
    [limit],
  );
}

export async function getRuntimeConfigSuggestionLogById(id) {
  return get(
    `SELECT id, period_days, actionable_count, market_summary, suggestions, policy_snapshot, review_status, review_note, reviewed_at, applied_at, captured_at
     FROM runtime_config_suggestion_log
     WHERE id = $1`,
    [id],
  );
}

export async function updateRuntimeConfigSuggestionLogReview(id, {
  reviewStatus,
  reviewNote = null,
} = {}) {
  if (!id || !reviewStatus) return null;

  const normalizedStatus = String(reviewStatus).trim().toLowerCase();
  const nowClause = `now()`;
  const appliedClause = normalizedStatus === 'applied' ? nowClause : 'NULL';

  return get(
    `UPDATE runtime_config_suggestion_log
     SET review_status = $1,
         review_note = $2,
         reviewed_at = ${nowClause},
         applied_at = ${appliedClause}
     WHERE id = $3
     RETURNING id, review_status, review_note, reviewed_at, applied_at, captured_at`,
    [normalizedStatus, reviewNote, id],
  );
}

export function close() {
  // pgPool 관리 — 개별 close 불필요 (pgPool.closeAll()로 전체 종료)
}

export default {
  query, run, get, initSchema,
  insertAnalysis, getRecentAnalysis,
  insertSignal, updateSignalStatus, updateSignalAmount, updateSignalBlock, getSignalById, getPendingSignals, getApprovedSignals,
  insertTrade, getTradeHistory, getLatestTradeBySignalId, getSameDayTrade,
  upsertPosition, getPosition, getLivePosition, getPaperPosition, getAllPositions, getPaperPositions, getOpenPositions, deletePosition,
  getTodayPnl,
  insertScreeningHistory,
  getRecentScreeningSymbols,
  upsertStrategy, getActiveStrategies, recordStrategyResult,
  insertRiskLog,
  insertAssetSnapshot, getLatestEquity, getEquityHistory,
  insertRuntimeConfigSuggestionLog, getRecentRuntimeConfigSuggestionLogs,
  getRuntimeConfigSuggestionLogById, updateRuntimeConfigSuggestionLogReview,
  close,
};
