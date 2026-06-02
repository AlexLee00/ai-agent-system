#!/usr/bin/env node
// @ts-nocheck
/**
 * Luna guard-blocked counterfactual SHADOW batch.
 *
 * 차단된 entry_trigger가 실제로 진입했다고 가정하고, 차단 이후 OHLCV로
 * triple-barrier(TP/SL/시간) 가상 결과를 산출한다. 가드/진입 로직은 변경하지 않는다.
 */

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { getOHLCV } from '../shared/ohlcv-fetcher.ts';
import { query, run } from '../shared/db/core.ts';
import ccxt from 'ccxt';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const ENABLED = TRUE_VALUES.has(String(process.env.LUNA_GUARD_COUNTERFACTUAL_ENABLED || 'false').trim().toLowerCase());
const DEFAULT_REASONS = [
  'active_entry_trigger_quality_terminal_blocked',
  'active_entry_trigger_quality_gate_blocked',
  'live_risk_gate_terminal_blocked',
  'live_risk_gate_blocked',
  'tradingview_chart_guard_blocked',
  'technical_change_gate_blocked',
  'technical_change_active_gate_blocked',
];
const REASONS = String(process.env.LUNA_GUARD_COUNTERFACTUAL_REASONS || DEFAULT_REASONS.join(','))
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const SOURCE_MODES = new Set(['all', 'entry_triggers', 'trade_data', 'guard_events']);
const DEFAULT_SOURCE_MODE = SOURCE_MODES.has(String(process.env.LUNA_GUARD_COUNTERFACTUAL_SOURCE || '').trim())
  ? String(process.env.LUNA_GUARD_COUNTERFACTUAL_SOURCE).trim()
  : 'all';
const BATCH_LIMIT = Math.max(1, Number(process.env.LUNA_GUARD_COUNTERFACTUAL_BATCH_LIMIT || 100));
const TIMEFRAME = String(process.env.LUNA_GUARD_COUNTERFACTUAL_TIMEFRAME || '1h').trim();
const TIME_BARRIER_BARS = Math.max(1, Number(process.env.LUNA_GUARD_COUNTERFACTUAL_TIME_BARRIER_BARS || 24));
const TP_PCT = Math.max(0.0001, Number(process.env.LUNA_GUARD_COUNTERFACTUAL_TP_PCT || 0.03));
const SL_PCT = Math.max(0.0001, Number(process.env.LUNA_GUARD_COUNTERFACTUAL_SL_PCT || 0.02));
const LOOKBACK_DAYS = Math.max(1, Number(process.env.LUNA_GUARD_COUNTERFACTUAL_LOOKBACK_DAYS || 30));
const ENTERED_COMPARE_DAYS = Math.max(1, Number(process.env.LUNA_GUARD_COUNTERFACTUAL_COMPARE_DAYS || 30));
const ENTERED_MATCH_WINDOW_MINUTES = Math.max(1, Number(process.env.LUNA_GUARD_COUNTERFACTUAL_MATCH_WINDOW_MINUTES || 120));
const POS_RATE_EPS = Math.max(0, Number(process.env.LUNA_GUARD_COUNTERFACTUAL_POS_RATE_EPS || 0));
const TRADE_DATA_REASONS = String(
  process.env.LUNA_GUARD_COUNTERFACTUAL_TRADE_DATA_REASONS
    || 'crypto_defensive_rotation_without_live_evidence,crypto_trend_following_without_confirmation',
)
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
let binanceMarketStatusCache = null;

export function candleTs(row) {
  return Number(row?.[0] ?? row?.timestamp ?? row?.ts ?? row?.candle_ts ?? 0);
}

export function candleHigh(row) {
  return Number(row?.[2] ?? row?.high ?? 0);
}

export function candleLow(row) {
  return Number(row?.[3] ?? row?.low ?? 0);
}

export function candleClose(row) {
  return Number(row?.[4] ?? row?.close ?? 0);
}

function normalizeExchange(exchange) {
  const raw = String(exchange || 'binance').trim().toLowerCase();
  if (raw === 'kis_domestic' || raw === 'kis_overseas') return 'kis';
  return raw || 'binance';
}

