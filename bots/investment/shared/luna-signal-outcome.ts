// @ts-nocheck

import * as db from './db.ts';
import {
  normalizePhaseAMarket,
  normalizePhaseASymbol,
} from './luna-phase-a-market-data.ts';

export const LUNA_SIGNAL_OUTCOME_CONFIRM = 'luna-signal-outcome-eval-shadow';
export const LUNA_SIGNAL_OUTCOME_DEFAULT_MAX_BARS = 20;
export const LUNA_SIGNAL_OUTCOME_MIN_SAMPLE = 30;

function finite(value: any, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value: any, digits = 6) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(digits)) : null;
}

function parseTimeMs(value: any) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return value > 1_000_000_000_000 ? value : value * 1000;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim().match(/^\d+$/)) {
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function dayKey(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

function envMaxBars(options: any = {}) {
  const env = { ...(process.env || {}), ...(options.env || {}) };
  const parsed = Number(options.maxBars || env.LUNA_SIGNAL_OUTCOME_MAX_BARS || LUNA_SIGNAL_OUTCOME_DEFAULT_MAX_BARS);
  const candidate = Number.isFinite(parsed) ? parsed : LUNA_SIGNAL_OUTCOME_DEFAULT_MAX_BARS;
  return Math.max(1, Math.min(365, candidate));
}

export function normalizeSignalForOutcome(signal: any = {}) {
  const regime = typeof signal.regime === 'string'
    ? (() => {
        try { return JSON.parse(signal.regime); } catch { return {}; }
      })()
    : signal.regime || {};
  return {
    id: signal.id ?? signal.signal_id ?? signal.signalId ?? null,
    family: signal.family || signal.strategy_family || signal.strategyFamily || 'unknown',
    regimeDominant: signal.regime_dominant || signal.regimeDominant || regime?.dominant || signal.market_regime || null,
    market: normalizePhaseAMarket(signal.market || 'domestic'),
    symbol: normalizePhaseASymbol(signal.symbol || '', signal.market || 'domestic'),
    candleTs: signal.candle_ts || signal.candleTs || signal.timestamp || null,
    entryPrice: finite(signal.entry_price ?? signal.entryPrice ?? signal.price),
    targetPrice: finite(signal.target_price ?? signal.targetPrice ?? signal.target),
    stopPrice: finite(signal.stop_price ?? signal.stopPrice ?? signal.stop),
    rrPlanned: finite(signal.rr_planned ?? signal.rrPlanned ?? signal.rr),
  };
}

function rMultiple(price: any, entry: number, stop: number) {
  const p = finite(price);
  const risk = entry - stop;
  if (p == null || !Number.isFinite(risk) || risk <= 0) return null;
  return round((p - entry) / risk, 6);
}

function pnlPct(price: any, entry: number) {
  const p = finite(price);
  if (p == null || !Number.isFinite(entry) || entry <= 0) return null;
  return round(((p - entry) / entry) * 100, 6);
}

function normalizeOutcomeBars(rows: any[] = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const rawTimestamp = Array.isArray(row) ? row[0] : row?.timestamp ?? row?.candle_ts ?? row?.time;
      return {
        timestamp: rawTimestamp,
        tsMs: parseTimeMs(rawTimestamp),
        open: finite(Array.isArray(row) ? row[1] : row?.open ?? row?.o ?? row?.close),
        high: finite(Array.isArray(row) ? row[2] : row?.high ?? row?.h ?? row?.close),
        low: finite(Array.isArray(row) ? row[3] : row?.low ?? row?.l ?? row?.close),
        close: finite(Array.isArray(row) ? row[4] : row?.close ?? row?.c ?? row?.price),
        volume: finite(Array.isArray(row) ? row[5] : row?.volume ?? row?.v ?? 0, 0),
      };
    })
    .filter((bar) => bar.tsMs != null && Number.isFinite(bar.tsMs) && bar.close > 0 && bar.high > 0 && bar.low > 0)
    .sort((a, b) => a.tsMs - b.tsMs);
}

