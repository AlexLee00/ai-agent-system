// @ts-nocheck

import * as db from './db.ts';
import { getParameter } from './luna-parameter-store.ts';
import { normalizePhaseAMarket, normalizePhaseASymbol } from './luna-phase-a-market-data.ts';

export const LUNA_CIRCUIT_PARAM_KEYS = Object.freeze({
  lookbackMin: 'c4.circuit_lookback_min',
  tradeLimit: 'c4.circuit_trade_limit',
  stopDurationMin: 'c4.circuit_stop_duration_min',
  symbolCooldownCandles: 'c4.symbol_cooldown_candles',
  lowProfitLookbackDays: 'c4.low_profit_lookback_days',
});

export const LUNA_CIRCUIT_DEFAULTS = Object.freeze({
  lookbackMin: 1440,
  tradeLimit: 4,
  stopDurationMin: 1440,
  symbolCooldownCandles: 2,
  lowProfitLookbackDays: 14,
  candleMinutes: 1440,
});

export const LUNA_CIRCUIT_SCHEMA_SQL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS investment.luna_circuit_locks (
     id           BIGSERIAL PRIMARY KEY,
     market       TEXT NOT NULL,
     symbol       TEXT,
     side         TEXT,
     level        TEXT NOT NULL CHECK (level IN ('market', 'symbol', 'side')),
     circuit      TEXT NOT NULL,
     locked       BOOLEAN NOT NULL DEFAULT FALSE,
     reason       TEXT,
     evidence     JSONB NOT NULL DEFAULT '{}'::jsonb,
     lock_until   TIMESTAMPTZ,
     evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     shadow_only  BOOLEAN NOT NULL DEFAULT TRUE
   )`,
  `CREATE INDEX IF NOT EXISTS idx_luna_circuit_locks_market_time
     ON investment.luna_circuit_locks(market, evaluated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_luna_circuit_locks_symbol_time
     ON investment.luna_circuit_locks(symbol, evaluated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_luna_circuit_locks_circuit_time
     ON investment.luna_circuit_locks(circuit, evaluated_at DESC)`,
]);

function finite(value: any, fallback = null) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value: any, digits = 6) {
  const n = finite(value, null);
  return n == null ? null : Number(n.toFixed(digits));
}

function timestampMs(value: any) {
  const n = finite(value, null);
  if (n != null) return n > 1_000_000_000_000 ? n : n * 1000;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

async function parameterNumber(key: string, fallback: number, options: any = {}, deps: any = {}) {
  if (options.parameters && Object.prototype.hasOwnProperty.call(options.parameters, key)) {
    return finite(options.parameters[key], fallback);
  }
  try {
    const row = await (deps.getParameter || getParameter)(key, 'global', {
      bypassCache: options.bypassParameterCache === true,
      env: options.env || process.env,
      queryFn: deps.queryFn || options.queryFn || db.query,
    });
    return finite(row?.value, fallback);
  } catch {
    return fallback;
  }
}

export async function loadLossCircuitParameters(options: any = {}, deps: any = {}) {
  return {
    lookbackMin: await parameterNumber(LUNA_CIRCUIT_PARAM_KEYS.lookbackMin, LUNA_CIRCUIT_DEFAULTS.lookbackMin, options, deps),
    tradeLimit: await parameterNumber(LUNA_CIRCUIT_PARAM_KEYS.tradeLimit, LUNA_CIRCUIT_DEFAULTS.tradeLimit, options, deps),
    stopDurationMin: await parameterNumber(LUNA_CIRCUIT_PARAM_KEYS.stopDurationMin, LUNA_CIRCUIT_DEFAULTS.stopDurationMin, options, deps),
    symbolCooldownCandles: await parameterNumber(
      LUNA_CIRCUIT_PARAM_KEYS.symbolCooldownCandles,
      LUNA_CIRCUIT_DEFAULTS.symbolCooldownCandles,
      options,
      deps,
    ),
    lowProfitLookbackDays: await parameterNumber(
      LUNA_CIRCUIT_PARAM_KEYS.lowProfitLookbackDays,
      LUNA_CIRCUIT_DEFAULTS.lowProfitLookbackDays,
      options,
      deps,
    ),
    candleMinutes: finite(options.candleMinutes, LUNA_CIRCUIT_DEFAULTS.candleMinutes),
  };
}

function normalizeTrade(row: any = {}) {
  const market = normalizePhaseAMarket(row.market || row.exchange || (String(row.symbol || '').includes('/') ? 'crypto' : 'domestic'));
  const pnl = finite(row.pnl_net ?? row.pnl_amount, finite(row.pnl_percent, 0));
  const side = String(row.direction || row.side || 'long').trim().toLowerCase() || 'long';
  const exitReason = String(row.exit_reason || row.exitReason || '').toLowerCase();
  return {
    id: row.id || row.trade_id || null,
    market,
    symbol: normalizePhaseASymbol(row.symbol || '', market),
    side,
    exitReason,
    exitTimeMs: timestampMs(row.exit_time ?? row.exitTime ?? row.closed_at ?? row.closedAt),
    entryPrice: finite(row.entry_price ?? row.entryPrice, null),
    exitPrice: finite(row.exit_price ?? row.exitPrice, null),
    stopPrice: finite(row.sl_price ?? row.stop ?? row.stop_loss ?? row.stopLoss, null),
    pnlPercent: finite(row.pnl_percent ?? row.pnlPercent, null),
    pnl,
    raw: row,
  };
}

export function tradeRMultiple(row: any = {}) {
  const trade = normalizeTrade(row);
  if (trade.entryPrice != null && trade.exitPrice != null && trade.stopPrice != null && trade.entryPrice > trade.stopPrice) {
    return (trade.exitPrice - trade.entryPrice) / (trade.entryPrice - trade.stopPrice);
  }
  if (trade.pnlPercent != null) return trade.pnlPercent / 100;
  return null;
}

export function isStopLikeTrade(row: any = {}) {
  const trade = normalizeTrade(row);
  const reason = trade.exitReason;
  if (/stop|sl|loss|liquid/.test(reason)) return true;
  if (/force_exit/.test(reason) && Number(trade.pnl || 0) < 0) return true;
  return false;
}

async function loadTrades(options: any = {}, deps: any = {}, params: any = {}) {
  if (Array.isArray(options.trades)) return options.trades.map(normalizeTrade).filter((row) => row.symbol && row.exitTimeMs);
  const nowMs = timestampMs(options.now || Date.now()) || Date.now();
  const lowProfitMs = Number(params.lowProfitLookbackDays || 14) * 24 * 60 * 60 * 1000;
  const stopGuardMs = Number(params.lookbackMin || 1440) * 60 * 1000;
  const sinceMs = nowMs - Math.max(lowProfitMs, stopGuardMs);
  const sinceSec = Math.floor(sinceMs / 1000);
  const rows = await (deps.queryFn || options.queryFn || db.query)(
    `SELECT id, market, exchange, symbol, direction, exit_reason, entry_time, exit_time,
            entry_price, exit_price, sl_price, pnl_percent, pnl_amount, pnl_net,
            quality_flag, exclude_from_learning
       FROM trade_journal
      WHERE exit_time IS NOT NULL
        AND COALESCE(exclude_from_learning, false) = false
        AND COALESCE(quality_flag, 'trusted') <> 'exclude_from_learning'
        AND (exit_time >= $1 OR exit_time >= $2)
      ORDER BY exit_time DESC
      LIMIT 5000`,
    [sinceMs, sinceSec],
  ).catch(() => []);
  return (rows || []).map(normalizeTrade).filter((row) => row.symbol && row.exitTimeMs);
}

function lockRow({ market, symbol = null, side = null, level, circuit, reason, evidence, lockUntil, evaluatedAt }) {
  return {
    market: normalizePhaseAMarket(market),
    symbol,
    side,
    level,
    circuit,
    locked: true,
    reason,
    evidence,
    lockUntil: lockUntil ? new Date(lockUntil).toISOString() : null,
    evaluatedAt,
    shadowOnly: true,
    liveMutation: false,
  };
}

function groupBy(rows = [], keyFn: any) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function buildStoplossGuardLocks(trades = [], params: any, nowMs: number, evaluatedAt: string) {
  const since = nowMs - Number(params.lookbackMin) * 60 * 1000;
  const stopRows = trades.filter((row) => row.exitTimeMs >= since && isStopLikeTrade(row));
  const lockUntil = nowMs + Number(params.stopDurationMin) * 60 * 1000;
  const limit = Number(params.tradeLimit);
  const locks = [];
  const specs = [
    { level: 'market', groups: groupBy(stopRows, (row) => row.market) },
    { level: 'symbol', groups: groupBy(stopRows, (row) => `${row.market}:${row.symbol}`) },
    { level: 'side', groups: groupBy(stopRows, (row) => `${row.market}:${row.side || 'long'}`) },
  ];
  for (const spec of specs) {
    for (const [key, rows] of spec.groups.entries()) {
      if (rows.length < limit) continue;
      const [market, value] = key.split(':');
      locks.push(lockRow({
        market,
        symbol: spec.level === 'symbol' ? value : null,
        side: spec.level === 'side' ? value : null,
        level: spec.level,
        circuit: 'stoploss_guard',
        reason: `stoploss_like_count_${rows.length}_gte_${limit}`,
        lockUntil,
        evaluatedAt,
        evidence: {
          lookbackMin: Number(params.lookbackMin),
          tradeLimit: limit,
          stopDurationMin: Number(params.stopDurationMin),
          count: rows.length,
          source: 'investment.trade_journal',
        },
      }));
    }
  }
  return locks;
}

function buildCooldownLocks(trades = [], params: any, nowMs: number, evaluatedAt: string) {
  const latestBySymbol = new Map();
  for (const row of trades) {
    const key = `${row.market}:${row.symbol}`;
    const current = latestBySymbol.get(key);
    if (!current || row.exitTimeMs > current.exitTimeMs) latestBySymbol.set(key, row);
  }
  const durationMs = Number(params.symbolCooldownCandles) * Number(params.candleMinutes) * 60 * 1000;
  const locks = [];
  for (const row of latestBySymbol.values()) {
    const lockUntil = row.exitTimeMs + durationMs;
    if (lockUntil <= nowMs) continue;
    locks.push(lockRow({
      market: row.market,
      symbol: row.symbol,
      level: 'symbol',
      circuit: 'symbol_cooldown',
      reason: `within_${params.symbolCooldownCandles}_candle_cooldown`,
      lockUntil,
      evaluatedAt,
      evidence: {
        symbolCooldownCandles: Number(params.symbolCooldownCandles),
        lastExitTime: new Date(row.exitTimeMs).toISOString(),
        source: 'investment.trade_journal',
      },
    }));
  }
  return locks;
}

function buildLowProfitLocks(trades = [], params: any, nowMs: number, evaluatedAt: string) {
  const since = nowMs - Number(params.lowProfitLookbackDays) * 24 * 60 * 60 * 1000;
  const rows = trades.filter((row) => row.exitTimeMs >= since);
  const groups = groupBy(rows, (row) => `${row.market}:${row.symbol}`);
  const locks = [];
  for (const [key, groupRows] of groups.entries()) {
    const rValues = groupRows.map(tradeRMultiple).filter((value) => value != null);
    if (rValues.length === 0) continue;
    const cumulativeR = rValues.reduce((sum, value) => sum + Number(value || 0), 0);
    if (cumulativeR >= 0) continue;
    const [market, symbol] = key.split(':');
    locks.push(lockRow({
      market,
      symbol,
      level: 'symbol',
      circuit: 'low_profit_symbol',
      reason: 'cumulative_r_below_zero',
      lockUntil: nowMs + Number(params.stopDurationMin) * 60 * 1000,
      evaluatedAt,
      evidence: {
        lowProfitLookbackDays: Number(params.lowProfitLookbackDays),
        sampleCount: rValues.length,
        cumulativeR: round(cumulativeR, 4),
        source: 'investment.trade_journal',
      },
    }));
  }
  return locks;
}

export async function evaluateLossCircuits(options: any = {}, deps: any = {}) {
  const params = await loadLossCircuitParameters(options, deps);
  const nowMs = timestampMs(options.now || Date.now()) || Date.now();
  const evaluatedAt = new Date(nowMs).toISOString();
  const trades = await loadTrades(options, deps, params);
  const locks = [
    ...buildStoplossGuardLocks(trades, params, nowMs, evaluatedAt),
    ...buildCooldownLocks(trades, params, nowMs, evaluatedAt),
    ...buildLowProfitLocks(trades, params, nowMs, evaluatedAt),
  ];
  const seen = new Set();
  const deduped = locks.filter((lock) => {
    const key = `${lock.market}:${lock.symbol || ''}:${lock.side || ''}:${lock.level}:${lock.circuit}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    locks: deduped,
    tradeCount: trades.length,
    evaluatedAt,
    params,
    source: 'investment.trade_journal',
    shadowOnly: true,
    liveMutation: false,
  };
}

