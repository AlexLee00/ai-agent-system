#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { runVectorBtGrid } from '../shared/vectorbt-runner.ts';
import { getOHLCV } from '../shared/ohlcv-fetcher.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { ensureCandidateBacktestSchema, evaluateCandidateBacktestStatus } from '../shared/candidate-backtest-gate.ts';
import { fetchDataGoStockPriceHistoryForSymbol } from '../shared/domestic-official-reference.ts';
import { exchangeForLunaPhase2Market } from '../shared/luna-weight-vector.ts';
import { getActiveCandidates as getDiscoveryActiveCandidates } from '../team/discovery/discovery-store.ts';
import {
  BINANCE_TOP_VOLUME_BLOCK_REASON,
  buildFixtureBinanceTopVolumeUniverse,
  evaluateBinanceTopVolumeUniverseGate,
  getCachedBinanceTopVolumeUniverse,
} from '../shared/binance-top-volume-universe.ts';

const SHADOW_MODE = process.env.LUNA_CANDIDATE_BACKTEST_SHADOW_MODE !== 'false';
const STALE_HOURS = Number(process.env.LUNA_BACKTEST_STALE_HOURS || 24);
const REFRESH_UNHEALTHY = process.env.LUNA_BACKTEST_REFRESH_UNHEALTHY !== 'false';
const OHLCV_FALLBACK_ENABLED = process.env.LUNA_BACKTEST_OHLCV_FALLBACK_ENABLED !== 'false';
const VECTORBT_ENABLED = process.env.LUNA_BACKTEST_VECTORBT_ENABLED !== 'false';
const VECTORBT_TIMEOUT_MS = Math.max(5_000, Number(process.env.LUNA_VECTORBT_TIMEOUT_MS || 30_000));
const OHLCV_TIMEOUT_MS = Math.max(5_000, Number(process.env.LUNA_BACKTEST_OHLCV_TIMEOUT_MS || 20_000));

const GATE = {
  MIN_SHARPE: 0,
  MAX_DRAWDOWN: 30,
  MIN_WIN_RATE: 30,
  MAX_ABS_SHARPE: Number(process.env.LUNA_BACKTEST_MAX_ABS_SHARPE || 8),
  MIN_PERIOD_TRADES: Math.max(1, Number(process.env.LUNA_BACKTEST_MIN_PERIOD_TRADES || 5)),
  MIN_TOTAL_TRADES: Math.max(1, Number(process.env.LUNA_BACKTEST_MIN_TOTAL_TRADES || 12)),
  STALE_HOURS,
};

function argValue(name: string, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function periodsFrom(value: any) {
  return String(value || '30,90,180')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0);
}

