// @ts-nocheck

import * as db from './db.ts';
import { getParameter } from './luna-parameter-store.ts';
import { computeRegimeState } from './luna-regime-engine.ts';
import {
  fetchPhaseABars,
  normalizePhaseAMarket,
  normalizePhaseASymbol,
} from './luna-phase-a-market-data.ts';
import { DEFAULT_MARKET_SEED_WATCHLIST } from './luna-market-candidate-seed-refresh.ts';

export const LUNA_STRATEGY_SIGNAL_FAMILIES = Object.freeze({
  turtle: 'turtle_breakout',
  testah: 'testah_pullback',
});

export const LUNA_STRATEGY_DEFAULTS = Object.freeze({
  turtle: {
    entryLookback: 20,
    exitLookback: 10,
    atrPeriod: 20,
    atrMult: 2,
    maFilter: 200,
  },
  testah: {
    maFast: 5,
    maMid: 25,
    maSlow: 75,
    pullbackWindow: 5,
  },
  regimeMatch: {
    turtle: ['bull', 'volatile'],
    testah: ['bull'],
  },
  lookbackDays: 320,
  timeframe: '1d',
});

export const LUNA_STRATEGY_PARAM_KEYS = Object.freeze({
  turtle: {
    entryLookback: 'c3.turtle.entry_lookback',
    exitLookback: 'c3.turtle.exit_lookback',
    atrPeriod: 'c3.turtle.atr_period',
    atrMult: 'c3.turtle.atr_mult',
    maFilter: 'c3.turtle.ma_filter',
  },
  testah: {
    maFast: 'c3.testah.ma_fast',
    maMid: 'c3.testah.ma_mid',
    maSlow: 'c3.testah.ma_slow',
    pullbackWindow: 'c3.testah.pullback_window',
  },
  regimeMatch: {
    turtle: 'c3.regime_match.turtle',
    testah: 'c3.regime_match.testah',
  },
});

