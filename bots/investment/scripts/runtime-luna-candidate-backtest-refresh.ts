#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { runVectorBtGrid } from '../shared/vectorbt-runner.ts';
import { getOHLCV } from '../shared/ohlcv-fetcher.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { ensureCandidateBacktestSchema, evaluateCandidateBacktestStatus } from '../shared/candidate-backtest-gate.ts';
import { exchangeForLunaPhase2Market } from '../shared/luna-weight-vector.ts';

const SHADOW_MODE = process.env.LUNA_CANDIDATE_BACKTEST_SHADOW_MODE !== 'false';
const STALE_HOURS = Number(process.env.LUNA_BACKTEST_STALE_HOURS || 24);
const REFRESH_UNHEALTHY = process.env.LUNA_BACKTEST_REFRESH_UNHEALTHY !== 'false';
const OHLCV_FALLBACK_ENABLED = process.env.LUNA_BACKTEST_OHLCV_FALLBACK_ENABLED !== 'false';
const VECTORBT_ENABLED = process.env.LUNA_BACKTEST_VECTORBT_ENABLED !== 'false';
const VECTORBT_TIMEOUT_MS = Math.max(5_000, Number(process.env.LUNA_VECTORBT_TIMEOUT_MS || 30_000));

const GATE = {
  MIN_SHARPE: 0,
  MAX_DRAWDOWN: 30,
  MIN_WIN_RATE: 30,
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
  const params: any[] = [];
  const marketWhere = normalizedMarket === 'all'
    ? ''
    : `AND market = $${params.push(normalizedMarket)}`;
  params.push(limit);
  return db.query(
    `WITH active_candidates AS (
      SELECT DISTINCT ON (symbol, market)
             symbol, market, score, discovered_at
        FROM candidate_universe
       WHERE expires_at > NOW()
         ${marketWhere}
       ORDER BY symbol, market, score DESC, discovered_at DESC
    )
    SELECT symbol, market
      FROM active_candidates
     ORDER BY score DESC, discovered_at DESC
     LIMIT $${params.length}`,
    params,
  ).catch(() => []);
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

function rowsHaveUsableTrades(rows: any[]) {
  return Array.isArray(rows) && rows.some((row) => (!row?.status || row.status === 'ok') && safeNum(row?.total_trades) > 0);
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

async function runOhlcvFallbackBacktest(symbol: string, market: string, days: number) {
  if (!OHLCV_FALLBACK_ENABLED) return [];
  const exchange = exchangeForLunaPhase2Market(market);
  const timeframe = process.env.LUNA_BACKTEST_OHLCV_FALLBACK_TIMEFRAME || (market === 'crypto' ? '1h' : '1d');
  const from = new Date(Date.now() - Math.max(7, days) * 24 * 3600 * 1000).toISOString();
  const rows = await getOHLCV(symbol, timeframe, from, null, exchange).catch(() => []);
  return buildOhlcvMomentumBacktestRows(rows, days, market);
}

function evaluateQuality(rows: any[]) {
  const usable = (rows || []).filter((r) => (!r?.status || r.status === 'ok') && safeNum(r?.total_trades) > 0);
  if (usable.length === 0) {
    return {
      fresh: false,
      sharpe: null,
      maxDrawdown: null,
      winRate: null,
      healthy: false,
      gateStatus: 'would_block_no_data',
      wouldBlock: true,
      reasons: ['backtest_no_data'],
    };
  }

  const avgSharpe = usable.reduce((s, r) => s + safeNum(r?.sharpe_ratio), 0) / usable.length;
  const maxDD = Math.max(...usable.map((r) => Math.abs(safeNum(r?.max_drawdown))));
  const avgWinRate = usable.reduce((s, r) => s + safeNum(r?.win_rate), 0) / usable.length;
  const reasons: string[] = [];
  if (avgSharpe < GATE.MIN_SHARPE) reasons.push(`sharpe_negative(${avgSharpe.toFixed(2)})`);
  if (maxDD > GATE.MAX_DRAWDOWN) reasons.push(`drawdown_high(${maxDD.toFixed(1)}%)`);
  if (avgWinRate < GATE.MIN_WIN_RATE) reasons.push(`win_rate_low(${avgWinRate.toFixed(1)}%)`);

  const wouldBlock = reasons.some((r) => r.startsWith('sharpe_') || r.startsWith('win_rate_'));
  return {
    sharpe: Number(avgSharpe.toFixed(4)),
    maxDrawdown: Number(maxDD.toFixed(4)),
    winRate: Number(avgWinRate.toFixed(4)),
    healthy: !wouldBlock,
    gateStatus: wouldBlock ? 'would_block_unhealthy' : 'pass',
    wouldBlock,
    reasons,
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
       block_reasons, backtest_run_metadata, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8,$9,$10,$11,$12::jsonb,$13::jsonb,NOW())
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
      updated_at = NOW()
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
      vectorbtEnabled: VECTORBT_ENABLED,
      vectorbtTimeoutMs: VECTORBT_TIMEOUT_MS,
      qualityGate: GATE,
    }),
  ]);
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
    payload.sharpe,
    0,
    null,
    payload.reasons?.join(',') || null,
    JSON.stringify({ backtest: { fresh: payload.fresh, healthy: payload.healthy, sharpe: payload.sharpe } }),
    JSON.stringify([]),
    JSON.stringify({ symbol, market, gateStatus: payload.gateStatus, shadowMode: SHADOW_MODE }),
  ]).catch(() => null);
}