function optionalPositiveInt(value: any, fallback: number | null = null): number | null {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function optionalNonNegativeInt(value: any, fallback: number | null = null): number | null {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function symbolsFrom(value: any): string[] {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

function inferRequestedSymbolMarket(symbol: string, requestedMarket = 'all') {
  const normalizedMarket = normalizeMarket(requestedMarket);
  if (normalizedMarket !== 'all') return normalizedMarket;
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  if (normalizedSymbol.includes('/') || normalizedSymbol.endsWith('USDT')) return 'crypto';
  if (/^\d{6}$/.test(normalizedSymbol)) return 'domestic';
  return 'overseas';
}

function selectRequestedCandidates(candidates: any[] = [], requestedSymbols: string[] = [], market = 'all') {
  if (!requestedSymbols.length) return candidates;
  const bySymbol = new Map();
  for (const candidate of candidates || []) {
    const symbol = String(candidate?.symbol || '').trim().toUpperCase();
    if (!symbol || bySymbol.has(symbol)) continue;
    bySymbol.set(symbol, {
      ...candidate,
      symbol,
      market: normalizeMarket(candidate?.market || market),
    });
  }
  return requestedSymbols.map((symbol) => {
    const normalizedSymbol = String(symbol || '').trim().toUpperCase();
    return bySymbol.get(normalizedSymbol) || {
      symbol: normalizedSymbol,
      market: inferRequestedSymbolMarket(normalizedSymbol, market),
      source: 'requested_symbol_override',
    };
  });
}

function marketSortRank(market: any) {
  const normalized = normalizeMarket(market);
  if (normalized === 'crypto') return 0;
  if (normalized === 'domestic') return 1;
  if (normalized === 'overseas') return 2;
  return 9;
}

function interleaveCandidatesByMarket(candidates: any[] = []) {
  const buckets = new Map();
  for (const candidate of candidates || []) {
    const market = normalizeMarket(candidate?.market || 'all');
    if (!buckets.has(market)) buckets.set(market, []);
    buckets.get(market).push(candidate);
  }
  const markets = [...buckets.keys()].sort((a, b) => marketSortRank(a) - marketSortRank(b) || String(a).localeCompare(String(b)));
  const output = [];
  let index = 0;
  while (output.length < (candidates || []).length) {
    let added = false;
    for (const market of markets) {
      const bucket = buckets.get(market) || [];
      if (bucket[index]) {
        output.push(bucket[index]);
        added = true;
      }
    }
    if (!added) break;
    index += 1;
  }
  return output;
}

function candidateKey(symbol: any, market: any) {
  return `${String(market || '').trim().toLowerCase()}::${String(symbol || '').trim().toUpperCase()}`;
}

function booleanish(value: any) {
  return value === true || String(value).toLowerCase() === 'true';
}

function backtestPriorityForStatus(status: any) {
  if (!status) return 0; // Never-tested candidates should consume the next batch budget first.
  const fresh = !isStale(status.last_backtest_at);
  const healthy = booleanish(status.healthy);
  const wouldBlock = booleanish(status.would_block);
  const refreshDue = isRefreshDue(status.next_refresh_at);
  if (!fresh) return 1;
  if (refreshDue && (!healthy || REFRESH_UNHEALTHY)) return 2;
  if (!healthy && !wouldBlock) return 3;
  if (healthy) return 4;
  return 5;
}

async function prioritizeCandidatesForBacktest(candidates: any[] = []) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const params: any[] = [];
  const values = candidates.map((candidate, index) => {
    const symbol = String(candidate?.symbol || '').trim().toUpperCase();
    const market = normalizeMarket(candidate?.market || 'all');
    params.push(symbol, market, index);
    const base = index * 3;
    return `($${base + 1}, $${base + 2}, $${base + 3})`;
  });
  const rows = await db.query(`
    WITH input(symbol, market, idx) AS (
      VALUES ${values.join(',')}
    )
    SELECT
      input.symbol,
      input.market,
      input.idx,
      status.id AS status_id,
      status.healthy,
      status.would_block,
      status.last_backtest_at,
      status.next_refresh_at,
      status.gate_status
    FROM input
    LEFT JOIN candidate_backtest_status status
      ON status.symbol = input.symbol
     AND status.market = input.market
  `, params).catch(() => []);
  const statusByKey = new Map((rows || [])
    .filter((row) => row.status_id != null)
    .map((row) => [candidateKey(row.symbol, row.market), row]));
  return candidates
    .map((candidate, index) => {
      const symbol = String(candidate?.symbol || '').trim().toUpperCase();
      const market = normalizeMarket(candidate?.market || 'all');
      const status = statusByKey.get(candidateKey(symbol, market));
      return {
        ...candidate,
        symbol,
        market,
        __backtestPriority: backtestPriorityForStatus(status),
        __backtestOriginalIndex: index,
      };
    })
    .sort((a, b) => a.__backtestPriority - b.__backtestPriority
      || marketSortRank(a.market) - marketSortRank(b.market)
      || (b.score ?? b.qualityScore ?? 0) - (a.score ?? a.qualityScore ?? 0)
      || a.__backtestOriginalIndex - b.__backtestOriginalIndex)
    .map(({ __backtestPriority, __backtestOriginalIndex, ...candidate }) => candidate);
}

async function getActiveCandidates(limit = 100) {
  return getActiveCandidatesByMarket({ limit, market: 'crypto' });
}

function normalizeMarket(value: any = 'all') {
  const raw = String(value || 'all').trim().toLowerCase();
  if (raw === 'binance') return 'crypto';
  if (raw === 'kis') return 'domestic';
  if (raw === 'kis_overseas') return 'overseas';
  return ['crypto', 'domestic', 'overseas', 'all'].includes(raw) ? raw : 'all';
}

async function getActiveCandidatesByMarket({ limit = 100, market = 'all' } = {}) {
  const normalizedMarket = normalizeMarket(market);
  const perMarketLimit = Math.max(1, Math.ceil(Number(limit || 100) / 3));
  if (normalizedMarket !== 'all') {
    return getDiscoveryActiveCandidates(normalizedMarket, limit)
      .then((rows) => rows.map((row) => ({ symbol: row.symbol, market: row.market })))
      .catch(() => []);
  }
  const rows = await Promise.all([
    getDiscoveryActiveCandidates('crypto', perMarketLimit).catch(() => []),
    getDiscoveryActiveCandidates('domestic', perMarketLimit).catch(() => []),
    getDiscoveryActiveCandidates('overseas', perMarketLimit).catch(() => []),
  ]);
  return rows.flat().slice(0, limit).map((row) => ({ symbol: row.symbol, market: row.market }));
}

async function getBacktestStatus(symbol: string, market: string) {
  return db.get(
    `SELECT fresh, healthy, last_backtest_at, next_refresh_at, gate_status, sharpe, max_drawdown, win_rate, would_block, block_reasons
       FROM candidate_backtest_status
      WHERE symbol = $1 AND market = $2`,
    [symbol, market],
  ).catch(() => null);
}

function isStale(lastBacktestAt: Date | string | null): boolean {
  if (!lastBacktestAt) return true;
  const ageMs = Date.now() - new Date(lastBacktestAt).getTime();
  return ageMs > GATE.STALE_HOURS * 3600 * 1000;
}

function isRefreshDue(nextRefreshAt: Date | string | null): boolean {
  if (!nextRefreshAt) return true;
  const dueAt = new Date(nextRefreshAt).getTime();
  if (!Number.isFinite(dueAt)) return true;
  return dueAt <= Date.now();
}

function safeNum(v: any, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseJsonArray(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return value ? [value] : [];
    }
  }
  return [];
}

function reliabilityReasons(row: any): string[] {
  return [...parseJsonArray(row?.reasons), ...parseJsonArray(row?.oos_reasons)]
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function isInsufficientOos(row: any): boolean {
  return String(row?.oos_status || '').toLowerCase() === 'insufficient_data';
}

function reliabilitySharpe(row: any, fallback = NaN): number {
  if (isInsufficientOos(row) && row?.sharpe_oos == null && row?.sharpe_oos_deflated == null) {
    return fallback;
  }
  return safeNum(row?.sharpe_oos_deflated ?? row?.sharpe_oos ?? row?.sharpe_ratio ?? row?.sharpe, fallback);
}

function rowsHaveUsableTrades(rows: any[]) {
  return Array.isArray(rows) && rows.some((row) => {
    const status = String(row?.status || 'ok').toLowerCase();
    return ['ok', 'unstable'].includes(status) && safeNum(row?.total_trades) > 0;
  });
}

function qualityRank(row: any) {
  const trades = safeNum(row?.total_trades, 0);
  const sharpe = reliabilitySharpe(row, NaN);
  const drawdown = Math.abs(safeNum(row?.max_drawdown, 0));
  const winRate = safeNum(row?.win_rate, 0);
  const sampleOk = trades >= GATE.MIN_PERIOD_TRADES;
  const saneSharpe = Number.isFinite(sharpe) && Math.abs(sharpe) <= GATE.MAX_ABS_SHARPE;
  const gateOk = sampleOk
    && saneSharpe
    && sharpe >= GATE.MIN_SHARPE
    && drawdown <= GATE.MAX_DRAWDOWN
    && winRate >= GATE.MIN_WIN_RATE;
  const selectionTier = gateOk
    ? 4
    : sampleOk && saneSharpe
      ? 3
      : sampleOk
        ? 2
        : saneSharpe
          ? 1
          : 0;
  const robust = safeNum(row?.robust_score, NaN);
  const rawRank = Number.isFinite(robust) ? robust : reliabilitySharpe(row, -Infinity);
  const boundedRank = Math.max(-1_000, Math.min(1_000, rawRank));
  return selectionTier * 1_000_000 + boundedRank;
}

function qualityPeriodKey(row: any, index = 0) {
  const period = row?.walk_forward_days ?? row?.period_days ?? row?.days ?? row?.params?.walk_forward_days;
  return period == null || period === '' ? `row:${index}` : String(period);
}

function selectBestQualityRows(rows: any[]) {
  const groups = new Map();
  (rows || []).forEach((row, index) => {
    const key = qualityPeriodKey(row, index);
    const current = groups.get(key);
    if (!current || qualityRank(row) > qualityRank(current)) {
      groups.set(key, row);
      return;
    }
    if (qualityRank(row) === qualityRank(current) && safeNum(row?.total_trades) > safeNum(current?.total_trades)) {
      groups.set(key, row);
    }
  });
  return [...groups.entries()]
    .sort(([a], [b]) => {
      const an = Number(a);
      const bn = Number(b);
      if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
      return String(a).localeCompare(String(b));
    })
    .map(([period, row]) => ({ ...row, quality_period: period }));
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stdev(values: number[]) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - m) ** 2)));
}