export const LUNA_STRATEGY_SIGNALS_SCHEMA_SQL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS investment.luna_strategy_signals (
     id           BIGSERIAL PRIMARY KEY,
     market       TEXT NOT NULL,
     symbol       TEXT NOT NULL,
     family       TEXT NOT NULL,
     signal_type  TEXT NOT NULL,
     candle_ts    TIMESTAMPTZ NOT NULL,
     price        NUMERIC,
     stop         NUMERIC,
     target       NUMERIC,
     rr           NUMERIC,
     regime       JSONB NOT NULL DEFAULT '{}'::jsonb,
     matched      BOOLEAN,
     rule_version TEXT NOT NULL DEFAULT 'v1',
     details      JSONB NOT NULL DEFAULT '{}'::jsonb,
     created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_luna_strategy_signals_unique
     ON investment.luna_strategy_signals(symbol, family, candle_ts, signal_type)`,
  `CREATE INDEX IF NOT EXISTS idx_luna_strategy_signals_market_family_time
     ON investment.luna_strategy_signals(market, family, candle_ts DESC)`,
]);

function finite(value: any, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value: any, digits = 6) {
  return Number(finite(value, 0).toFixed(digits));
}

function normalizeBars(bars = []) {
  return (Array.isArray(bars) ? bars : [])
    .map((bar) => ({
      timestamp: bar.timestamp || bar.candle_ts || bar.time || null,
      open: finite(bar.open ?? bar.o ?? bar.close),
      high: finite(bar.high ?? bar.h ?? bar.close),
      low: finite(bar.low ?? bar.l ?? bar.close),
      close: finite(bar.close ?? bar.c ?? bar.price),
      volume: finite(bar.volume ?? bar.v ?? 0),
    }))
    .filter((bar) => bar.timestamp != null && bar.close > 0 && bar.high > 0 && bar.low > 0)
    .sort((a, b) => Date.parse(String(a.timestamp)) - Date.parse(String(b.timestamp)));
}

function candleTs(bar: any) {
  return new Date(bar?.timestamp || Date.now()).toISOString();
}

function parseBarTime(value: any) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === 'number') {
    const ms = value > 1_000_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim().match(/^\d+$/)) {
    const ms = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function kstParts(date: Date) {
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function compareKstDate(a: Date, b: Date) {
  const ap = kstParts(a);
  const bp = kstParts(b);
  const av = ap.year * 10_000 + ap.month * 100 + ap.day;
  const bv = bp.year * 10_000 + bp.month * 100 + bp.day;
  return av === bv ? 0 : av < bv ? -1 : 1;
}

export function isCompletedDailyBar(bar: any, market = 'crypto', now = new Date()) {
  const ts = parseBarTime(bar?.timestamp || bar?.candle_ts || bar?.time);
  const nowDate = parseBarTime(now) || new Date();
  if (!ts || !Number.isFinite(nowDate.getTime())) return false;
  const normalizedMarket = normalizePhaseAMarket(market);
  if (normalizedMarket === 'crypto') {
    return nowDate.getTime() >= ts.getTime() + 24 * 60 * 60 * 1000;
  }

  const dayCompare = compareKstDate(ts, nowDate);
  if (dayCompare < 0) return true;
  if (dayCompare > 0) return false;
  const parts = kstParts(nowDate);
  return parts.hour > 15 || (parts.hour === 15 && parts.minute >= 30);
}

export function dropIncompleteLastBar(barsInput = [], market = 'crypto', now = new Date()) {
  const bars = normalizeBars(barsInput);
  if (bars.length === 0) return bars;
  const last = bars[bars.length - 1];
  if (isCompletedDailyBar(last, market, now)) return bars;
  return bars.slice(0, -1);
}

function rollingMax(values: number[], endExclusive: number, lookback: number) {
  const start = Math.max(0, endExclusive - lookback);
  const window = values.slice(start, endExclusive).filter(Number.isFinite);
  if (window.length < lookback) return null;
  return Math.max(...window);
}

function rollingMin(values: number[], endExclusive: number, lookback: number) {
  const start = Math.max(0, endExclusive - lookback);
  const window = values.slice(start, endExclusive).filter(Number.isFinite);
  if (window.length < lookback) return null;
  return Math.min(...window);
}

function smaAt(values: number[], index: number, period: number) {
  const start = index - period + 1;
  if (start < 0) return null;
  const window = values.slice(start, index + 1).filter(Number.isFinite);
  if (window.length < period) return null;
  return window.reduce((sum, value) => sum + value, 0) / period;
}

function trueRange(bars: any[], index: number) {
  const current = bars[index];
  const prevClose = index > 0 ? finite(bars[index - 1]?.close, current.close) : current.close;
  return Math.max(
    current.high - current.low,
    Math.abs(current.high - prevClose),
    Math.abs(current.low - prevClose),
  );
}

export function wilderAtrAt(barsInput = [], index = null, period = 20) {
  const bars = normalizeBars(barsInput);
  const lastIndex = index == null ? bars.length - 1 : Number(index);
  const p = Math.max(1, Number(period || 20));
  if (bars.length < p || lastIndex < p - 1) return null;
  const trs = bars.map((_, idx) => trueRange(bars, idx));
  let atr = trs.slice(0, p).reduce((sum, value) => sum + value, 0) / p;
  for (let i = p; i <= lastIndex; i += 1) {
    atr = ((atr * (p - 1)) + trs[i]) / p;
  }
  return round(atr, 8);
}

function none(family: string, reason: string, details: any = {}) {
  return {
    family,
    signalType: 'none',
    candleTs: details.candleTs || null,
    price: null,
    stop: null,
    target: null,
    rr: null,
    reason,
    ruleVersion: 'v1',
    details,
  };
}

function signal(family: string, signalType: string, values: any = {}) {
  return {
    family,
    signalType,
    candleTs: values.candleTs,
    price: values.price ?? null,
    stop: values.stop ?? null,
    target: values.target ?? null,
    rr: values.rr ?? null,
    reason: values.reason,
    ruleVersion: 'v1',
    details: values.details || {},
  };
}

function withEntryValidity(result: any) {
  if (result.signalType !== 'entry') return result;
  if (!Number.isFinite(Number(result.price)) || !Number.isFinite(Number(result.stop))) {
    return none(result.family, 'invalid_entry_price_or_stop', { ...result.details, invalidSignal: result });
  }
  if (Number(result.stop) >= Number(result.price)) {
    return none(result.family, 'invalid_stop_not_below_entry', { ...result.details, invalidSignal: result });
  }
  if (!Number.isFinite(Number(result.rr)) || Number(result.rr) < 1) {
    return none(result.family, 'invalid_rr_below_1', { ...result.details, invalidSignal: result });
  }
  return result;
}

function previousSwingHigh(bars: any[], index: number, lookback = 20) {
  return rollingMax(bars.map((bar) => Number(bar.high)), index, Math.max(1, lookback));
}

export function evaluateTurtleBreakout(barsInput = [], params: any = {}) {
  const bars = normalizeBars(barsInput);
  const family = LUNA_STRATEGY_SIGNAL_FAMILIES.turtle;
  const p = { ...LUNA_STRATEGY_DEFAULTS.turtle, ...(params || {}) };
  const idx = bars.length - 1;
  if (idx < 0) return none(family, 'insufficient_bars', { requiredBars: p.maFilter + 1, actualBars: bars.length });
  const highs = bars.map((bar) => Number(bar.high));
  const closes = bars.map((bar) => Number(bar.close));
  const current = bars[idx];
  const ts = candleTs(current);

  if (params.positionOpen === true) {
    const prevExitLow = rollingMin(closes, idx, Number(p.exitLookback));
    if (prevExitLow != null && current.close < prevExitLow) {
      return signal(family, 'exit', {
        candleTs: ts,
        price: round(current.close, 6),
        reason: 'exit_lookback_close_breakdown',
        details: { exitLookback: p.exitLookback, previousLowestClose: round(prevExitLow, 6) },
      });
    }
    return none(family, 'no_exit_breakdown', { candleTs: ts, exitLookback: p.exitLookback });
  }

  const prevHigh = rollingMax(highs, idx, Number(p.entryLookback));
  const prevHighForPrevious = rollingMax(highs, idx - 1, Number(p.entryLookback));
  const ma = smaAt(closes, idx, Number(p.maFilter));
  const atr = wilderAtrAt(bars, idx, Number(p.atrPeriod));
  if (prevHigh == null || ma == null || atr == null || idx < Number(p.maFilter)) {
    return none(family, 'insufficient_bars', {
      candleTs: ts,
      requiredBars: Math.max(Number(p.maFilter), Number(p.entryLookback), Number(p.atrPeriod)) + 1,
      actualBars: bars.length,
    });
  }
  if (current.close <= ma) {
    return none(family, 'ma_filter_not_met', { candleTs: ts, close: current.close, maFilter: p.maFilter, ma: round(ma, 6) });
  }
  if (current.close <= prevHigh) {
    return none(family, 'close_not_breakout', { candleTs: ts, close: current.close, previousHigh: round(prevHigh, 6) });
  }
  if (idx > 0 && prevHighForPrevious != null && closes[idx - 1] > prevHighForPrevious) {
    return none(family, 'not_new_breakout', {
      candleTs: ts,
      previousClose: closes[idx - 1],
      previousHighForPrevious: round(prevHighForPrevious, 6),
    });
  }
  const entry = Number(current.close);
  const stop = entry - Number(p.atrMult) * Number(atr);
  const risk = entry - stop;
  const target = entry + 2 * risk;
  const rr = risk > 0 ? (target - entry) / risk : null;
  return withEntryValidity(signal(family, 'entry', {
    candleTs: ts,
    price: round(entry, 6),
    stop: round(stop, 6),
    target: round(target, 6),
    rr: round(rr, 4),
    reason: 'close_breaks_prior_high_with_ma_filter',
    details: {
      entryLookback: p.entryLookback,
      exitLookback: p.exitLookback,
      atrPeriod: p.atrPeriod,
      atrMult: p.atrMult,
      maFilter: p.maFilter,
      previousHigh: round(prevHigh, 6),
      ma: round(ma, 6),
      atr: round(atr, 6),
      targetAssumption: '2R_when_prior_swing_high_unmeasurable_after_breakout',
    },
  }));
}

export function evaluateTestahPullback(barsInput = [], params: any = {}) {
  const bars = normalizeBars(barsInput);
  const family = LUNA_STRATEGY_SIGNAL_FAMILIES.testah;
  const p = { ...LUNA_STRATEGY_DEFAULTS.testah, ...(params || {}) };
  const idx = bars.length - 1;
  if (idx < 0) return none(family, 'insufficient_bars', { requiredBars: p.maSlow + 1, actualBars: bars.length });
  const closes = bars.map((bar) => Number(bar.close));
  const lows = bars.map((bar) => Number(bar.low));
  const current = bars[idx];
  const ts = candleTs(current);
  const maFast = smaAt(closes, idx, Number(p.maFast));
  const maMid = smaAt(closes, idx, Number(p.maMid));
  const maSlow = smaAt(closes, idx, Number(p.maSlow));
  const prevMaFast = smaAt(closes, idx - 1, Number(p.maFast));
  if (maFast == null || maMid == null || maSlow == null || prevMaFast == null) {
    return none(family, 'insufficient_bars', {
      candleTs: ts,
      requiredBars: Math.max(Number(p.maFast), Number(p.maMid), Number(p.maSlow)) + 1,
      actualBars: bars.length,
    });
  }

  const aligned = maFast > maMid && maMid > maSlow;
  if (params.positionOpen === true) {
    if (current.close < maMid) {
      return signal(family, 'exit', {
        candleTs: ts,
        price: round(current.close, 6),
        reason: 'close_below_ma_mid',
        details: { maMid: round(maMid, 6), maMidPeriod: p.maMid },
      });
    }
    return none(family, 'no_exit_below_ma_mid', {
      candleTs: ts,
      close: round(current.close, 6),
      maMid: round(maMid, 6),
      maMidPeriod: p.maMid,
    });
  }
  if (params.pendingSetup === true && (current.close < maSlow || !aligned)) {
    return signal(family, 'invalidate', {
      candleTs: ts,
      price: round(current.close, 6),
      reason: current.close < maSlow ? 'close_below_ma_slow' : 'ma_alignment_broken',
      details: {
        maFast: round(maFast, 6),
        maMid: round(maMid, 6),
        maSlow: round(maSlow, 6),
        aligned,
      },
    });
  }
  if (!aligned) {
    return none(family, 'ma_alignment_not_met', {
      candleTs: ts,
      maFast: round(maFast, 6),
      maMid: round(maMid, 6),
      maSlow: round(maSlow, 6),
    });
  }

  const windowStart = Math.max(0, idx - Number(p.pullbackWindow));
  const priorIndexes = Array.from({ length: idx - windowStart }, (_, offset) => windowStart + offset);
  const hadPullback = priorIndexes.some((i) => {
    const fast = smaAt(closes, i, Number(p.maFast));
    return fast != null && closes[i] < fast;
  });
  const reclaimedFast = current.close > maFast && closes[idx - 1] <= prevMaFast;
  if (!hadPullback) {
    return none(family, 'no_recent_pullback_below_fast_ma', { candleTs: ts, pullbackWindow: p.pullbackWindow });
  }
  if (!reclaimedFast) {
    return none(family, 'fast_ma_not_reclaimed_by_close', {
      candleTs: ts,
      close: round(current.close, 6),
      maFast: round(maFast, 6),
      previousClose: round(closes[idx - 1], 6),
      previousMaFast: round(prevMaFast, 6),
    });
  }

  const stop = Math.min(...lows.slice(windowStart, idx).filter(Number.isFinite));
  const swingHigh = previousSwingHigh(bars, idx, Math.max(Number(p.pullbackWindow), 20));
  const entry = Number(current.close);
  const target = swingHigh != null ? swingHigh : entry + 2 * (entry - stop);
  const rr = entry > stop ? (target - entry) / (entry - stop) : null;
  return withEntryValidity(signal(family, 'entry', {
    candleTs: ts,
    price: round(entry, 6),
    stop: round(stop, 6),
    target: round(target, 6),
    rr: round(rr, 4),
    reason: 'fast_ma_reclaim_after_pullback_in_aligned_trend',
    details: {
      maFastPeriod: p.maFast,
      maMidPeriod: p.maMid,
      maSlowPeriod: p.maSlow,
      pullbackWindow: p.pullbackWindow,
      maFast: round(maFast, 6),
      maMid: round(maMid, 6),
      maSlow: round(maSlow, 6),
      previousSwingHigh: swingHigh == null ? null : round(swingHigh, 6),
    },
  }));
}

async function parameterValue(key: string, fallback: any, options: any = {}, deps: any = {}) {
  if (options.parameters && Object.prototype.hasOwnProperty.call(options.parameters, key)) return options.parameters[key];
  try {
    const row = await (deps.getParameter || getParameter)(key, 'strategy_family', {
      bypassCache: options.bypassParameterCache === true,
      env: options.env || process.env,
      queryFn: deps.queryFn || options.queryFn || db.query,
    });
    return row?.value ?? fallback;
  } catch {
    return fallback;
  }
}

export async function loadStrategyFamilyParameters(options: any = {}, deps: any = {}) {
  const turtle = {};
  for (const [name, key] of Object.entries(LUNA_STRATEGY_PARAM_KEYS.turtle)) {
    turtle[name] = Number(await parameterValue(key, LUNA_STRATEGY_DEFAULTS.turtle[name], options, deps));
  }
  const testah = {};
  for (const [name, key] of Object.entries(LUNA_STRATEGY_PARAM_KEYS.testah)) {
    testah[name] = Number(await parameterValue(key, LUNA_STRATEGY_DEFAULTS.testah[name], options, deps));
  }
  const regimeMatch = {
    turtle: await parameterValue(LUNA_STRATEGY_PARAM_KEYS.regimeMatch.turtle, LUNA_STRATEGY_DEFAULTS.regimeMatch.turtle, options, deps),
    testah: await parameterValue(LUNA_STRATEGY_PARAM_KEYS.regimeMatch.testah, LUNA_STRATEGY_DEFAULTS.regimeMatch.testah, options, deps),
  };
  return {
    turtle: { ...LUNA_STRATEGY_DEFAULTS.turtle, ...turtle },
    testah: { ...LUNA_STRATEGY_DEFAULTS.testah, ...testah },
    regimeMatch: {
      turtle: Array.isArray(regimeMatch.turtle) ? regimeMatch.turtle : LUNA_STRATEGY_DEFAULTS.regimeMatch.turtle,
      testah: Array.isArray(regimeMatch.testah) ? regimeMatch.testah : LUNA_STRATEGY_DEFAULTS.regimeMatch.testah,
    },
  };
}

export function attachRegimeToSignal(result: any, market: string, regime: any = null, allowedRegimes: any[] = []) {
  const dominant = regime?.dominant || null;
  const matched = Boolean(dominant && (allowedRegimes || []).includes(dominant));
  return {
    ...result,
    market: normalizePhaseAMarket(market),
    regime: regime
      ? {
          market: regime.market || normalizePhaseAMarket(market),
          dominant,
          bullProbability: regime.probabilities?.bull ?? null,
          dominantProbability: dominant ? regime.probabilities?.[dominant] ?? null : null,
          source: regime.source || null,
          computedAt: regime.computedAt || null,
        }
      : null,
    matched,
    details: {
      ...(result.details || {}),
      regimeMatched: matched,
      allowedRegimes,
    },
  };
}

export async function evaluateStrategyFamiliesForSymbol(input: any = {}, deps: any = {}) {
  const market = normalizePhaseAMarket(input.market || 'domestic');
  const symbol = normalizePhaseASymbol(input.symbol || '', market);
  if (!symbol) return [];
  const params = input.params || await loadStrategyFamilyParameters(input, deps);
  const marketData = Array.isArray(input.bars)
    ? { bars: normalizeBars(input.bars), source: 'provided_bars', error: null }
    : await (deps.fetchPhaseABars || fetchPhaseABars)({
        symbol,
        market,
        timeframe: input.timeframe || LUNA_STRATEGY_DEFAULTS.timeframe,
        lookbackDays: input.lookbackDays || LUNA_STRATEGY_DEFAULTS.lookbackDays,
        getOhlcv: input.getOhlcv,
      });
  const bars = dropIncompleteLastBar(marketData.bars || [], market, input.now || input.currentTime || new Date());
  if (bars.length === 0) {
    return [{
      market,
      symbol,
      family: 'strategy_families',
      signalType: 'none',
      reason: marketData.error || 'no_bars',
      details: { source: marketData.source, error: marketData.error || null },
    }];
  }

  const regime = input.regime || await (deps.computeRegimeState || computeRegimeState)(market, {
    fetchBars: false,
    bars,
    previousRows: input.previousRegimeRows || [],
    evaluateTransitionAlert: false,
    persist: false,
  }, deps);
  return [
    attachRegimeToSignal(evaluateTurtleBreakout(bars, {
      ...params.turtle,
      positionOpen: input.positionOpen === true,
    }), market, regime, params.regimeMatch.turtle),
    attachRegimeToSignal(evaluateTestahPullback(bars, {
      ...params.testah,
      positionOpen: input.positionOpen === true,
      pendingSetup: input.pendingSetup === true,
    }), market, regime, params.regimeMatch.testah),
  ].map((result) => ({
    ...result,
    market,
    symbol,
    source: marketData.source,
    shadowOnly: true,
    liveMutation: false,
  }));
}

function normalizePositionMarket(row: any = {}) {
  const exchange = String(row.exchange || '').toLowerCase();
  if (exchange.includes('binance') || String(row.symbol || '').includes('/')) return 'crypto';
  if (exchange.includes('overseas')) return 'overseas';
  return 'domestic';
}

export async function buildStrategyFamilyUniverse(options: any = {}, deps: any = {}) {
  if (Array.isArray(options.universe)) {
    return options.universe.map((item) => ({
      market: normalizePhaseAMarket(item.market),
      symbol: normalizePhaseASymbol(item.symbol, item.market),
      source: item.source || 'provided_universe',
      positionOpen: item.positionOpen === true || item.source === 'open_position',
      pendingSetup: item.pendingSetup === true,
    })).filter((item) => item.symbol);
  }
  const rows = [];
  try {
    const positions = await (deps.queryFn || options.queryFn || db.query)(
      `SELECT symbol, exchange
         FROM positions
        WHERE amount > 0
        ORDER BY updated_at DESC
        LIMIT 100`,
    );
    for (const row of positions || []) {
      const market = normalizePositionMarket(row);
      rows.push({
        market,
        symbol: normalizePhaseASymbol(row.symbol, market),
        source: 'open_position',
        positionOpen: true,
      });
    }
  } catch {
    // Open-position enrichment is best-effort; seed watchlist still keeps the shadow run useful.
  }
  for (const [market, seeds] of Object.entries(DEFAULT_MARKET_SEED_WATCHLIST)) {
    for (const seed of seeds || []) {
      rows.push({
        market: normalizePhaseAMarket(market),
        symbol: normalizePhaseASymbol(seed.symbol, market),
        source: 'market_seed_watchlist',
        positionOpen: false,
      });
    }
  }
  const seen = new Set();
  return rows.filter((item) => {
    const key = `${item.market}:${item.symbol}`;
    if (!item.symbol || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function computeStrategyFamilySignals(options: any = {}, deps: any = {}) {
  const params = options.params || await loadStrategyFamilyParameters(options, deps);
  const universe = await buildStrategyFamilyUniverse(options, deps);
  const signals = [];
  const errors = [];
  const providedRegimeMap = options.regimeByMarket instanceof Map
    ? options.regimeByMarket
    : new Map(Object.entries(options.regimeByMarket || {}));
  const regimesByMarket = new Map([
    ...(options.regimes || []).map((state) => [normalizePhaseAMarket(state.market), state]),
    ...Array.from(providedRegimeMap.entries()).map(([market, state]) => [normalizePhaseAMarket(market), state]),
  ]);
  for (const item of universe) {
    try {
      const results = await evaluateStrategyFamiliesForSymbol({
        ...options,
        ...item,
        params,
        regime: regimesByMarket.get(normalizePhaseAMarket(item.market)) || options.regime,
      }, deps);
      for (const result of results) {
        if (['entry', 'exit', 'invalidate'].includes(result.signalType)) signals.push(result);
      }
    } catch (error) {
      errors.push({ ...item, error: error?.message || String(error) });
    }
  }
  return {
    ok: errors.length === 0,
    universe,
    signals,
    errors,
    summary: summarizeStrategyFamilySignals(signals),
    shadowOnly: true,
    liveMutation: false,
  };
}

export function summarizeStrategyFamilySignals(signals = []) {
  const filtered = (signals || []).filter((item) => ['entry', 'exit', 'invalidate'].includes(item.signalType));
  const turtle = filtered.filter((item) => item.family === LUNA_STRATEGY_SIGNAL_FAMILIES.turtle).length;
  const testah = filtered.filter((item) => item.family === LUNA_STRATEGY_SIGNAL_FAMILIES.testah).length;
  return `전략군: 신호 ${filtered.length}건(터틀 ${turtle}·테스타 ${testah})`;
}

export async function ensureStrategySignalsSchema(runFn = db.run) {
  for (const statement of LUNA_STRATEGY_SIGNALS_SCHEMA_SQL) {
    await runFn(statement);
  }
}

export async function insertStrategyFamilySignal(row: any, runFn = db.run) {
  return runFn(
    `INSERT INTO luna_strategy_signals
       (market, symbol, family, signal_type, candle_ts, price, stop, target, rr, regime, matched, rule_version, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb)
     ON CONFLICT (symbol, family, candle_ts, signal_type) DO NOTHING
     RETURNING id`,
    [
      normalizePhaseAMarket(row.market),
      row.symbol,
      row.family,
      row.signalType,
      row.candleTs,
      row.price ?? null,
      row.stop ?? null,
      row.target ?? null,
      row.rr ?? null,
      JSON.stringify(row.regime || {}),
      row.matched ?? null,
      row.ruleVersion || 'v1',
      JSON.stringify({
        ...(row.details || {}),
        reason: row.reason || null,
        source: row.source || null,
        shadowOnly: true,
      }),
    ],
  );
}

export async function insertStrategyFamilySignals(signals = [], runFn = db.run) {
  const inserted = [];
  for (const row of signals || []) {
    const result = await insertStrategyFamilySignal(row, runFn);
    inserted.push(result?.rows?.[0]?.id || null);
  }
  return inserted;
}

export const _testOnly = {
  normalizeBars,
  parseBarTime,
  isCompletedDailyBar,
  dropIncompleteLastBar,
  smaAt,
  rollingMax,
  rollingMin,
  trueRange,
  withEntryValidity,
  previousSwingHigh,
};

export default {
  evaluateTurtleBreakout,
  evaluateTestahPullback,
  dropIncompleteLastBar,
  evaluateStrategyFamiliesForSymbol,
  computeStrategyFamilySignals,
  insertStrategyFamilySignals,
  summarizeStrategyFamilySignals,
};
