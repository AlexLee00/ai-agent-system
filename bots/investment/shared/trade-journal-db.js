/**
 * shared/trade-journal-db.js — 루나팀 매매일지 DB (Phase 3-A ESM)
 *
 * 테이블: trade_journal, trade_rationale, trade_review, performance_daily, luna_monitor
 * 기존 trades/signals/positions 테이블은 그대로 유지 (이 파일은 보완용)
 *
 * 주의: shared/db.js의 query/run 재사용 (PostgreSQL investment 스키마).
 *       AUTO INCREMENT 없음 → gen_random_uuid() 또는 시퀀스 ID 사용.
 *       ? 플레이스홀더 → pg-pool이 $1/$2... 자동 변환.
 */

import { query, run } from './db.js';

// ─── 지연 초기화 (첫 호출 시 자동 실행) ────────────────────────────

let _initPromise = null;

function ensureInit() {
  if (!_initPromise) {
    _initPromise = initJournalSchema().catch(err => {
      _initPromise = null;
      throw err;
    });
  }
  return _initPromise;
}

// ─── 스키마 초기화 ────────────────────────────────────────────────────

export async function initJournalSchema() {
  // ── trade_journal: 상세 거래 기록 ──────────────────────────────────
  await run(`
    CREATE TABLE IF NOT EXISTS trade_journal (
      id                VARCHAR DEFAULT gen_random_uuid()::text,
      trade_id          VARCHAR NOT NULL UNIQUE,
      signal_id         VARCHAR,

      market            VARCHAR NOT NULL,
      exchange          VARCHAR NOT NULL,
      symbol            VARCHAR NOT NULL,
      is_paper          BOOLEAN NOT NULL DEFAULT true,

      entry_time        BIGINT NOT NULL,
      entry_price       DOUBLE PRECISION NOT NULL,
      entry_size        DOUBLE PRECISION NOT NULL,
      entry_value       DOUBLE PRECISION NOT NULL,
      direction         VARCHAR NOT NULL DEFAULT 'long',

      exit_time         BIGINT,
      exit_price        DOUBLE PRECISION,
      exit_value        DOUBLE PRECISION,
      exit_reason       VARCHAR,

      pnl_amount        DOUBLE PRECISION,
      pnl_percent       DOUBLE PRECISION,
      fee_total         DOUBLE PRECISION,
      pnl_net           DOUBLE PRECISION,

      status            VARCHAR NOT NULL DEFAULT 'open',
      hold_duration     BIGINT,

      signal_time       BIGINT,
      decision_time     BIGINT,
      execution_time    BIGINT,
      signal_to_exec_ms BIGINT,

      tp_price          DOUBLE PRECISION,
      sl_price          DOUBLE PRECISION,
      tp_order_id       VARCHAR,
      sl_order_id       VARCHAR,
      tp_sl_set         BOOLEAN DEFAULT false,

      created_at        BIGINT NOT NULL
    )
  `);
  try { await run(`CREATE INDEX IF NOT EXISTS idx_journal_market ON trade_journal(market, created_at)`); } catch { /* 이미 있으면 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_journal_status ON trade_journal(status, created_at)`); } catch { /* 이미 있으면 무시 */ }

  // ── trade_rationale: 판단 근거 ─────────────────────────────────────
  await run(`
    CREATE TABLE IF NOT EXISTS trade_rationale (
      id                     VARCHAR DEFAULT gen_random_uuid()::text,
      trade_id               VARCHAR,
      signal_id              VARCHAR,

      aria_signal            VARCHAR,
      sophia_signal          VARCHAR,
      oracle_signal          VARCHAR,
      hermes_signal          VARCHAR,

      zeus_bull_case         VARCHAR,
      zeus_target            DOUBLE PRECISION,
      athena_bear_case       VARCHAR,
      athena_risk            DOUBLE PRECISION,

      luna_decision          VARCHAR NOT NULL,
      luna_reasoning         VARCHAR NOT NULL,
      luna_confidence        DOUBLE PRECISION,

      nemesis_verdict        VARCHAR,
      nemesis_notes          VARCHAR,
      position_size_original DOUBLE PRECISION,
      position_size_approved DOUBLE PRECISION,

      created_at             BIGINT NOT NULL
    )
  `);
  try { await run(`CREATE INDEX IF NOT EXISTS idx_rationale_trade   ON trade_rationale(trade_id)`); }  catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_rationale_signal  ON trade_rationale(signal_id)`); } catch { /* 무시 */ }

  // ── trade_review: 사후 평가 ────────────────────────────────────────
  await run(`
    CREATE TABLE IF NOT EXISTS trade_review (
      id                  VARCHAR DEFAULT gen_random_uuid()::text,
      trade_id            VARCHAR NOT NULL,

      entry_timing        VARCHAR,
      exit_timing         VARCHAR,
      signal_accuracy     VARCHAR,
      risk_managed        BOOLEAN,
      tp_sl_protected     BOOLEAN,
      execution_speed     VARCHAR,

      max_favorable       DOUBLE PRECISION,
      max_adverse         DOUBLE PRECISION,

      aria_accurate       BOOLEAN,
      sophia_accurate     BOOLEAN,
      oracle_accurate     BOOLEAN,
      hermes_accurate     BOOLEAN,

      luna_review         VARCHAR,
      lessons_learned     VARCHAR,
      strategy_adjustment VARCHAR,

      reviewed_at         BIGINT
    )
  `);
  try { await run(`CREATE INDEX IF NOT EXISTS idx_review_trade ON trade_review(trade_id)`); } catch { /* 무시 */ }

  // ── performance_daily: 일간 성과 ───────────────────────────────────
  await run(`
    CREATE TABLE IF NOT EXISTS performance_daily (
      id              VARCHAR DEFAULT gen_random_uuid()::text,
      date            VARCHAR NOT NULL,
      market          VARCHAR NOT NULL,

      total_trades    INTEGER DEFAULT 0,
      winning_trades  INTEGER DEFAULT 0,
      losing_trades   INTEGER DEFAULT 0,
      win_rate        DOUBLE PRECISION,

      pnl_gross       DOUBLE PRECISION DEFAULT 0,
      pnl_net         DOUBLE PRECISION DEFAULT 0,
      fees_total      DOUBLE PRECISION DEFAULT 0,

      best_trade_pnl  DOUBLE PRECISION,
      worst_trade_pnl DOUBLE PRECISION,
      avg_hold_time   BIGINT,

      aria_accuracy   DOUBLE PRECISION,
      sophia_accuracy DOUBLE PRECISION,
      oracle_accuracy DOUBLE PRECISION,
      hermes_accuracy DOUBLE PRECISION,

      created_at      BIGINT NOT NULL,

      UNIQUE(date, market)
    )
  `);

  // ── luna_monitor: 에러율 + API + 실행속도 추적 ──────────────────────
  await run(`
    CREATE TABLE IF NOT EXISTS luna_monitor (
      id         VARCHAR DEFAULT gen_random_uuid()::text,
      timestamp  BIGINT NOT NULL,
      event_type VARCHAR NOT NULL,
      exchange   VARCHAR,
      details    VARCHAR,
      severity   VARCHAR DEFAULT 'info',
      resolved   BOOLEAN DEFAULT false
    )
  `);
  try { await run(`CREATE INDEX IF NOT EXISTS idx_monitor_type ON luna_monitor(event_type, timestamp)`); } catch { /* 무시 */ }

  // ── v4 마이그레이션 기록 ──────────────────────────────────────────
  try {
    const v4 = await query(`SELECT version FROM schema_migrations WHERE version = 4`);
    if (v4.length === 0) {
      await run(`INSERT INTO schema_migrations (version, name) VALUES (4, 'trade_journal_system')`);
    }
  } catch { /* 무시 */ }

  console.log('✅ 매매일지 스키마 초기화 완료');
}

// ─── trade_id 생성 ────────────────────────────────────────────────────

/**
 * 'TRD-20260306-001' 형식 trade_id 자동 생성
 */
export async function generateTradeId() {
  await ensureInit();
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const prefix  = `TRD-${dateStr}-`;
  const rows    = await query(
    `SELECT COUNT(*) AS cnt FROM trade_journal WHERE trade_id LIKE ?`,
    [prefix + '%'],
  );
  const seq = (Number(rows[0]?.cnt) || 0) + 1;
  return `${prefix}${String(seq).padStart(3, '0')}`;
}

// ─── trade_journal ────────────────────────────────────────────────────

/**
 * 거래 일지 진입 기록
 */
export async function insertJournalEntry(entry) {
  await ensureInit();
  const now = Date.now();
  try {
    await run(
      `INSERT INTO trade_journal (
        trade_id, signal_id, market, exchange, symbol, is_paper,
        entry_time, entry_price, entry_size, entry_value, direction,
        signal_time, decision_time, execution_time, signal_to_exec_ms,
        tp_price, sl_price, tp_order_id, sl_order_id, tp_sl_set,
        status, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        entry.trade_id, entry.signal_id ?? null,
        entry.market, entry.exchange, entry.symbol, entry.is_paper ?? true,
        entry.entry_time ?? now, entry.entry_price, entry.entry_size, entry.entry_value,
        entry.direction ?? 'long',
        entry.signal_time ?? null, entry.decision_time ?? null,
        entry.execution_time ?? now, entry.signal_to_exec_ms ?? null,
        entry.tp_price ?? null, entry.sl_price ?? null,
        entry.tp_order_id ?? null, entry.sl_order_id ?? null,
        entry.tp_sl_set ?? false,
        'open', now,
      ],
    );
  } catch (e) {
    console.warn('[trade-journal] trade_journal INSERT 실패 (메인 로직에 영향 없음):', e.message);
  }
}

