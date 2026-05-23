#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildOptimalExitAnalysisReport } from '../shared/optimal-exit-analysis.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OUTPUT = path.resolve('output/reports/luna-optimal-exit-analysis-report.json');

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    smoke: argv.includes('--smoke'),
    noWrite: argv.includes('--no-write'),
    output: argv.find((arg) => arg.startsWith('--output='))?.split('=')[1] || DEFAULT_OUTPUT,
    limit: Number(argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || '5000'),
    concurrency: Number(argv.find((arg) => arg.startsWith('--concurrency='))?.split('=')[1] || '5'),
  };
}

function timeMs(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : null;
}

function normalizeMarket(row = {}) {
  const market = String(row.market || '').toLowerCase();
  const exchange = String(row.exchange || '').toLowerCase();
  if (market === 'crypto' || exchange.includes('binance')) return 'crypto';
  if (market === 'domestic' || exchange === 'kis') return 'domestic';
  if (market === 'overseas' || exchange.includes('overseas')) return 'overseas';
  return market || 'unknown';
}

function normalizeBinanceSymbol(symbol = '') {
  return String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0 luna-optimal-exit-analysis',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function parseBinanceKlines(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    time: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  })).filter((row) => row.time > 0 && row.close > 0);
}

async function fetchBinanceDailyBars(symbol, startMs, endMs) {
  const normalized = normalizeBinanceSymbol(symbol);
  if (!normalized) return [];
  const url = new URL('https://api.binance.com/api/v3/klines');
  url.searchParams.set('symbol', normalized);
  url.searchParams.set('interval', '1d');
  url.searchParams.set('startTime', String(Math.max(0, startMs)));
  url.searchParams.set('endTime', String(endMs));
  url.searchParams.set('limit', '1000');
  return parseBinanceKlines(await fetchJson(url.toString()));
}

function parseYahooChart(json = {}) {
  const chart = json.chart?.result?.[0];
  if (!chart) return [];
  const timestamps = chart.timestamp || [];
  const quote = chart.indicators?.quote?.[0] || {};
  return timestamps.map((ts, index) => ({
    time: ts * 1000,
    open: Number(quote.open?.[index] || 0),
    high: Number(quote.high?.[index] || 0),
    low: Number(quote.low?.[index] || 0),
    close: Number(quote.close?.[index] || 0),
    volume: Number(quote.volume?.[index] || 0),
  })).filter((row) => row.time > 0 && row.close > 0);
}

function yahooCandidates(symbol, market) {
  const clean = String(symbol || '').trim().toUpperCase();
  if (!clean) return [];
  if (market === 'domestic' && /^\d{6}$/.test(clean)) return [`${clean}.KS`, `${clean}.KQ`];
  return [clean];
}