async function refreshCandidate(symbol: string, market: string, periods: number[], options: any = {}) {
  const { dryRun = false, fixture = false } = options;
  const existing = await getBacktestStatus(symbol, market);
  const existingHealthy = existing?.healthy === true || String(existing?.healthy).toLowerCase() === 'true';
  const existingWouldBlock = existing?.would_block === true || String(existing?.would_block).toLowerCase() === 'true';
  const existingFresh = existing && !isStale(existing.last_backtest_at);
  const existingRefreshDue = isRefreshDue(existing?.next_refresh_at);
  if (!fixture && existingFresh && (existingHealthy || !REFRESH_UNHEALTHY || !existingRefreshDue)) {
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
    for (const days of periods) {
      let rows = fixture
        ? fixtureRows(symbol)
        : VECTORBT_ENABLED
          ? runVectorBtGrid(symbol, days, { timeoutMs: VECTORBT_TIMEOUT_MS })
          : { status: 'skipped', message: 'vectorbt_disabled' };
      if (!Array.isArray(rows)) {
        periodErrors[String(days)] = rows?.message || rows?.error || 'vectorbt_no_rows';
        rows = [];
      }
      if (!fixture && !rowsHaveUsableTrades(rows)) {
        const fallbackRows = await runOhlcvFallbackBacktest(symbol, market, days).catch((error) => {
          periodErrors[String(days)] = `${periodErrors[String(days)] || 'vectorbt_no_usable_rows'}; fallback_error=${error?.message || error}`;
          return [];
        });
        if (Array.isArray(fallbackRows) && fallbackRows.length > 0) {
          rows = fallbackRows;
          fallbackUsed = true;
        }
      }
      if (Array.isArray(rows)) {
        rowsByPeriod[String(days)] = rows;
        allRows.push(...rows.map((row) => ({ ...row, walk_forward_days: days })));
      }
    }
    const quality = evaluateQuality(allRows);
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
  const periods = periodsFrom(options.periods);
  const limit = Math.max(1, Number(options.limit || process.env.LUNA_CANDIDATE_BACKTEST_LIMIT || 100));
  const market = normalizeMarket(options.market || process.env.LUNA_CANDIDATE_BACKTEST_MARKET || 'all');
  if (!dryRun) {
    await db.initSchema();
    await ensureCandidateBacktestSchema();
  }

  const candidates = fixture
    ? [{ symbol: 'BTC/USDT', market: 'crypto' }, { symbol: 'NEG/USDT', market: 'crypto' }]
    : await getActiveCandidatesByMarket({ limit, market });

  if (!json) console.log(`[luna-backtest-refresh] 활성 후보 ${candidates.length}건 market=${market} (shadow=${SHADOW_MODE}, dryRun=${dryRun})`);

  const results = [];
  for (const { symbol, market } of candidates) {
    const result = await refreshCandidate(symbol, market, periods, { dryRun, fixture });
    results.push(result);
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
    total: results.length,
    passed,
    wouldBlocked,
    skipped,
    gateThresholds: GATE,
    results,
  };

  if (!json) console.log(`[luna-backtest-refresh] 완료: pass=${passed} wouldBlock=${wouldBlocked} skip=${skipped}`);
  return json ? payload : JSON.stringify(payload, null, 2);
}

export const __test = {
  buildOhlcvMomentumBacktestRows,
  evaluateQuality,
  rowsHaveUsableTrades,
};

export { evaluateCandidateBacktestStatus };

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runCandidateBacktestRefresh({
      periods: argValue('periods', argValue('days', '30,90,180')),
      limit: Number(argValue('limit', process.env.LUNA_CANDIDATE_BACKTEST_LIMIT || 100)),
      market: argValue('market', process.env.LUNA_CANDIDATE_BACKTEST_MARKET || 'all'),
      dryRun: hasFlag('dry-run'),
      fixture: hasFlag('fixture'),
      json: hasFlag('json'),
    }),
    onSuccess: async (result) => {
      if (typeof result === 'string') console.log(result);
      else console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: 'runtime-luna-candidate-backtest-refresh error:',
  });
}