/**
 * 거래 일지 청산 기록
 */
export async function closeJournalEntry(tradeId, { exitTime, exitPrice, exitValue, exitReason, pnlAmount, pnlPercent, feeTotal, pnlNet } = {}) {
  await ensureInit();
  const now = Date.now();
  await run(
    `UPDATE trade_journal
     SET exit_time     = ?,
         exit_price    = ?,
         exit_value    = ?,
         exit_reason   = ?,
         pnl_amount    = ?,
         pnl_percent   = ?,
         fee_total     = ?,
         pnl_net       = ?,
         status        = 'closed',
         hold_duration = ? - entry_time
     WHERE trade_id = ?`,
    [
      exitTime ?? now, exitPrice ?? null, exitValue ?? null,
      exitReason ?? 'manual',
      pnlAmount ?? null, pnlPercent ?? null, feeTotal ?? null, pnlNet ?? null,
      exitTime ?? now,
      tradeId,
    ],
  );
}

export async function getOpenJournalEntries(market = null) {
  await ensureInit();
  if (market) {
    return query(
      `SELECT * FROM trade_journal WHERE status = 'open' AND market = ? ORDER BY created_at DESC`,
      [market],
    );
  }
  return query(`SELECT * FROM trade_journal WHERE status = 'open' ORDER BY created_at DESC`);
}