function outcomeRow(signal: any, partial: any) {
  const normalized = normalizeSignalForOutcome(signal);
  return {
    signalId: normalized.id,
    family: normalized.family,
    regimeDominant: normalized.regimeDominant,
    market: normalized.market,
    symbol: normalized.symbol,
    candleTs: normalized.candleTs,
    entryPrice: normalized.entryPrice,
    targetPrice: normalized.targetPrice,
    stopPrice: normalized.stopPrice,
    rrPlanned: normalized.rrPlanned,
    shadowOnly: true,
    liveMutation: false,
    ...partial,
  };
}

export function evaluateSignalOutcome(signal: any, barsInput: any[] = [], options: any = {}) {
  const normalized = normalizeSignalForOutcome(signal);
  const maxBars = envMaxBars(options);
  const signalMs = parseTimeMs(normalized.candleTs);
  if (!normalized.id && options.requireSignalId === true) throw new Error('signal_outcome_missing_signal_id');
  if (!normalized.symbol) throw new Error('signal_outcome_missing_symbol');
  if (signalMs == null) throw new Error('signal_outcome_missing_candle_ts');
  if (![normalized.entryPrice, normalized.targetPrice, normalized.stopPrice].every((value) => Number.isFinite(value))) {
    throw new Error('signal_outcome_missing_planned_prices');
  }

  const entry = normalized.entryPrice;
  const target = normalized.targetPrice;
  const stop = normalized.stopPrice;
  const rrPlanned = normalized.rrPlanned ?? rMultiple(target, entry, stop);
  const bars = normalizeOutcomeBars(barsInput)
    .filter((bar) => bar.tsMs != null && bar.tsMs > signalMs && dayKey(bar.tsMs) !== dayKey(signalMs))
    .sort((a, b) => a.tsMs - b.tsMs);

  const evaluatedBars = bars.slice(0, maxBars);
  let lastPrice = null;
  for (let index = 0; index < evaluatedBars.length; index += 1) {
    const bar = evaluatedBars[index];
    lastPrice = finite(bar.close, lastPrice);
    const hitTarget = Number(bar.high) >= target;
    const hitStop = Number(bar.low) <= stop;
    if (hitStop) {
      return outcomeRow(normalized, {
        outcome: 'loss',
        exitReason: 'stop_hit',
        realizedR: -1,
        realizedPnlPct: pnlPct(stop, entry),
        barsEvaluated: index + 1,
        lastPrice: round(stop, 6),
        maxBars,
      });
    }
    if (hitTarget) {
      return outcomeRow(normalized, {
        outcome: 'win',
        exitReason: 'target_hit',
        realizedR: round(rrPlanned, 6),
        realizedPnlPct: pnlPct(target, entry),
        barsEvaluated: index + 1,
        lastPrice: round(target, 6),
        maxBars,
      });
    }
  }

  const basisPrice = lastPrice ?? entry;
  const expired = evaluatedBars.length >= maxBars;
  return outcomeRow(normalized, {
    outcome: expired ? 'expired' : 'open',
    exitReason: expired ? 'time_expired' : 'still_open',
    realizedR: rMultiple(basisPrice, entry, stop),
    realizedPnlPct: pnlPct(basisPrice, entry),
    barsEvaluated: evaluatedBars.length,
    lastPrice: round(basisPrice, 6),
    maxBars,
  });
}

export function buildSignalOutcomeSummary(rows: any[] = [], options: any = {}) {
  const minSample = Math.max(1, Number(options.minSample || LUNA_SIGNAL_OUTCOME_MIN_SAMPLE));
  const groups = new Map();
  for (const row of rows || []) {
    const family = row.family || 'unknown';
    const regime = row.regime_dominant || row.regimeDominant || 'unknown';
    const key = `${family}:${regime}`;
    if (!groups.has(key)) {
      groups.set(key, {
        family,
        regimeDominant: regime,
        n: 0,
        win: 0,
        loss: 0,
        expired: 0,
        open: 0,
        realizedRSum: 0,
        realizedRCount: 0,
      });
    }
    const group = groups.get(key);
    const outcome = row.outcome || 'open';
    group.n += 1;
    if (['win', 'loss', 'expired', 'open'].includes(outcome)) group[outcome] += 1;
    const r = finite(row.realized_r ?? row.realizedR);
    if (r != null) {
      group.realizedRSum += r;
      group.realizedRCount += 1;
    }
  }

  const summary = Array.from(groups.values()).map((group) => {
    const sumR = round(group.realizedRSum, 6) ?? 0;
    const avgR = group.realizedRCount > 0 ? round(group.realizedRSum / group.realizedRCount, 6) : null;
    const winRate = group.n > 0 ? round(group.win / group.n, 6) : null;
    if (group.n < minSample) {
      return {
        ...group,
        sumR,
        avgRealizedR: null,
        winRate: null,
        provisionalAvgRealizedR: avgR,
        provisionalWinRate: winRate,
        insufficientSample: `${group.n}/${minSample}`,
      };
    }
    return {
      ...group,
      sumR,
      avgRealizedR: avgR,
      winRate,
      insufficientSample: null,
    };
  });

  return {
    ok: true,
    minSample,
    groups: summary.sort((a, b) => a.family.localeCompare(b.family) || a.regimeDominant.localeCompare(b.regimeDominant)),
  };
}