export async function insertCircuitLock(row: any, runFn = db.run) {
  return runFn(
    `INSERT INTO luna_circuit_locks
       (market, symbol, side, level, circuit, locked, reason, evidence, lock_until, evaluated_at, shadow_only)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
     RETURNING id`,
    [
      normalizePhaseAMarket(row.market),
      row.symbol || null,
      row.side || null,
      row.level,
      row.circuit,
      row.locked === true,
      row.reason || null,
      JSON.stringify(row.evidence || {}),
      row.lockUntil || null,
      row.evaluatedAt || new Date().toISOString(),
      row.shadowOnly !== false,
    ],
  );
}

export async function insertCircuitLocks(rows = [], runFn = db.run) {
  const inserted = [];
  for (const row of rows || []) {
    const result = await insertCircuitLock(row, runFn);
    inserted.push(result?.rows?.[0]?.id || null);
  }
  return inserted;
}

export function summarizeCircuitLocks(rows = []) {
  const locked = (rows || []).filter((row) => row.locked === true).length;
  return { locked, line: `서킷: 잠금 ${locked}` };
}

export const _testOnly = {
  normalizeTrade,
  timestampMs,
  isStopLikeTrade,
  tradeRMultiple,
  buildStoplossGuardLocks,
  buildCooldownLocks,
  buildLowProfitLocks,
};

export default {
  evaluateLossCircuits,
  insertCircuitLocks,
  summarizeCircuitLocks,
};