export async function getJournalByDate(date, market = null) {
  await ensureInit();
  // date: 'YYYY-MM-DD'
  const startMs = new Date(date).getTime();
  const endMs   = startMs + 86400000;
  if (market) {
    return query(
      `SELECT * FROM trade_journal WHERE created_at >= ? AND created_at < ? AND market = ? ORDER BY created_at`,
      [startMs, endMs, market],
    );
  }
  return query(
    `SELECT * FROM trade_journal WHERE created_at >= ? AND created_at < ? ORDER BY created_at`,
    [startMs, endMs],
  );
}

// ─── trade_rationale ──────────────────────────────────────────────────

/**
 * 판단 근거 기록
 * - nemesis.js: trade_id=null, signal_id 전달 → 네메시스 판단 시
 * - hephaestos.js: linkRationaleToTrade()로 trade_id 연결
 */
export async function insertRationale(rationaleData) {
  await ensureInit();
  const now = Date.now();
  try {
    await run(
      `INSERT INTO trade_rationale (
        trade_id, signal_id,
        aria_signal, sophia_signal, oracle_signal, hermes_signal,
        zeus_bull_case, zeus_target, athena_bear_case, athena_risk,
        luna_decision, luna_reasoning, luna_confidence,
        nemesis_verdict, nemesis_notes,
        position_size_original, position_size_approved,
        created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        rationaleData.trade_id ?? null, rationaleData.signal_id ?? null,
        rationaleData.aria_signal ?? null, rationaleData.sophia_signal ?? null,
        rationaleData.oracle_signal ?? null, rationaleData.hermes_signal ?? null,
        rationaleData.zeus_bull_case ?? null, rationaleData.zeus_target ?? null,
        rationaleData.athena_bear_case ?? null, rationaleData.athena_risk ?? null,
        rationaleData.luna_decision ?? 'skip', rationaleData.luna_reasoning ?? '',
        rationaleData.luna_confidence ?? null,
        rationaleData.nemesis_verdict ?? null, rationaleData.nemesis_notes ?? null,
        rationaleData.position_size_original ?? null, rationaleData.position_size_approved ?? null,
        now,
      ],
    );
  } catch (e) {
    console.warn('[trade-journal] trade_rationale INSERT 실패 (메인 로직에 영향 없음):', e.message);
  }
}

/**
 * 네메시스가 기록한 rationale에 실제 trade_id 연결 (헤파이스토스 호출)
 */
export async function linkRationaleToTrade(tradeId, signalId) {
  await ensureInit();
  await run(
    `UPDATE trade_rationale SET trade_id = ? WHERE signal_id = ? AND trade_id IS NULL`,
    [tradeId, signalId],
  );
}

// ─── trade_review ─────────────────────────────────────────────────────

export async function insertReview(tradeId, review) {
  await ensureInit();
  try {
    await run(
      `INSERT INTO trade_review (
        trade_id, entry_timing, exit_timing, signal_accuracy,
        risk_managed, tp_sl_protected, execution_speed,
        max_favorable, max_adverse,
        aria_accurate, sophia_accurate, oracle_accurate, hermes_accurate,
        luna_review, lessons_learned, strategy_adjustment, reviewed_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        tradeId,
        review.entry_timing ?? null, review.exit_timing ?? null, review.signal_accuracy ?? null,
        review.risk_managed ?? null, review.tp_sl_protected ?? null, review.execution_speed ?? null,
        review.max_favorable ?? null, review.max_adverse ?? null,
        review.aria_accurate ?? null, review.sophia_accurate ?? null,
        review.oracle_accurate ?? null, review.hermes_accurate ?? null,
        review.luna_review ?? null, review.lessons_learned ?? null,
        review.strategy_adjustment ?? null, Date.now(),
      ],
    );
  } catch (e) {
    console.warn('[trade-journal] trade_review INSERT 실패 (메인 로직에 영향 없음):', e.message);
  }
}