function maxDrawdownPct(equity: number[]) {
  let peak = equity[0] || 1;
  let maxDd = 0;
  for (const value of equity) {
    peak = Math.max(peak, value);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - value) / peak);
  }
  return maxDd * 100;
}

function movingAverage(values: number[], endExclusive: number, window: number) {
  if (endExclusive < window) return null;
  return mean(values.slice(endExclusive - window, endExclusive));
}

function buildOhlcvMomentumBacktestRows(rows: any[], days: number, market: string) {
  const candles = (rows || [])
    .map((row) => Array.isArray(row)
      ? { ts: Number(row[0]), close: Number(row[4]) }
      : { ts: Number(row.candle_ts ?? row.ts ?? row.timestamp), close: Number(row.close) })
    .filter((row) => Number.isFinite(row.ts) && Number.isFinite(row.close) && row.close > 0)
    .sort((a, b) => a.ts - b.ts);
  const closes = candles.map((row) => row.close);
  const minBars = market === 'crypto' ? 60 : 20;
  if (closes.length < minBars) {
    return [{
      status: 'insufficient_ohlcv',
      total_trades: 0,
      message: `ohlcv_insufficient(${closes.length}<${minBars})`,
      params: { fallback: 'ohlcv_momentum_v1', bars: closes.length, days },
    }];
  }

  const shortWindow = market === 'crypto' ? 12 : 5;
  const longWindow = market === 'crypto' ? 36 : 20;
  const stopLoss = market === 'crypto' ? -0.055 : -0.045;
  const takeProfit = market === 'crypto' ? 0.09 : 0.075;
  const trades: number[] = [];
  const equity = [1];
  let positionEntry: number | null = null;

  for (let i = longWindow; i < closes.length; i += 1) {
    const close = closes[i];
    const shortMa = movingAverage(closes, i, shortWindow);
    const longMa = movingAverage(closes, i, longWindow);
    if (shortMa == null || longMa == null) continue;
    if (positionEntry == null) {
      if (shortMa > longMa && close > shortMa) positionEntry = close;
      continue;
    }
    const tradeReturn = (close - positionEntry) / positionEntry;
    const exit = shortMa < longMa || close < shortMa || tradeReturn <= stopLoss || tradeReturn >= takeProfit;
    if (!exit) continue;
    trades.push(tradeReturn);
    equity.push((equity[equity.length - 1] || 1) * (1 + tradeReturn));
    positionEntry = null;
  }
  if (positionEntry != null) {
    const last = closes[closes.length - 1];
    const tradeReturn = (last - positionEntry) / positionEntry;
    trades.push(tradeReturn);
    equity.push((equity[equity.length - 1] || 1) * (1 + tradeReturn));
  }

  if (trades.length === 0) {
    return [{
      status: 'no_trades',
      total_trades: 0,
      message: 'ohlcv_momentum_no_trades',
      params: { fallback: 'ohlcv_momentum_v1', bars: closes.length, days, shortWindow, longWindow },
    }];
  }

  const tradePct = trades.map((value) => value * 100);
  const avg = mean(tradePct);
  const sd = stdev(tradePct);
  const sharpe = sd > 0 ? (avg / sd) * Math.sqrt(Math.max(1, trades.length)) : avg > 0 ? 1 : -1;
  const totalReturn = ((equity[equity.length - 1] || 1) - 1) * 100;
  return [{
    status: 'ok',
    total_trades: trades.length,
    sharpe_ratio: Number(sharpe.toFixed(4)),
    max_drawdown: Number(maxDrawdownPct(equity).toFixed(4)),
    win_rate: Number((trades.filter((value) => value > 0).length / trades.length * 100).toFixed(4)),
    total_return: Number(totalReturn.toFixed(4)),
    params: { fallback: 'ohlcv_momentum_v1', bars: closes.length, days, shortWindow, longWindow, stopLoss, takeProfit },
  }];
}

function basDtToTimestamp(row: any = {}) {
  const raw = String(row.basDt || row.BAS_DD || '').trim();
  if (!/^\d{8}$/.test(raw)) return null;
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  const ms = Date.UTC(year, month - 1, day, 6, 30, 0);
  return Number.isFinite(ms) ? ms : null;
}

function buildOfficialDomesticOhlcvRows(rows: any[] = []) {
  return (rows || [])
    .map((row) => {
      const ts = basDtToTimestamp(row);
      const close = safeNum(row?.clpr ?? row?.TDD_CLSPRC, NaN);
      const open = safeNum(row?.mkp ?? row?.TDD_OPNPRC, close);
      const high = safeNum(row?.hipr ?? row?.TDD_HGPRC, close);
      const low = safeNum(row?.lopr ?? row?.TDD_LWPRC, close);
      const volume = safeNum(row?.trqu ?? row?.ACC_TRDVOL, 0);
      if (!Number.isFinite(ts) || !Number.isFinite(close) || close <= 0) return null;
      return [
        ts,
        Number.isFinite(open) && open > 0 ? open : close,
        Number.isFinite(high) && high > 0 ? high : close,
        Number.isFinite(low) && low > 0 ? low : close,
        close,
        Number.isFinite(volume) ? volume : 0,
      ];
    })
    .filter(Boolean)
    .sort((a, b) => a[0] - b[0]);
}

