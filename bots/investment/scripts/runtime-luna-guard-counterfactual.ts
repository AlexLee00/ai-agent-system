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
const BATCH_LIMIT = Math.max(1, Number(process.env.LUNA_GUARD_COUNTERFACTUAL_BATCH_LIMIT || 100));
const TIMEFRAME = String(process.env.LUNA_GUARD_COUNTERFACTUAL_TIMEFRAME || '1h').trim();
const TIME_BARRIER_BARS = Math.max(1, Number(process.env.LUNA_GUARD_COUNTERFACTUAL_TIME_BARRIER_BARS || 24));
const TP_PCT = Math.max(0.0001, Number(process.env.LUNA_GUARD_COUNTERFACTUAL_TP_PCT || 0.03));
const SL_PCT = Math.max(0.0001, Number(process.env.LUNA_GUARD_COUNTERFACTUAL_SL_PCT || 0.02));
const LOOKBACK_DAYS = Math.max(1, Number(process.env.LUNA_GUARD_COUNTERFACTUAL_LOOKBACK_DAYS || 30));
const ENTERED_COMPARE_DAYS = Math.max(1, Number(process.env.LUNA_GUARD_COUNTERFACTUAL_COMPARE_DAYS || 30));
const ENTERED_MATCH_WINDOW_MINUTES = Math.max(1, Number(process.env.LUNA_GUARD_COUNTERFACTUAL_MATCH_WINDOW_MINUTES || 120));
const POS_RATE_EPS = Math.max(0, Number(process.env.LUNA_GUARD_COUNTERFACTUAL_POS_RATE_EPS || 0));

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
  const rows = Array.isArray(candles)
    ? candles.filter((row) => candleTs(row) >= start.getTime()).sort((a, b) => candleTs(a) - candleTs(b))
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
  const barrierAt = addMs(start, timeframeMs(timeframe) * Math.max(1, Number(timeBarrierBars || 1)));

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
    WHERE cf.trigger_id IS NULL
      AND t.trigger_state = 'expired'
      AND COALESCE(t.trigger_meta->>'reason', '') = ANY($1::text[])
      AND COALESCE(t.updated_at, t.created_at) >= NOW() - INTERVAL '1 day' * $2
    ORDER BY COALESCE(t.updated_at, t.created_at) ASC
    LIMIT $3
  `, [REASONS, LOOKBACK_DAYS, limit]).catch(() => []);
  return rows || [];
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
  const candles = options.candles || await getOHLCV(trigger.symbol, timeframe, from, to, marketForExchange(exchange)).catch((error) => {
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
  return {
    trigger,
    outcome: computeTripleBarrierOutcome({
      candles,
      blockedAt,
      entryPrice: trigger.target_price,
      takeProfit: trigger.take_profit,
      stopLoss: trigger.stop_loss,
      timeBarrierBars: options.timeBarrierBars || TIME_BARRIER_BARS,
      timeframe,
    }),
    candles,
  };
}

async function saveCounterfactual(result) {
  const { trigger, outcome, candles } = result;
  const blockedAt = blockedAtForTrigger(trigger);
  const metadata = {
    design: 'LUNA_GUARD_BLOCKED_COUNTERFACTUAL_DESIGN_2026-06-01',
    reasonSource: 'entry_triggers.trigger_meta.reason',
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
  const total = computed.length;
  const pos = computed.filter((item) => item.outcome.virtualLabel === 1).length;
  const neg = computed.filter((item) => item.outcome.virtualLabel === -1).length;
  const neutral = computed.filter((item) => item.outcome.virtualLabel === 0).length;
  const byReason = {};
  for (const item of computed) {
    const reason = item.trigger.reason || 'unknown';
    byReason[reason] ||= { total: 0, pos: 0, neg: 0, neutral: 0, posRate: null };
    byReason[reason].total++;
    if (item.outcome.virtualLabel === 1) byReason[reason].pos++;
    else if (item.outcome.virtualLabel === -1) byReason[reason].neg++;
    else byReason[reason].neutral++;
  }
  for (const stat of Object.values(byReason)) {
    stat.posRate = stat.total > 0 ? Number((stat.pos / stat.total).toFixed(6)) : null;
  }
  return {
    total,
    pos,
    neg,
    neutral,
    posRate: total > 0 ? Number((pos / total).toFixed(6)) : null,
    byReason,
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
  const triggers = options.triggers || await loadBlockedTriggers(limit);
  const results = [];
  for (const trigger of triggers) {
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
    reasons: REASONS,
    timeframe: TIMEFRAME,
    timeBarrierBars: TIME_BARRIER_BARS,
    processed: results.length,
    computed: summary.total,
    failed: results.length - summary.total,
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
      symbol: item.trigger.symbol,
      reason: item.trigger.reason,
      status: item.outcome.status,
      label: item.outcome.virtualLabel,
      virtualReturn: item.outcome.virtualReturn,
      exitReason: item.outcome.exitReason,
      bars: item.outcome.barsEvaluated,
    })),
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => {
      const args = process.argv.slice(2);
      const limitArg = args.find((arg) => arg.startsWith('--limit='))?.split('=')[1];
      return runGuardCounterfactual({
        dryRun: args.includes('--dry-run'),
        json: args.includes('--json'),
        limit: limitArg ? Number(limitArg) : BATCH_LIMIT,
      });
    },
    onSuccess: async (result) => {
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`[guard-counterfactual] processed=${result.processed || 0} computed=${result.computed || 0} dryRun=${result.dryRun}`);
    },
  });
}