function parseDate(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function addMs(date, ms) {
  return new Date(date.getTime() + ms);
}

function timeframeMs(timeframe) {
  const map = {
    '1m': 60_000,
    '5m': 300_000,
    '15m': 900_000,
    '1h': 3_600_000,
    '4h': 14_400_000,
    '1d': 86_400_000,
  };
  const value = map[String(timeframe || '').trim()];
  if (!value) throw new Error(`unsupported_timeframe(${timeframe})`);
  return value;
}

function safeNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function getBinanceMarketStatus(symbol) {
  if (!binanceMarketStatusCache) {
    binanceMarketStatusCache = (async () => {
      const exchange = new ccxt.binance({
        timeout: 10_000,
        enableRateLimit: true,
        options: { defaultType: 'spot' },
      });
      try {
        await exchange.loadMarkets();
        return exchange.markets || {};
      } finally {
        await exchange.close?.().catch(() => null);
      }
    })();
  }
  const markets = await binanceMarketStatusCache.catch(() => ({}));
  const market = markets?.[symbol];
  if (!market) return 'missing';
  return market.active === false ? 'inactive' : 'active';
}

export function computeTripleBarrierOutcome({
  candles,
  blockedAt,
  entryPrice,
  takeProfit,
  stopLoss,
  timeBarrierBars = TIME_BARRIER_BARS,
  timeframe = TIMEFRAME,
} = {}) {
  const start = blockedAt instanceof Date ? blockedAt : parseDate(blockedAt);
  if (!start) {
    return { ok: false, status: 'invalid_blocked_at', virtualLabel: null, barsEvaluated: 0 };
  }
  const barrierAt = addMs(start, timeframeMs(timeframe) * Math.max(1, Number(timeBarrierBars || 1)));
  const rows = Array.isArray(candles)
    ? candles
      .filter((row) => {
        const ts = candleTs(row);
        return ts >= start.getTime() && ts <= barrierAt.getTime();
      })
      .sort((a, b) => candleTs(a) - candleTs(b))
    : [];
  if (rows.length === 0) {
    return { ok: false, status: 'missing_ohlcv_after_block', virtualLabel: null, barsEvaluated: 0 };
  }

  const first = rows[0];
  const resolvedEntry = safeNumber(entryPrice, candleClose(first));
  if (!resolvedEntry) {
    return { ok: false, status: 'invalid_entry_price', virtualLabel: null, barsEvaluated: rows.length };
  }
  const resolvedTp = safeNumber(takeProfit, resolvedEntry * (1 + TP_PCT));
  const resolvedSl = safeNumber(stopLoss, resolvedEntry * (1 - SL_PCT));
  const horizonRows = rows.slice(0, Math.max(1, Number(timeBarrierBars || 1)));

  for (const row of horizonRows) {
    const high = candleHigh(row);
    const low = candleLow(row);
    const close = candleClose(row);
    const ts = new Date(candleTs(row));
    if (low > 0 && low <= resolvedSl) {
      return {
        ok: true,
        status: 'ok',
        virtualLabel: -1,
        virtualReturn: (resolvedSl - resolvedEntry) / resolvedEntry,
        exitPrice: resolvedSl,
        exitTs: ts,
        exitReason: 'stop_loss',
        barsEvaluated: horizonRows.indexOf(row) + 1,
        entryPrice: resolvedEntry,
        takeProfit: resolvedTp,
        stopLoss: resolvedSl,
        timeBarrierAt: barrierAt,
      };
    }
    if (high > 0 && high >= resolvedTp) {
      return {
        ok: true,
        status: 'ok',
        virtualLabel: 1,
        virtualReturn: (resolvedTp - resolvedEntry) / resolvedEntry,
        exitPrice: resolvedTp,
        exitTs: ts,
        exitReason: 'take_profit',
        barsEvaluated: horizonRows.indexOf(row) + 1,
        entryPrice: resolvedEntry,
        takeProfit: resolvedTp,
        stopLoss: resolvedSl,
        timeBarrierAt: barrierAt,
      };
    }
    if (!Number.isFinite(close)) continue;
  }

  const horizonElapsed = Date.now() >= barrierAt.getTime();
  if (!horizonElapsed && horizonRows.length < Math.max(1, Number(timeBarrierBars || 1))) {
    return {
      ok: false,
      status: 'pending_time_barrier',
      virtualLabel: null,
      virtualReturn: null,
      exitPrice: null,
      exitTs: null,
      exitReason: null,
      barsEvaluated: horizonRows.length,
      entryPrice: resolvedEntry,
      takeProfit: resolvedTp,
      stopLoss: resolvedSl,
      timeBarrierAt: barrierAt,
    };
  }

  const last = horizonRows[horizonRows.length - 1];
  const exitPrice = candleClose(last);
  return {
    ok: true,
    status: 'ok',
    virtualLabel: 0,
    virtualReturn: exitPrice && resolvedEntry ? (exitPrice - resolvedEntry) / resolvedEntry : null,
    exitPrice: exitPrice || null,
    exitTs: new Date(candleTs(last)),
    exitReason: 'time_barrier',
    barsEvaluated: horizonRows.length,
    entryPrice: resolvedEntry,
    takeProfit: resolvedTp,
    stopLoss: resolvedSl,
    timeBarrierAt: barrierAt,
  };
}

async function ensureTable() {
  await run(`
    CREATE TABLE IF NOT EXISTS luna_guard_counterfactual (
      id                BIGSERIAL PRIMARY KEY,
      trigger_id        TEXT NOT NULL UNIQUE,
      symbol            TEXT NOT NULL,
      exchange          TEXT,
      reason            TEXT NOT NULL,
      blocked_at        TIMESTAMPTZ NOT NULL,
      entry_price       DOUBLE PRECISION,
      take_profit       DOUBLE PRECISION,
      stop_loss         DOUBLE PRECISION,
      time_barrier_at   TIMESTAMPTZ,
      timeframe         TEXT NOT NULL,
      bars_evaluated    INTEGER NOT NULL DEFAULT 0,
      virtual_label     INTEGER,
      virtual_return    DOUBLE PRECISION,
      exit_price        DOUBLE PRECISION,
      exit_ts           TIMESTAMPTZ,
      exit_reason       TEXT,
      ohlcv_status      TEXT NOT NULL DEFAULT 'pending',
      metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
      computed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `, []);
  await run(`
    CREATE INDEX IF NOT EXISTS idx_luna_guard_counterfactual_reason
      ON luna_guard_counterfactual (reason, computed_at DESC)
  `, []);
  await run(`
    CREATE INDEX IF NOT EXISTS idx_luna_guard_counterfactual_symbol
      ON luna_guard_counterfactual (symbol, computed_at DESC)
  `, []);
}

async function loadBlockedTriggers(limit = BATCH_LIMIT) {
  const rows = await query(`
    SELECT
      t.id,
      t.symbol,
      t.exchange,
      t.target_price,
      t.stop_loss,
      t.take_profit,
      t.created_at,
      t.expires_at,
      t.updated_at,
      t.trigger_context,
      t.trigger_meta,
      COALESCE(t.trigger_meta->>'reason', 'unknown') AS reason,
      COALESCE(
        t.trigger_meta->>'terminalBlockedAt',
        t.trigger_meta->>'lastReadyAt',
        t.expires_at::text,
        t.updated_at::text,
        t.created_at::text
      ) AS blocked_at
    FROM entry_triggers t
    LEFT JOIN luna_guard_counterfactual cf ON cf.trigger_id = t.id
    WHERE (
      cf.trigger_id IS NULL
      OR (cf.ohlcv_status <> 'ok' AND cf.ohlcv_status NOT LIKE 'skipped_%')
    )
      AND t.trigger_state = 'expired'
      AND COALESCE(t.trigger_meta->>'reason', '') = ANY($1::text[])
      AND COALESCE(t.updated_at, t.created_at) >= NOW() - INTERVAL '1 day' * $2
    ORDER BY COALESCE(t.updated_at, t.created_at) ASC
    LIMIT $3
  `, [REASONS, LOOKBACK_DAYS, limit]).catch(() => []);
  return rows || [];
}

async function loadBlockedTradeDataSignals(limit = BATCH_LIMIT) {
  if (TRADE_DATA_REASONS.length === 0) return [];
  const rows = await query(`
    WITH signal_candidates AS (
      SELECT
        s.id AS source_id,
        s.symbol,
        s.exchange,
        s.created_at AS blocked_at,
        s.created_at,
        s.strategy_family,
        s.strategy_route,
        s.block_code,
        s.block_reason,
        s.block_meta,
        s.block_meta->'tradeDataGuard' AS trade_data_guard,
        COALESCE(
          blocker.reason,
          CASE
            WHEN s.block_reason LIKE 'trade-data entry guard blocked:%'
            THEN btrim(replace(s.block_reason, 'trade-data entry guard blocked:', ''))
            ELSE NULL
          END
        ) AS reason
      FROM signals s
      LEFT JOIN LATERAL (
        SELECT jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(s.block_meta->'tradeDataGuard'->'blockers') = 'array'
            THEN s.block_meta->'tradeDataGuard'->'blockers'
            ELSE '[]'::jsonb
          END
        ) AS reason
      ) blocker ON TRUE
      WHERE s.block_code = 'trade_data_entry_guard_rejected'
        AND lower(COALESCE(s.exchange, 'binance')) = 'binance'
        AND s.created_at >= NOW() - INTERVAL '1 day' * $2
    ),
    dedup AS (
      SELECT DISTINCT ON (source_id, reason)
        source_id, symbol, exchange, blocked_at, created_at,
        strategy_family, strategy_route, block_code, block_reason,
        block_meta, trade_data_guard, reason
      FROM signal_candidates
      WHERE reason = ANY($1::text[])
      ORDER BY source_id, reason, created_at ASC
    )
    SELECT
      'signal:' || d.source_id || ':' || d.reason AS id,
      d.source_id,
      d.symbol,
      d.exchange,
      d.reason,
      d.blocked_at,
      d.created_at,
      d.strategy_family,
      d.strategy_route,
      d.block_code,
      d.block_reason,
      d.block_meta,
      d.trade_data_guard
    FROM dedup d
    LEFT JOIN luna_guard_counterfactual cf
      ON cf.trigger_id = 'signal:' || d.source_id || ':' || d.reason
    WHERE (
      cf.trigger_id IS NULL
      OR (cf.ohlcv_status <> 'ok' AND cf.ohlcv_status NOT LIKE 'skipped_%')
    )
    ORDER BY d.created_at ASC
    LIMIT $3
  `, [TRADE_DATA_REASONS, LOOKBACK_DAYS, limit]).catch(() => []);
  return (rows || []).map((row) => ({
    id: row.id,
    source_id: row.source_id,
    symbol: row.symbol,
    exchange: row.exchange || 'binance',
    reason: row.reason,
    blocked_at: row.blocked_at,
    created_at: row.created_at,
    target_price: null,
    take_profit: null,
    stop_loss: null,
    strategy_family: row.strategy_family || row.trade_data_guard?.meta?.strategyFamily || 'unknown',
    strategy_route: row.strategy_route || null,
    block_code: row.block_code || null,
    block_reason: row.block_reason || null,
    block_meta: row.block_meta || null,
    trade_data_guard: row.trade_data_guard || null,
    _source: 'signals',
  }));
}

async function loadBlockedGuardEvents(limit = BATCH_LIMIT) {
  if (TRADE_DATA_REASONS.length === 0) return [];
  const rows = await query(`
    SELECT
      e.id,
      e.symbol,
      e.exchange,
      e.reason,
      e.guard_metadata,
      e.triggered_at AS blocked_at,
      e.triggered_at AS created_at
    FROM investment.guard_events e
    LEFT JOIN luna_guard_counterfactual cf
      ON cf.trigger_id = 'guard_event:' || e.id::text
    WHERE (
      cf.trigger_id IS NULL
      OR (cf.ohlcv_status <> 'ok' AND cf.ohlcv_status NOT LIKE 'skipped_%')
    )
      AND e.reason = ANY($1::text[])
      AND e.triggered_at >= NOW() - INTERVAL '1 day' * $2
      AND e.guard_metadata ? 'meta'
    ORDER BY e.triggered_at ASC
    LIMIT $3
  `, [TRADE_DATA_REASONS, LOOKBACK_DAYS, limit]).catch(() => []);
  return (rows || []).map((row) => ({
    id: `guard_event:${row.id}`,
    symbol: row.symbol,
    exchange: row.exchange || 'binance',
    reason: row.reason,
    blocked_at: row.blocked_at,
    created_at: row.created_at,
    target_price: null,
    take_profit: null,
    stop_loss: null,
    strategy_family: row.guard_metadata?.meta?.strategyFamily || 'unknown',
    guard_metadata: row.guard_metadata || null,
    _source: 'guard_events',
  }));
}

async function loadCounterfactualSources({ limit = BATCH_LIMIT, source = DEFAULT_SOURCE_MODE } = {}) {
  const mode = SOURCE_MODES.has(String(source || '').trim()) ? String(source).trim() : 'all';
  const sources = [];
  if (mode === 'all' || mode === 'entry_triggers') {
    sources.push(...await loadBlockedTriggers(limit));
  }
  if (mode === 'all' || mode === 'trade_data') {
    sources.push(...await loadBlockedTradeDataSignals(limit));
  }
  if (mode === 'guard_events') {
    sources.push(...await loadBlockedGuardEvents(limit));
  }
  return sources
    .sort((a, b) => (blockedAtForTrigger(a)?.getTime() || 0) - (blockedAtForTrigger(b)?.getTime() || 0));
}

function blockedAtForTrigger(trigger) {
  return parseDate(trigger.blocked_at) || parseDate(trigger.expires_at) || parseDate(trigger.updated_at) || parseDate(trigger.created_at);
}

function marketForExchange(exchange) {
  const normalized = normalizeExchange(exchange);
  return normalized === 'kis' ? 'kis' : 'binance';
}

async function computeForTrigger(trigger, options = {}) {
  const blockedAt = blockedAtForTrigger(trigger);
  if (!blockedAt) {
    return {
      trigger,
      outcome: { ok: false, status: 'invalid_blocked_at', virtualLabel: null, barsEvaluated: 0 },
      candles: [],
    };
  }
  const timeframe = options.timeframe || TIMEFRAME;
  const horizonMs = timeframeMs(timeframe) * Math.max(1, Number(options.timeBarrierBars || TIME_BARRIER_BARS));
  const from = blockedAt.toISOString();
  const to = addMs(blockedAt, horizonMs).toISOString();
  const exchange = normalizeExchange(trigger.exchange);
  // Yahoo-style KIS fallback treats to-date as exclusive; pad fetch only, then
  // computeTripleBarrierOutcome enforces the original time barrier.
  const fetchTo = exchange === 'kis' ? addMs(blockedAt, horizonMs + timeframeMs('1d')).toISOString() : to;
  const candles = options.candles || await getOHLCV(trigger.symbol, timeframe, from, fetchTo, marketForExchange(exchange)).catch((error) => {
    return { __error: error?.message || String(error) };
  });
  if (!Array.isArray(candles)) {
    return {
      trigger,
      outcome: {
        ok: false,
        status: `ohlcv_fetch_failed:${candles?.__error || 'unknown'}`,
        virtualLabel: null,
        barsEvaluated: 0,
      },
      candles: [],
    };
  }
  const outcome = computeTripleBarrierOutcome({
    candles,
    blockedAt,
    entryPrice: trigger.target_price,
    takeProfit: trigger.take_profit,
    stopLoss: trigger.stop_loss,
    timeBarrierBars: options.timeBarrierBars || TIME_BARRIER_BARS,
    timeframe,
  });
  if (outcome.status === 'missing_ohlcv_after_block' && exchange === 'binance') {
    const marketStatus = await getBinanceMarketStatus(trigger.symbol);
    if (marketStatus !== 'active') {
      outcome.skipped = true;
      outcome.status = marketStatus === 'inactive'
        ? 'skipped_inactive_binance_symbol'
        : 'skipped_missing_binance_symbol';
    }
  }
  if (outcome.status === 'missing_ohlcv_after_block' && exchange === 'kis' && candles.length > 0) {
    outcome.skipped = true;
    outcome.status = 'skipped_no_market_session_within_barrier';
  }
  return {
    trigger,
    outcome,
    candles,
  };
}

async function saveCounterfactual(result) {
  const { trigger, outcome, candles } = result;
  const blockedAt = blockedAtForTrigger(trigger);
  const source = trigger._source || 'entry_triggers';
  const metadata = {
    design: 'LUNA_GUARD_BLOCKED_COUNTERFACTUAL_DESIGN_2026-06-01',
    source,
    sourceId: trigger.source_id || trigger.id,
    reasonSource: source === 'signals'
      ? 'signals.block_meta.tradeDataGuard.blockers'
      : source === 'guard_events'
      ? 'guard_events.reason'
      : 'entry_triggers.trigger_meta.reason',
    strategyFamily: trigger.strategy_family || null,
    strategyRoute: trigger.strategy_route || null,
    signalBlockCode: trigger.block_code || null,
    signalBlockReason: trigger.block_reason || null,
    tradeDataGuard: trigger.trade_data_guard || null,
    guardMetadata: trigger.guard_metadata || null,
    entryPriceSource: safeNumber(trigger.target_price, null) ? 'trigger_target_price' : 'first_ohlcv_close_after_block',
    takeProfitSource: safeNumber(trigger.take_profit, null) ? 'trigger_take_profit' : 'env_pct',
    stopLossSource: safeNumber(trigger.stop_loss, null) ? 'trigger_stop_loss' : 'env_pct',
    tpPct: TP_PCT,
    slPct: SL_PCT,
    timeBarrierBars: TIME_BARRIER_BARS,
    ohlcvRows: Array.isArray(candles) ? candles.length : 0,
    limitation: 'slippage_partial_fill_and_target_price_reach_not_modelled',
  };
  await run(`
    INSERT INTO luna_guard_counterfactual (
      trigger_id, symbol, exchange, reason, blocked_at,
      entry_price, take_profit, stop_loss, time_barrier_at, timeframe,
      bars_evaluated, virtual_label, virtual_return, exit_price, exit_ts,
      exit_reason, ohlcv_status, metadata, computed_at
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15,
      $16, $17, $18::jsonb, NOW()
    )
    ON CONFLICT (trigger_id)
    DO UPDATE SET
      entry_price = EXCLUDED.entry_price,
      take_profit = EXCLUDED.take_profit,
      stop_loss = EXCLUDED.stop_loss,
      time_barrier_at = EXCLUDED.time_barrier_at,
      timeframe = EXCLUDED.timeframe,
      bars_evaluated = EXCLUDED.bars_evaluated,
      virtual_label = EXCLUDED.virtual_label,
      virtual_return = EXCLUDED.virtual_return,
      exit_price = EXCLUDED.exit_price,
      exit_ts = EXCLUDED.exit_ts,
      exit_reason = EXCLUDED.exit_reason,
      ohlcv_status = EXCLUDED.ohlcv_status,
      metadata = EXCLUDED.metadata,
      computed_at = NOW()
  `, [
    trigger.id,
    trigger.symbol,
    trigger.exchange || null,
    trigger.reason || 'unknown',
    blockedAt,
    outcome.entryPrice ?? null,
    outcome.takeProfit ?? null,
    outcome.stopLoss ?? null,
    outcome.timeBarrierAt ?? null,
    TIMEFRAME,
    outcome.barsEvaluated || 0,
    outcome.virtualLabel ?? null,
    outcome.virtualReturn ?? null,
    outcome.exitPrice ?? null,
    outcome.exitTs ?? null,
    outcome.exitReason ?? null,
    outcome.status || 'unknown',
    JSON.stringify(metadata),
  ]);
}

function summarizeComparisonRow(row = {}) {
  const total = Number(row.total || 0);
  const wins = Number(row.wins || 0);
  return { total, wins, posRate: total > 0 ? Number((wins / total).toFixed(6)) : null };
}

async function fetchEnteredComparison() {
  const rows = await query(`
    WITH fired AS (
      SELECT
        id,
        symbol,
        CASE
          WHEN lower(COALESCE(exchange, '')) IN ('kis_domestic', 'kis_overseas') THEN 'kis'
          ELSE lower(COALESCE(exchange, ''))
        END AS exchange_norm,
        fired_at
      FROM entry_triggers
      WHERE trigger_state = 'fired'
        AND fired_at IS NOT NULL
        AND fired_at >= NOW() - INTERVAL '1 day' * $1
    ),
    matched AS (
      SELECT DISTINCT ON (j.trade_id)
        j.trade_id,
        j.pnl_net
      FROM trade_journal j
      JOIN fired f
        ON f.symbol = j.symbol
       AND f.exchange_norm = CASE
          WHEN lower(COALESCE(j.exchange, '')) IN ('kis_domestic', 'kis_overseas') THEN 'kis'
          ELSE lower(COALESCE(j.exchange, ''))
        END
       AND to_timestamp(j.entry_time / 1000.0) >= f.fired_at
       AND to_timestamp(j.entry_time / 1000.0) <= f.fired_at + ($2::int * INTERVAL '1 minute')
      WHERE j.pnl_net IS NOT NULL
        AND j.exit_reason = 'normal_exit'
        AND j.entry_time IS NOT NULL
      ORDER BY
        j.trade_id,
        ABS(EXTRACT(EPOCH FROM (to_timestamp(j.entry_time / 1000.0) - f.fired_at)))
    )
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE pnl_net > 0)::int AS wins
    FROM matched
  `, [ENTERED_COMPARE_DAYS, ENTERED_MATCH_WINDOW_MINUTES]).catch(() => []);
  return {
    ...summarizeComparisonRow(rows?.[0] || {}),
    basis: 'fired_entry_triggers_matched_to_trade_journal',
    matchWindowMinutes: ENTERED_MATCH_WINDOW_MINUTES,
  };
}

async function fetchAllTradeComparison() {
  const rows = await query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE pnl_net > 0)::int AS wins
    FROM trade_journal
    WHERE pnl_net IS NOT NULL
      AND exit_reason = 'normal_exit'
      AND to_timestamp(entry_time / 1000.0) >= NOW() - INTERVAL '1 day' * $1
  `, [ENTERED_COMPARE_DAYS]).catch(() => []);
  return {
    ...summarizeComparisonRow(rows?.[0] || {}),
    basis: 'all_normal_exit_trade_journal',
  };
}

function summarize(results) {
  const computed = results.filter((item) => item.outcome?.ok);
  const skipped = results.filter((item) => item.outcome?.skipped);
  const total = computed.length;
  const pos = computed.filter((item) => item.outcome.virtualLabel === 1).length;
  const neg = computed.filter((item) => item.outcome.virtualLabel === -1).length;
  const neutral = computed.filter((item) => item.outcome.virtualLabel === 0).length;
  const byReason = {};
  const byStrategyFamily = {};
  const bySource = {};
  function bump(bucket, key, item) {
    const group = key || 'unknown';
    bucket[group] ||= {
      total: 0,
      pos: 0,
      neg: 0,
      neutral: 0,
      posRate: null,
      avgVirtualReturn: null,
      _returnSum: 0,
      _returnCount: 0,
    };
    const stat = bucket[group];
    stat.total++;
    if (item.outcome.virtualLabel === 1) stat.pos++;
    else if (item.outcome.virtualLabel === -1) stat.neg++;
    else stat.neutral++;
    if (Number.isFinite(Number(item.outcome.virtualReturn))) {
      stat._returnSum += Number(item.outcome.virtualReturn);
      stat._returnCount++;
    }
  }
  for (const item of computed) {
    bump(byReason, item.trigger.reason || 'unknown', item);
    bump(byStrategyFamily, item.trigger.strategy_family || item.trigger.trade_data_guard?.meta?.strategyFamily || 'unknown', item);
    bump(bySource, item.trigger._source || 'entry_triggers', item);
  }
  for (const stat of [...Object.values(byReason), ...Object.values(byStrategyFamily), ...Object.values(bySource)]) {
    stat.posRate = stat.total > 0 ? Number((stat.pos / stat.total).toFixed(6)) : null;
    stat.avgVirtualReturn = stat._returnCount > 0 ? Number((stat._returnSum / stat._returnCount).toFixed(8)) : null;
    delete stat._returnSum;
    delete stat._returnCount;
  }
  return {
    total,
    pos,
    neg,
    neutral,
    skipped: skipped.length,
    posRate: total > 0 ? Number((pos / total).toFixed(6)) : null,
    byReason,
    byStrategyFamily,
    bySource,
  };
}

export async function runGuardCounterfactual(options = {}) {
  const dryRun = options.dryRun === true || process.argv.includes('--dry-run');
  const json = options.json === true || process.argv.includes('--json');
  const enabled = options.enabled ?? ENABLED;
  if (!enabled) {
    return { ok: true, enabled: false, dryRun, skipped: true, reason: 'LUNA_GUARD_COUNTERFACTUAL_ENABLED=false' };
  }
  if (!dryRun) await ensureTable();
  const limit = Number(options.limit || BATCH_LIMIT);
  const source = options.source || DEFAULT_SOURCE_MODE;
  const triggers = options.triggers || await loadCounterfactualSources({ limit, source });
  const guardEvents = options.guardEvents !== undefined ? (options.guardEvents || []) : [];
  const allTriggers = [...triggers, ...(Array.isArray(guardEvents) ? guardEvents : [])];
  const results = [];
  for (const trigger of allTriggers) {
    const result = await computeForTrigger(trigger, options);
    results.push(result);
    if (!dryRun) {
      await saveCounterfactual(result);
    }
  }
  const enteredComparison = options.enteredComparison || await fetchEnteredComparison();
  const allTradeComparison = options.allTradeComparison || await fetchAllTradeComparison();
  const summary = summarize(results);
  return {
    ok: true,
    enabled: true,
    dryRun,
    source,
    reasons: REASONS,
    tradeDataReasons: TRADE_DATA_REASONS,
    timeframe: TIMEFRAME,
    timeBarrierBars: TIME_BARRIER_BARS,
    processed: results.length,
    computed: summary.total,
    skipped: summary.skipped,
    failed: results.length - summary.total - summary.skipped,
    summary,
    enteredComparison,
    allTradeComparison,
    interpretation: summary.posRate == null || enteredComparison.posRate == null
      ? 'insufficient_comparison_data'
      : summary.posRate + POS_RATE_EPS < enteredComparison.posRate
        ? 'guard_likely_helpful_blocked_pos_rate_lower'
      : 'guard_may_be_overblocking_blocked_pos_rate_not_lower',
    samples: results.slice(0, 10).map((item) => ({
      triggerId: item.trigger.id,
      source: item.trigger._source || 'entry_triggers',
      symbol: item.trigger.symbol,
      reason: item.trigger.reason,
      strategyFamily: item.trigger.strategy_family || item.trigger.trade_data_guard?.meta?.strategyFamily || null,
      status: item.outcome.status,
      label: item.outcome.virtualLabel,
      virtualReturn: item.outcome.virtualReturn,
      exitReason: item.outcome.exitReason,
      bars: item.outcome.barsEvaluated,
    })),
    failedSamples: results
      .filter((item) => !item.outcome?.ok && !item.outcome?.skipped)
      .slice(0, 10)
      .map((item) => ({
        triggerId: item.trigger.id,
        source: item.trigger._source || 'entry_triggers',
        symbol: item.trigger.symbol,
        reason: item.trigger.reason,
        strategyFamily: item.trigger.strategy_family || item.trigger.trade_data_guard?.meta?.strategyFamily || null,
        status: item.outcome.status,
        bars: item.outcome.barsEvaluated,
        timeBarrierAt: item.outcome.timeBarrierAt || null,
      })),
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => {
      const args = process.argv.slice(2);
      const limitArg = args.find((arg) => arg.startsWith('--limit='))?.split('=')[1];
      const sourceArg = args.find((arg) => arg.startsWith('--source='))?.split('=')[1];
      return runGuardCounterfactual({
        dryRun: args.includes('--dry-run'),
        json: args.includes('--json'),
        limit: limitArg ? Number(limitArg) : BATCH_LIMIT,
        source: sourceArg || DEFAULT_SOURCE_MODE,
      });
    },
    onSuccess: async (result) => {
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`[guard-counterfactual] processed=${result.processed || 0} computed=${result.computed || 0} dryRun=${result.dryRun}`);
    },
  });
}