function withTimeout(promise: Promise<any>, timeoutMs: number, label = 'timeout') {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: any = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}(${timeoutMs}ms)`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function runOhlcvFallbackBacktest(symbol: string, market: string, days: number, options: any = {}) {
  if (!OHLCV_FALLBACK_ENABLED) return [];
  const exchange = exchangeForLunaPhase2Market(market);
  const timeframe = process.env.LUNA_BACKTEST_OHLCV_FALLBACK_TIMEFRAME || (market === 'crypto' ? '1h' : '1d');
  const from = new Date(Date.now() - Math.max(7, days) * 24 * 3600 * 1000).toISOString();
  const timeoutMs = Math.max(1_000, Math.min(OHLCV_TIMEOUT_MS, Number(options.timeoutMs || OHLCV_TIMEOUT_MS)));
  let rows = [];
  let primaryError = null;
  try {
    rows = await withTimeout(getOHLCV(symbol, timeframe, from, null, exchange), timeoutMs, 'ohlcv_fallback_timeout');
  } catch (error) {
    primaryError = error;
  }
  const minFallbackRows = market === 'crypto' ? 60 : 20;
  if (Array.isArray(rows) && rows.length >= minFallbackRows) return buildOhlcvMomentumBacktestRows(rows, days, market);
  if (market === 'domestic') {
    const history = await fetchDataGoStockPriceHistoryForSymbol({
      symbol,
      lookbackDays: Math.max(days + 7, days),
      maxRows: Math.max(30, days + 7),
      timeoutMs,
    }).catch((error) => ({ ok: false, rows: [], errors: [String(error?.message || error)] }));
    const officialRows = buildOfficialDomesticOhlcvRows(history.rows || []);
    if (officialRows.length > 0) {
      return buildOhlcvMomentumBacktestRows(officialRows, days, market).map((row) => ({
        ...row,
        status: row.status === 'insufficient_ohlcv' ? 'insufficient_official_ohlcv' : row.status,
        message: row.message ? `data_go_kr_stock_price_${row.message}` : row.message,
        params: {
          ...(row.params || {}),
          fallback: 'data_go_kr_stock_price_history',
          officialRows: officialRows.length,
          requestedRows: history.rowCount || officialRows.length,
        },
      }));
    }
  }
  if (primaryError) throw primaryError;
  return buildOhlcvMomentumBacktestRows(rows, days, market);
}

function evaluateQuality(rows: any[], market: string = 'all') {
  const usable = (rows || []).filter((r) => {
    const status = String(r?.status || 'ok').toLowerCase();
    const oosStatus = String(r?.oos_status || '').toLowerCase();
    const isBacktestReliabilityRow = Boolean(r?.selection_method || oosStatus);
    return (['ok', 'unstable'].includes(status) || isBacktestReliabilityRow) && safeNum(r?.total_trades) > 0;
  });
  if (usable.length === 0) {
    const statuses = (rows || []).map((r) => String(r?.status || '').trim()).filter(Boolean);
    const sawNoTrades = statuses.includes('no_trades') || (rows || []).some((r) => {
      const status = String(r?.status || '').trim();
      return safeNum(r?.total_trades) === 0 && !['insufficient_ohlcv', 'insufficient_official_ohlcv'].includes(status);
    });
    const sawInsufficient = statuses.includes('insufficient_ohlcv');
    const sawInsufficientOfficial = statuses.includes('insufficient_official_ohlcv');
    return {
      fresh: (rows || []).length > 0,
      sharpe: null,
      maxDrawdown: null,
      winRate: null,
      healthy: false,
      gateStatus: sawNoTrades ? 'would_block_no_trades' : 'would_block_no_data',
      wouldBlock: true,
      reasons: [sawNoTrades ? 'backtest_no_trades' : sawInsufficientOfficial ? 'backtest_insufficient_official_ohlcv' : sawInsufficient ? 'backtest_insufficient_ohlcv' : 'backtest_no_data'],
    };
  }

  const qualityRows = selectBestQualityRows(usable);
  const rawAvgSharpe = qualityRows.reduce((s, r) => s + reliabilitySharpe(r, 0), 0) / qualityRows.length;
  const avgSharpe = Math.max(-GATE.MAX_ABS_SHARPE, Math.min(GATE.MAX_ABS_SHARPE, rawAvgSharpe));
  const totalTrades = qualityRows.reduce((sum, r) => sum + safeNum(r?.total_trades), 0);
  const minTrades = Math.min(...qualityRows.map((r) => safeNum(r?.total_trades)));
  const maxDD = Math.max(...qualityRows.map((r) => Math.abs(safeNum(r?.max_drawdown))));
  const avgWinRate = qualityRows.reduce((s, r) => s + safeNum(r?.win_rate), 0) / qualityRows.length;
  const reasons: string[] = [];
  const oosReasons = [...new Set(qualityRows.flatMap(reliabilityReasons))];
  for (const reason of oosReasons) reasons.push(reason);
  if (avgSharpe < GATE.MIN_SHARPE) reasons.push(`sharpe_negative(${avgSharpe.toFixed(2)})`);
  const periodFailures = qualityRows
    .filter((r) => reliabilitySharpe(r, NaN) < GATE.MIN_SHARPE
      || Math.abs(safeNum(r?.max_drawdown)) > GATE.MAX_DRAWDOWN
      || safeNum(r?.win_rate) < GATE.MIN_WIN_RATE)
    .map((r) => `${r.quality_period}d:sharpe=${reliabilitySharpe(r, 0).toFixed(2)},drawdown=${Math.abs(safeNum(r?.max_drawdown)).toFixed(1)}%,winRate=${safeNum(r?.win_rate).toFixed(1)}%`);
  for (const failure of periodFailures) {
    reasons.push(`walk_forward_period_failed(${failure})`);
  }
  const unrealisticSharpe = Math.abs(rawAvgSharpe) > GATE.MAX_ABS_SHARPE;
  const normalizedMarket = normalizeMarket(market);
  const stablePeriodCount = qualityRows.filter((r) => safeNum(r?.total_trades) >= GATE.MIN_PERIOD_TRADES).length;
  const totalTradesLow = totalTrades < GATE.MIN_TOTAL_TRADES;
  const lowTradeShortWindowTolerated = normalizedMarket === 'domestic'
    && !totalTradesLow
    && qualityRows.length >= 3
    && stablePeriodCount >= 2
    && minTrades < GATE.MIN_PERIOD_TRADES;
  const lowTradeSample = totalTradesLow || (minTrades < GATE.MIN_PERIOD_TRADES && !lowTradeShortWindowTolerated);
  if (unrealisticSharpe) {
    reasons.push(`unrealistic_sharpe(${rawAvgSharpe.toFixed(2)})`);
    reasons.push(`backtest_unstable_sample(total_trades=${totalTrades},min_period_trades=${minTrades})`);
  }
  if (lowTradeSample) {
    reasons.push(`backtest_low_trade_sample(total_trades=${totalTrades},min_period_trades=${minTrades})`);
  }
  if (maxDD > GATE.MAX_DRAWDOWN) reasons.push(`drawdown_high(${maxDD.toFixed(1)}%)`);
  if (avgWinRate < GATE.MIN_WIN_RATE) reasons.push(`win_rate_low(${avgWinRate.toFixed(1)}%)`);

  const wouldBlock = reasons.some((r) => r.startsWith('sharpe_')
    || r.startsWith('unrealistic_')
    || r.startsWith('overfit_gap_high')
    || r.startsWith('insufficient_oos_sample')
    || r.startsWith('backtest_unstable_sample')
    || r.startsWith('backtest_low_trade_sample')
    || r.startsWith('walk_forward_period_failed')
    || r.startsWith('win_rate_')
    || r.startsWith('drawdown_'));
  const unstableByOos = oosReasons.some((r) => r.startsWith('unrealistic_sharpe')
    || r.startsWith('overfit_gap_high')
    || r.startsWith('insufficient_oos_sample')
    || r.startsWith('backtest_unstable_sample'));
  const onlyUnstable = wouldBlock
    && (unrealisticSharpe || lowTradeSample || unstableByOos)
    && !reasons.some((r) => r.startsWith('sharpe_negative') || r.startsWith('walk_forward_period_failed') || r.startsWith('win_rate_low') || r.startsWith('drawdown_high'));
  // OOS aggregate — WF 활성 시 qualityRows에 OOS 필드가 있으면 집계
  const oosRows = qualityRows.filter((r) => r?.sharpe_oos != null);
  const avgSharpeOos = oosRows.length > 0
    ? oosRows.reduce((s, r) => s + safeNum(r?.sharpe_oos), 0) / oosRows.length
    : null;
  const avgSharpeIs = oosRows.length > 0
    ? oosRows.reduce((s, r) => s + safeNum(r?.sharpe_is ?? r?.sharpe_ratio), 0) / oosRows.length
    : null;
  const avgSharpeOosDeflated = oosRows.filter((r) => r?.sharpe_oos_deflated != null).length > 0
    ? oosRows.filter((r) => r?.sharpe_oos_deflated != null).reduce((s, r) => s + safeNum(r?.sharpe_oos_deflated), 0) / oosRows.filter((r) => r?.sharpe_oos_deflated != null).length
    : null;
  const avgOverfitGap = oosRows.filter((r) => r?.overfit_gap != null).length > 0
    ? oosRows.filter((r) => r?.overfit_gap != null).reduce((s, r) => s + safeNum(r?.overfit_gap), 0) / oosRows.filter((r) => r?.overfit_gap != null).length
    : null;
  const avgNGridTrials = qualityRows.filter((r) => r?.n_grid_trials != null).length > 0
    ? Math.round(qualityRows.filter((r) => r?.n_grid_trials != null).reduce((s, r) => s + safeNum(r?.n_grid_trials), 0))
    : null;
  const avgWalkForwardSharpe = oosRows.filter((r) => r?.walk_forward_sharpe != null).length > 0
    ? oosRows.filter((r) => r?.walk_forward_sharpe != null).reduce((s, r) => s + safeNum(r?.walk_forward_sharpe), 0) / oosRows.filter((r) => r?.walk_forward_sharpe != null).length
    : null;
  const oosSampleRows = qualityRows.filter((r) => r?.n_obs_oos != null || r?.total_trades_oos != null);
  const sampleNObs = oosSampleRows.map((r) => safeNum(r?.n_obs_oos, NaN)).filter(Number.isFinite);
  const sampleTrades = oosSampleRows.map((r) => safeNum(r?.total_trades_oos, NaN)).filter(Number.isFinite);
  const minNObsOos = sampleNObs.length > 0 ? Math.min(...sampleNObs) : null;
  const minTradesOos = sampleTrades.length > 0 ? Math.min(...sampleTrades) : null;
  const oosStatuses = qualityRows
    .map((r) => String(r?.oos_status || '').trim().toLowerCase())
    .filter(Boolean);
  const selectionMethod = qualityRows.some((r) => String(r?.selection_method || '').trim() === 'walk_forward')
    ? 'walk_forward'
    : qualityRows.map((r) => String(r?.selection_method || '').trim()).find(Boolean) || null;
  const foldCounts = qualityRows.map((r) => safeNum(r?.fold_count, NaN)).filter(Number.isFinite);
  const foldCount = foldCounts.length > 0 ? Math.max(...foldCounts) : null;
  const oosStatus = oosSampleRows.length > 0 && oosRows.length === 0 && oosStatuses.includes('insufficient_data')
    ? 'insufficient_data'
    : oosStatuses.includes('unstable')
      ? 'unstable'
      : oosRows.length > 0
        ? 'ok'
        : null;
  const mergedReasons = [...new Set(reasons)];

  return {
    sharpe: Number(avgSharpe.toFixed(4)),
    maxDrawdown: Number(maxDD.toFixed(4)),
    winRate: Number(avgWinRate.toFixed(4)),
    healthy: !wouldBlock,
    gateStatus: wouldBlock ? (onlyUnstable ? 'would_block_unstable_backtest' : 'would_block_unhealthy') : 'pass',
    wouldBlock,
    reasons: mergedReasons,
    totalTrades,
    minPeriodTrades: minTrades,
    stablePeriodCount,
    lowTradeShortWindowTolerated,
    qualityRows,
    qualityRowSelection: 'best_per_walk_forward_period',
    qualityRowSelectionPolicy: 'stable_sample_first',
    sharpeOos: avgSharpeOos != null ? Number(avgSharpeOos.toFixed(4)) : null,
    sharpeIs: avgSharpeIs != null ? Number(avgSharpeIs.toFixed(4)) : null,
    sharpeOosDeflated: avgSharpeOosDeflated != null ? Number(avgSharpeOosDeflated.toFixed(4)) : null,
    overfitGap: avgOverfitGap != null ? Number(avgOverfitGap.toFixed(4)) : null,
    nGridTrials: avgNGridTrials,
    walkForwardSharpe: avgWalkForwardSharpe != null ? Number(avgWalkForwardSharpe.toFixed(4)) : null,
    nObsOos: minNObsOos != null ? Math.round(minNObsOos) : null,
    totalTradesOos: minTradesOos != null ? Math.round(minTradesOos) : null,
    oosStatus,
    selectionMethod,
    foldCount: foldCount != null ? Math.round(foldCount) : null,
  };
}

function fixtureRows(symbol: string) {
  if (symbol.includes('NEG')) {
    return [{ status: 'ok', total_trades: 12, sharpe_ratio: -0.7, max_drawdown: 18, win_rate: 24 }];
  }
  return [{ status: 'ok', total_trades: 18, sharpe_ratio: 1.15, max_drawdown: 12, win_rate: 48 }];
}

async function upsertStatus(symbol: string, market: string, payload: any, dryRun = false) {
  if (dryRun) return;
  const nextRefreshAt = new Date(Date.now() + GATE.STALE_HOURS * 3600 * 1000).toISOString();
  await db.run(`
    INSERT INTO candidate_backtest_status
      (symbol, market, fresh, healthy, sharpe, max_drawdown, win_rate,
       last_backtest_at, next_refresh_at, gate_status, would_block, enforced,
       block_reasons, backtest_run_metadata, updated_at,
       sharpe_oos, sharpe_is, sharpe_oos_deflated, overfit_gap, n_grid_trials, walk_forward_sharpe,
       n_obs_oos, total_trades_oos, oos_status, selection_method, fold_count)
    VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8,$9,$10,$11,$12::jsonb,$13::jsonb,NOW(),$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
    ON CONFLICT (symbol, market) DO UPDATE SET
      fresh = EXCLUDED.fresh,
      healthy = EXCLUDED.healthy,
      sharpe = EXCLUDED.sharpe,
      max_drawdown = EXCLUDED.max_drawdown,
      win_rate = EXCLUDED.win_rate,
      last_backtest_at = NOW(),
      next_refresh_at = EXCLUDED.next_refresh_at,
      gate_status = EXCLUDED.gate_status,
      would_block = EXCLUDED.would_block,
      enforced = EXCLUDED.enforced,
      block_reasons = EXCLUDED.block_reasons,
      backtest_run_metadata = EXCLUDED.backtest_run_metadata,
      updated_at = NOW(),
      sharpe_oos = EXCLUDED.sharpe_oos,
      sharpe_is = EXCLUDED.sharpe_is,
      sharpe_oos_deflated = EXCLUDED.sharpe_oos_deflated,
      overfit_gap = EXCLUDED.overfit_gap,
      n_grid_trials = EXCLUDED.n_grid_trials,
      walk_forward_sharpe = EXCLUDED.walk_forward_sharpe,
      n_obs_oos = EXCLUDED.n_obs_oos,
      total_trades_oos = EXCLUDED.total_trades_oos,
      oos_status = EXCLUDED.oos_status,
      selection_method = EXCLUDED.selection_method,
      fold_count = EXCLUDED.fold_count
  `, [
    symbol,
    market,
    payload.fresh,
    payload.healthy,
    payload.sharpe,
    payload.maxDrawdown,
    payload.winRate,
    nextRefreshAt,
    payload.gateStatus,
    payload.wouldBlock,
    false,
    JSON.stringify(payload.reasons || []),
    JSON.stringify({
      reasons: payload.reasons,
      periods: payload.periods,
      rowsByPeriod: payload.rowsByPeriod,
      periodErrors: payload.periodErrors,
      fallbackUsed: payload.fallbackUsed === true,
      shadowMode: SHADOW_MODE,
      refreshUnhealthy: REFRESH_UNHEALTHY,
      ohlcvFallbackEnabled: OHLCV_FALLBACK_ENABLED,
      ohlcvTimeoutMs: OHLCV_TIMEOUT_MS,
      vectorbtEnabled: VECTORBT_ENABLED,
      vectorbtTimeoutMs: VECTORBT_TIMEOUT_MS,
      qualityGate: GATE,
      qualityRows: payload.qualityRows || [],
      qualityRowSelection: payload.qualityRowSelection || null,
      qualityRowSelectionPolicy: payload.qualityRowSelectionPolicy || null,
      totalTrades: payload.totalTrades ?? null,
      minPeriodTrades: payload.minPeriodTrades ?? null,
      stablePeriodCount: payload.stablePeriodCount ?? null,
      lowTradeShortWindowTolerated: payload.lowTradeShortWindowTolerated === true,
      sharpeOos: payload.sharpeOos ?? null,
      sharpeIs: payload.sharpeIs ?? null,
      sharpeOosDeflated: payload.sharpeOosDeflated ?? null,
      overfitGap: payload.overfitGap ?? null,
      nGridTrials: payload.nGridTrials ?? null,
      walkForwardSharpe: payload.walkForwardSharpe ?? null,
      nObsOos: payload.nObsOos ?? null,
      totalTradesOos: payload.totalTradesOos ?? null,
      oosStatus: payload.oosStatus ?? null,
      selectionMethod: payload.selectionMethod ?? null,
      foldCount: payload.foldCount ?? null,
    }),
    payload.sharpeOos ?? null,
    payload.sharpeIs ?? null,
    payload.sharpeOosDeflated ?? null,
    payload.overfitGap ?? null,
    payload.nGridTrials ?? null,
    payload.walkForwardSharpe ?? null,
    payload.nObsOos ?? null,
    payload.totalTradesOos ?? null,
    payload.oosStatus ?? null,
    payload.selectionMethod ?? null,
    payload.foldCount ?? null,
  ]);
}

function backtestAuditScore(payload: any = {}) {
  return payload.wouldBlock ? 0 : 1;
}

async function recordPredictiveAudit(symbol: string, market: string, payload: any, dryRun = false) {
  if (dryRun) return;
  await db.run(`
    INSERT INTO predictive_validation_log
      (symbol, market, decision, score, threshold, component_coverage,
       blocked_reason, components, missing_components, candidate_snapshot)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb)
  `, [
    symbol,
    market,
    payload.wouldBlock ? 'would_block_backtest' : 'pass_backtest',
    backtestAuditScore(payload),
    0.5,
    null,
    payload.reasons?.join(',') || null,
    JSON.stringify({ backtest: { fresh: payload.fresh, healthy: payload.healthy, sharpe: payload.sharpe } }),
    JSON.stringify([]),
    JSON.stringify({ symbol, market, gateStatus: payload.gateStatus, shadowMode: SHADOW_MODE }),
  ]).catch(() => null);
}

function evaluateTop30GateForCandidate(candidate: any, universe: any = null) {
  const market = normalizeMarket(candidate?.market || 'crypto');
  if (market !== 'crypto') return { ok: true, blocked: false, reason: 'non_crypto_market', rank: null };
  return evaluateBinanceTopVolumeUniverseGate(candidate?.symbol, universe);
}

async function recordTop30BacktestBlock(candidate: any, gate: any, dryRun = false) {
  const symbol = String(candidate.symbol || '').toUpperCase();
  const market = normalizeMarket(candidate.market || 'crypto');
  const payload = {
    fresh: false,
    healthy: false,
    sharpe: null,
    maxDrawdown: null,
    winRate: null,
    gateStatus: 'would_block_top30_universe',
    wouldBlock: true,
    reasons: [BINANCE_TOP_VOLUME_BLOCK_REASON],
    periods: [],
    rowsByPeriod: {},
    top30Gate: gate,
  };
  await upsertStatus(symbol, market, payload, dryRun).catch(() => null);
  await recordPredictiveAudit(symbol, market, payload, dryRun).catch(() => null);
  return {
    symbol,
    market,
    skipped: false,
    gateStatus: payload.gateStatus,
    healthy: false,
    fresh: false,
    wouldBlock: true,
    reasons: payload.reasons,
    binanceTop30Rank: gate.rank,
    inBinanceTop30Universe: false,
    top30Blocker: BINANCE_TOP_VOLUME_BLOCK_REASON,
    error: null,
  };
}

async function refreshCandidate(symbol: string, market: string, periods: number[], options: any = {}) {
  const { dryRun = false, fixture = false, force = false, deadlineAt = null } = options;
  const existing = await getBacktestStatus(symbol, market);
  const existingHealthy = existing?.healthy === true || String(existing?.healthy).toLowerCase() === 'true';
  const existingWouldBlock = existing?.would_block === true || String(existing?.would_block).toLowerCase() === 'true';
  const existingFresh = existing && !isStale(existing.last_backtest_at);
  const existingRefreshDue = isRefreshDue(existing?.next_refresh_at);
  if (!force && !fixture && existingFresh && (existingHealthy || !REFRESH_UNHEALTHY || !existingRefreshDue)) {
    return {
      symbol,
      market,
      skipped: true,
      gateStatus: existing.gate_status,
      healthy: existing.healthy,
      fresh: true,
      wouldBlock: existingWouldBlock,
      reasons: parseJsonArray(existing.block_reasons),
      error: null,
    };
  }

  try {
    const rowsByPeriod: any = {};
    const periodErrors: any = {};
    const allRows = [];
    let fallbackUsed = false;
    let budgetPartial = false;
    for (const days of periods) {
      const remainingRuntimeMs = deadlineAt == null ? null : deadlineAt - Date.now();
      if (remainingRuntimeMs != null && remainingRuntimeMs <= 1_000) {
        periodErrors[String(days)] = `runtime_budget_stop_before_period(remainingMs=${Math.max(0, remainingRuntimeMs)})`;
        budgetPartial = true;
        break;
      }
      const vectorbtTimeoutMs = remainingRuntimeMs == null
        ? VECTORBT_TIMEOUT_MS
        : Math.max(1_000, Math.min(VECTORBT_TIMEOUT_MS, remainingRuntimeMs));
      let rows = fixture
        ? fixtureRows(symbol)
        : VECTORBT_ENABLED
          ? runVectorBtGrid(symbol, days, { timeoutMs: vectorbtTimeoutMs })
          : { status: 'skipped', message: 'vectorbt_disabled' };
      if (!Array.isArray(rows)) {
        periodErrors[String(days)] = rows?.message || rows?.error || 'vectorbt_no_rows';
        rows = [];
      }
      if (!fixture && !rowsHaveUsableTrades(rows)) {
        const fallbackRemainingMs = deadlineAt == null ? null : deadlineAt - Date.now();
        if (fallbackRemainingMs != null && fallbackRemainingMs <= OHLCV_TIMEOUT_MS + 1_000) {
          periodErrors[String(days)] = `${periodErrors[String(days)] || 'vectorbt_no_usable_rows'}; runtime_budget_stop_before_fallback(remainingMs=${Math.max(0, fallbackRemainingMs)},requiredMs=${OHLCV_TIMEOUT_MS + 1_000})`;
          budgetPartial = true;
          break;
        }
        const fallbackTimeoutMs = fallbackRemainingMs == null
          ? OHLCV_TIMEOUT_MS
          : Math.max(1_000, Math.min(OHLCV_TIMEOUT_MS, fallbackRemainingMs));
        const fallbackRows = await runOhlcvFallbackBacktest(symbol, market, days, { timeoutMs: fallbackTimeoutMs }).catch((error) => {
          periodErrors[String(days)] = `${periodErrors[String(days)] || 'vectorbt_no_usable_rows'}; fallback_error=${error?.message || error}`;
          if (fallbackRemainingMs != null && fallbackTimeoutMs < OHLCV_TIMEOUT_MS) budgetPartial = true;
          return [];
        });
        if (Array.isArray(fallbackRows) && fallbackRows.length > 0) {
          rows = fallbackRows;
          fallbackUsed = true;
        }
        if (fallbackRemainingMs != null && Date.now() >= deadlineAt - 1_000 && !rowsHaveUsableTrades(rows)) {
          budgetPartial = true;
          break;
        }
      }
      if (Array.isArray(rows)) {
        rowsByPeriod[String(days)] = rows;
        allRows.push(...rows.map((row) => ({ ...row, walk_forward_days: days })));
      }
    }
    const quality = evaluateQuality(allRows, market);
    if (budgetPartial) {
      quality.healthy = false;
      quality.wouldBlock = true;
      quality.gateStatus = 'would_block_unstable_backtest';
      quality.reasons = [...(quality.reasons || []), `backtest_runtime_budget_partial(periods_processed=${Object.keys(rowsByPeriod).length},periods_requested=${periods.length})`];
    }
    const payload = { fresh: true, ...quality, periods, rowsByPeriod, periodErrors, fallbackUsed };
    await upsertStatus(symbol, market, payload, dryRun);
    await recordPredictiveAudit(symbol, market, payload, dryRun);
    return {
      symbol,
      market,
      skipped: false,
      gateStatus: quality.gateStatus,
      healthy: quality.healthy,
      fresh: true,
      wouldBlock: quality.wouldBlock,
      reasons: quality.reasons,
      fallbackUsed,
      vectorbtEnabled: VECTORBT_ENABLED,
      error: null,
    };
  } catch (error) {
    const errMsg = String(error?.message || error);
    const payload = {
      fresh: false,
      healthy: false,
      sharpe: null,
      maxDrawdown: null,
      winRate: null,
      gateStatus: 'would_block_error',
      wouldBlock: true,
      reasons: [errMsg],
      periods,
      rowsByPeriod: {},
    };
    await upsertStatus(symbol, market, payload, dryRun).catch(() => null);
    await recordPredictiveAudit(symbol, market, payload, dryRun).catch(() => null);
    return { symbol, market, skipped: false, gateStatus: 'would_block_error', healthy: false, fresh: false, wouldBlock: true, reasons: [errMsg], error: errMsg };
  }
}

export async function runCandidateBacktestRefresh(options: any = {}): Promise<any> {
  const dryRun = options.dryRun === true;
  const fixture = options.fixture === true;
  const json = options.json === true;
  const progress = options.progress === true;
  const startedAt = Date.now();
  const periods = periodsFrom(options.periods);
  const limit = Math.max(1, Number(options.limit || process.env.LUNA_CANDIDATE_BACKTEST_LIMIT || 100));
  const market = normalizeMarket(options.market || process.env.LUNA_CANDIDATE_BACKTEST_MARKET || 'all');
  const force = options.force === true || String(process.env.LUNA_CANDIDATE_BACKTEST_FORCE || '').toLowerCase() === 'true';
  const requestedSymbols = symbolsFrom(options.symbols || process.env.LUNA_CANDIDATE_BACKTEST_SYMBOLS || '');
  const maxSymbols = optionalPositiveInt(options.maxSymbols ?? process.env.LUNA_CANDIDATE_BACKTEST_MAX_SYMBOLS, null);
  const maxRuntimeMs = optionalNonNegativeInt(options.maxRuntimeMs ?? process.env.LUNA_CANDIDATE_BACKTEST_MAX_RUNTIME_MS, null);
  if (!dryRun) {
    await db.initSchema();
    await ensureCandidateBacktestSchema();
  }

  const candidates = fixture
    ? [{ symbol: 'BTC/USDT', market: 'crypto' }, { symbol: 'NEG/USDT', market: 'crypto' }]
    : await getActiveCandidatesByMarket({ limit, market });
  const binanceTopVolumeUniverse = fixture
    ? buildFixtureBinanceTopVolumeUniverse()
    : await getCachedBinanceTopVolumeUniverse().catch((error) => ({
      source: 'binance_top30_unavailable',
      limit: 30,
      symbols: [],
      ranks: {},
      error: String(error?.message || error),
    }));
  const selectedCandidates = selectRequestedCandidates(candidates, requestedSymbols, market);
  const prioritizedCandidates = requestedSymbols.length
    ? selectedCandidates
    : await prioritizeCandidatesForBacktest(selectedCandidates);
  const scheduledCandidates = requestedSymbols.length
    ? prioritizedCandidates
    : interleaveCandidatesByMarket(prioritizedCandidates);
  const budgetedCandidates = maxSymbols == null
    ? scheduledCandidates
    : scheduledCandidates.slice(0, maxSymbols);

  if (!json) console.log(`[luna-backtest-refresh] 활성 후보 ${budgetedCandidates.length}/${candidates.length}건 market=${market} (shadow=${SHADOW_MODE}, dryRun=${dryRun})`);

  const results = [];
  let budgetStopped = false;
  let skippedByRuntimeBudget = 0;
  const emitProgress = (message: string) => {
    if (progress) console.error(`[luna-backtest-refresh] ${message}`);
  };
  for (let index = 0; index < budgetedCandidates.length; index += 1) {
    const { symbol, market } = budgetedCandidates[index];
    const elapsedMs = Date.now() - startedAt;
    if (maxRuntimeMs != null && elapsedMs >= maxRuntimeMs) {
      budgetStopped = true;
      skippedByRuntimeBudget = budgetedCandidates.length - index;
      emitProgress(`runtime-budget-stop processed=${results.length} skipped=${skippedByRuntimeBudget} elapsedMs=${elapsedMs} maxRuntimeMs=${maxRuntimeMs}`);
      break;
    }
    emitProgress(`start ${index + 1}/${budgetedCandidates.length} symbol=${symbol} market=${market} elapsedMs=${elapsedMs}`);
    const top30Gate = evaluateTop30GateForCandidate({ symbol, market }, binanceTopVolumeUniverse);
    if (top30Gate.blocked) {
      results.push(await recordTop30BacktestBlock({ symbol, market }, top30Gate, dryRun));
      emitProgress(`blocked-top30 symbol=${symbol} rank=${top30Gate.rank ?? 'n/a'}`);
      continue;
    }
    const deadlineAt = maxRuntimeMs == null ? null : startedAt + maxRuntimeMs;
    const result = await refreshCandidate(symbol, market, periods, { dryRun, fixture, force, deadlineAt });
    result.binanceTop30Rank = top30Gate.rank;
    result.inBinanceTop30Universe = normalizeMarket(market) === 'crypto' ? top30Gate.ok === true : null;
    results.push(result);
    emitProgress(`done symbol=${symbol} gate=${result.gateStatus} elapsedMs=${Date.now() - startedAt}`);
    if (!json) {
      const icon = result.skipped ? 'skip' : result.wouldBlock ? 'would-block' : 'pass';
      console.log(`[luna-backtest-refresh] ${icon} ${symbol} gate=${result.gateStatus}`);
    }
  }

  const passed = results.filter((r) => r.gateStatus === 'pass').length;
  const wouldBlocked = results.filter((r) => r.wouldBlock || String(r.gateStatus).startsWith('would_block')).length;
  const skipped = results.filter((r) => r.skipped).length;
  const payload = {
    ok: true,
    shadowMode: SHADOW_MODE,
    dryRun,
    fixture,
    writeMode: dryRun ? 'dry-run' : 'shadow-apply',
    market,
    periods,
    force,
    requestedSymbols,
    total: results.length,
    passed,
    wouldBlocked,
    skipped,
    elapsedMs: Date.now() - startedAt,
    candidateBudget: {
      requested: requestedSymbols.length || null,
      discovered: candidates.length,
      selectedBeforeBudget: selectedCandidates.length,
      selected: budgetedCandidates.length,
      processed: results.length,
      orderingPolicy: requestedSymbols.length ? 'requested_symbol_order' : 'backtest_due_priority_then_market_round_robin_score_desc',
      maxSymbols,
      maxRuntimeMs,
      truncatedByMaxSymbols: maxSymbols != null && scheduledCandidates.length > budgetedCandidates.length,
      budgetStopped,
      skippedByRuntimeBudget,
    },
    gateThresholds: GATE,
    results,
  };

  if (!json) console.log(`[luna-backtest-refresh] 완료: pass=${passed} wouldBlock=${wouldBlocked} skip=${skipped}`);
  return json ? payload : JSON.stringify(payload, null, 2);
}

export const __test = {
  buildOhlcvMomentumBacktestRows,
  buildOfficialDomesticOhlcvRows,
  evaluateQuality,
  interleaveCandidatesByMarket,
  rowsHaveUsableTrades,
  selectBestQualityRows,
};

export { evaluateCandidateBacktestStatus };

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runCandidateBacktestRefresh({
      periods: argValue('periods', argValue('days', '30,90,180')),
      limit: Number(argValue('limit', process.env.LUNA_CANDIDATE_BACKTEST_LIMIT || 100)),
      market: argValue('market', process.env.LUNA_CANDIDATE_BACKTEST_MARKET || 'all'),
      symbols: argValue('symbols', process.env.LUNA_CANDIDATE_BACKTEST_SYMBOLS || ''),
      maxSymbols: argValue('max-symbols', process.env.LUNA_CANDIDATE_BACKTEST_MAX_SYMBOLS || ''),
      maxRuntimeMs: argValue('max-runtime-ms', process.env.LUNA_CANDIDATE_BACKTEST_MAX_RUNTIME_MS || ''),
      dryRun: hasFlag('dry-run'),
      fixture: hasFlag('fixture'),
      force: hasFlag('force'),
      progress: hasFlag('progress'),
      json: hasFlag('json'),
    }),
    onSuccess: async (result) => {
      if (typeof result === 'string') console.log(result);
      else console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: 'runtime-luna-candidate-backtest-refresh error:',
  });
}