// ─── performance_daily ────────────────────────────────────────────────

export async function upsertDailyPerformance(date, market, data) {
  await ensureInit();
  const now = Date.now();
  await run(
    `INSERT INTO performance_daily (
      date, market,
      total_trades, winning_trades, losing_trades, win_rate,
      pnl_gross, pnl_net, fees_total,
      best_trade_pnl, worst_trade_pnl, avg_hold_time,
      aria_accuracy, sophia_accuracy, oracle_accuracy, hermes_accuracy,
      created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (date, market) DO UPDATE SET
      total_trades    = excluded.total_trades,
      winning_trades  = excluded.winning_trades,
      losing_trades   = excluded.losing_trades,
      win_rate        = excluded.win_rate,
      pnl_gross       = excluded.pnl_gross,
      pnl_net         = excluded.pnl_net,
      fees_total      = excluded.fees_total,
      best_trade_pnl  = excluded.best_trade_pnl,
      worst_trade_pnl = excluded.worst_trade_pnl,
      avg_hold_time   = excluded.avg_hold_time,
      aria_accuracy   = excluded.aria_accuracy,
      sophia_accuracy = excluded.sophia_accuracy,
      oracle_accuracy = excluded.oracle_accuracy,
      hermes_accuracy = excluded.hermes_accuracy`,
    [
      date, market,
      data.total_trades ?? 0, data.winning_trades ?? 0, data.losing_trades ?? 0,
      data.win_rate ?? null,
      data.pnl_gross ?? 0, data.pnl_net ?? 0, data.fees_total ?? 0,
      data.best_trade_pnl ?? null, data.worst_trade_pnl ?? null, data.avg_hold_time ?? null,
      data.aria_accuracy ?? null, data.sophia_accuracy ?? null,
      data.oracle_accuracy ?? null, data.hermes_accuracy ?? null,
      now,
    ],
  );
}

export async function getDailyPerformance(date) {
  await ensureInit();
  return query(`SELECT * FROM performance_daily WHERE date = ? ORDER BY market`, [date]);
}

export async function getWeeklyPerformance(startDate, endDate) {
  await ensureInit();
  return query(
    `SELECT * FROM performance_daily WHERE date >= ? AND date <= ? ORDER BY date, market`,
    [startDate, endDate],
  );
}

// ─── luna_monitor ─────────────────────────────────────────────────────

export async function logMonitorEvent(eventType, exchange, details, severity = 'info') {
  await ensureInit();
  await run(
    `INSERT INTO luna_monitor (timestamp, event_type, exchange, details, severity)
     VALUES (?,?,?,?,?)`,
    [Date.now(), eventType, exchange ?? null, details ? JSON.stringify(details) : null, severity],
  );
}

export async function getApiFailureCount(exchange, hours = 1) {
  await ensureInit();
  const since = Date.now() - hours * 3600000;
  const rows  = await query(
    `SELECT COUNT(*) AS cnt FROM luna_monitor
     WHERE event_type = 'api_error' AND exchange = ? AND timestamp >= ?`,
    [exchange, since],
  );
  return Number(rows[0]?.cnt) || 0;
}

export async function getExecutionDelayStats(hours = 1) {
  await ensureInit();
  const since = Date.now() - hours * 3600000;
  return query(
    `SELECT COUNT(*) AS cnt FROM luna_monitor
     WHERE event_type = 'execution_delay' AND timestamp >= ?`,
    [since],
  );
}

export async function getUnresolvedIssues() {
  await ensureInit();
  return query(
    `SELECT * FROM luna_monitor
     WHERE resolved = false AND severity IN ('warning', 'critical')
     ORDER BY timestamp DESC LIMIT 50`,
  );
}

export default {
  initJournalSchema,
  generateTradeId,
  insertJournalEntry, closeJournalEntry, getOpenJournalEntries, getJournalByDate,
  insertRationale, linkRationaleToTrade,
  insertReview,
  upsertDailyPerformance, getDailyPerformance, getWeeklyPerformance,
  logMonitorEvent, getApiFailureCount, getExecutionDelayStats, getUnresolvedIssues,
};