export async function ensureSignalOutcomeSchema(runFn = db.run, migrationSql: string | null = null) {
  if (migrationSql) return runFn(migrationSql);
  return runFn(`
    CREATE TABLE IF NOT EXISTS luna_strategy_signal_outcomes (
      id BIGSERIAL PRIMARY KEY,
      signal_id BIGINT NOT NULL UNIQUE,
      family TEXT NOT NULL,
      regime_dominant TEXT,
      market TEXT NOT NULL,
      symbol TEXT NOT NULL,
      candle_ts TIMESTAMPTZ NOT NULL,
      entry_price NUMERIC,
      target_price NUMERIC,
      stop_price NUMERIC,
      rr_planned NUMERIC,
      outcome TEXT NOT NULL,
      exit_reason TEXT NOT NULL,
      realized_r NUMERIC,
      realized_pnl_pct NUMERIC,
      bars_evaluated INTEGER NOT NULL DEFAULT 0,
      last_price NUMERIC,
      evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      shadow_only BOOLEAN NOT NULL DEFAULT TRUE
    )
  `);
}

export async function upsertSignalOutcome(row: any, runFn = db.run) {
  return runFn(
    `INSERT INTO luna_strategy_signal_outcomes
       (signal_id, family, regime_dominant, market, symbol, candle_ts,
        entry_price, target_price, stop_price, rr_planned,
        outcome, exit_reason, realized_r, realized_pnl_pct,
        bars_evaluated, last_price, shadow_only)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,TRUE)
     ON CONFLICT (signal_id) DO UPDATE SET
       family = EXCLUDED.family,
       regime_dominant = EXCLUDED.regime_dominant,
       market = EXCLUDED.market,
       symbol = EXCLUDED.symbol,
       candle_ts = EXCLUDED.candle_ts,
       entry_price = EXCLUDED.entry_price,
       target_price = EXCLUDED.target_price,
       stop_price = EXCLUDED.stop_price,
       rr_planned = EXCLUDED.rr_planned,
       outcome = EXCLUDED.outcome,
       exit_reason = EXCLUDED.exit_reason,
       realized_r = EXCLUDED.realized_r,
       realized_pnl_pct = EXCLUDED.realized_pnl_pct,
       bars_evaluated = EXCLUDED.bars_evaluated,
       last_price = EXCLUDED.last_price,
       evaluated_at = NOW(),
       shadow_only = TRUE
     RETURNING id`,
    [
      row.signalId,
      row.family,
      row.regimeDominant,
      normalizePhaseAMarket(row.market),
      normalizePhaseASymbol(row.symbol, row.market),
      row.candleTs,
      row.entryPrice,
      row.targetPrice,
      row.stopPrice,
      row.rrPlanned,
      row.outcome,
      row.exitReason,
      row.realizedR,
      row.realizedPnlPct,
      row.barsEvaluated,
      row.lastPrice,
    ],
  );
}

export default {
  LUNA_SIGNAL_OUTCOME_CONFIRM,
  LUNA_SIGNAL_OUTCOME_DEFAULT_MAX_BARS,
  LUNA_SIGNAL_OUTCOME_MIN_SAMPLE,
  normalizeSignalForOutcome,
  normalizeOutcomeBars,
  evaluateSignalOutcome,
  buildSignalOutcomeSummary,
  ensureSignalOutcomeSchema,
  upsertSignalOutcome,
};