async function fetchYahooDailyBars(symbol, market, startMs, endMs) {
  const period1 = Math.max(0, Math.floor(startMs / 1000));
  const period2 = Math.floor(endMs / 1000);
  const errors = [];
  for (const ticker of yahooCandidates(symbol, market)) {
    try {
      const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`);
      url.searchParams.set('period1', String(period1));
      url.searchParams.set('period2', String(period2));
      url.searchParams.set('interval', '1d');
      url.searchParams.set('includePrePost', 'false');
      url.searchParams.set('events', 'div,splits');
      const bars = parseYahooChart(await fetchJson(url.toString()));
      if (bars.length > 0) return bars;
    } catch (err) {
      errors.push(`${ticker}:${err.message}`);
    }
  }
  if (errors.length) throw new Error(errors.join('; '));
  return [];
}

function buildSmokeRows() {
  const entryTime = Date.parse('2026-01-05T00:00:00Z');
  const exitTime = Date.parse('2026-01-12T00:00:00Z');
  return [
    {
      trade_id: 'smoke-late-peak',
      market: 'crypto',
      exchange: 'binance',
      symbol: 'PEAK/USDT',
      status: 'closed',
      direction: 'long',
      entry_time: entryTime,
      exit_time: exitTime,
      entry_price: 10,
      exit_price: 11,
      pnl_percent: 10,
      quality_flag: 'trusted',
      exclude_from_learning: false,
      strategy_family: 'momentum_rotation',
    },
    {
      trade_id: 'smoke-open',
      market: 'overseas',
      exchange: 'kis_overseas',
      symbol: 'QBTS',
      status: 'open',
      direction: 'long',
      entry_time: Date.parse('2026-01-10T00:00:00Z'),
      entry_price: 20,
      quality_flag: 'trusted',
      exclude_from_learning: false,
      strategy_family: 'promotion_ready_shadow',
    },
  ];
}

function buildSmokeBars() {
  const rows = [];
  const closes = [
    7, 7.2, 7.4, 7.6, 7.8, 8, 8.3, 8.8, 9.2, 9.6,
    10, 10.5, 11.5, 13, 16, 20, 18, 15, 12, 11,
    10.8, 10.5, 10.2, 10.1, 10,
  ];
  for (let i = 0; i < closes.length; i += 1) {
    const time = Date.parse('2025-12-25T00:00:00Z') + i * DAY_MS;
    const close = closes[i];
    rows.push({
      time,
      open: close * 0.96,
      high: close * 1.08,
      low: close * 0.92,
      close,
      volume: i === 15 ? 5000 : 1000,
    });
  }
  const openRows = [];
  for (let i = 0; i < 18; i += 1) {
    const time = Date.parse('2025-12-30T00:00:00Z') + i * DAY_MS;
    const close = 18 + i * 0.6;
    openRows.push({ time, open: close - 0.2, high: close + 0.7, low: close - 0.8, close, volume: 1000 + i * 10 });
  }
  return {
    'crypto:PEAK/USDT': rows,
    'overseas:QBTS': openRows,
  };
}

async function loadRows({ limit }) {
  return db.query(
    `SELECT
       trade_id, market, exchange, symbol, status, direction,
       entry_time, exit_time, entry_price, exit_price, entry_value, exit_value,
       pnl_percent, trade_mode, market_regime, strategy_family, execution_origin,
       quality_flag, exclude_from_learning
     FROM investment.trade_journal
     ORDER BY COALESCE(exit_time, entry_time, 0) DESC
     LIMIT $1`,
    [limit],
  );
}

function collectSymbolWindows(rows = [], now = Date.now()) {
  const map = new Map();
  for (const row of rows) {
    const market = normalizeMarket(row);
    const symbol = row.symbol;
    if (!symbol) continue;
    const key = `${market}:${symbol}`;
    const entry = timeMs(row.entry_time);
    const exit = timeMs(row.exit_time);
    const start = Math.max(0, (entry || now) - 90 * DAY_MS);
    const end = Math.max(exit || now, now) + DAY_MS;
    const existing = map.get(key);
    map.set(key, {
      market,
      symbol,
      startMs: existing ? Math.min(existing.startMs, start) : start,
      endMs: existing ? Math.max(existing.endMs, end) : end,
    });
  }
  return [...map.values()];
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
  return out;
}

async function fetchBarsForWindows(windows = [], concurrency = 5) {
  const barsBySymbol = {};
  const errors = [];
  await mapLimit(windows, concurrency, async (item) => {
    const key = `${item.market}:${item.symbol}`;
    try {
      const bars = item.market === 'crypto'
        ? await fetchBinanceDailyBars(item.symbol, item.startMs, item.endMs)
        : await fetchYahooDailyBars(item.symbol, item.market, item.startMs, item.endMs);
      barsBySymbol[key] = bars;
      if (!bars.length) errors.push({ key, reason: 'empty_price_bars' });
    } catch (err) {
      barsBySymbol[key] = [];
      errors.push({ key, reason: err.message || String(err) });
    }
  });
  return { barsBySymbol, errors };
}

export async function runOptimalExitAnalysis(args = parseArgs()) {
  const rows = args.smoke ? buildSmokeRows() : await loadRows({ limit: args.limit });
  const priceData = args.smoke
    ? { barsBySymbol: buildSmokeBars(), errors: [] }
    : await fetchBarsForWindows(collectSymbolWindows(rows), args.concurrency);
  const report = buildOptimalExitAnalysisReport({
    trades: rows,
    barsBySymbol: priceData.barsBySymbol,
    priceFetchErrors: priceData.errors,
  });
  if (!args.noWrite) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, JSON.stringify(report, null, 2));
  }
  return { ...report, output: args.noWrite ? null : args.output, source: args.smoke ? 'smoke_fixture' : 'db_and_public_market_data' };
}

async function main() {
  const args = parseArgs();
  const result = await runOptimalExitAnalysis(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`runtime-luna-optimal-exit-analysis status=${result.status} trades=${result.scope.analyzedTrades}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'runtime-luna-optimal-exit-analysis error:' });
}
