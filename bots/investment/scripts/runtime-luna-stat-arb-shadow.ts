#!/usr/bin/env node

import * as db from '../shared/db.ts';
import { listActiveEntryTriggers } from '../shared/luna-discovery-entry-store.ts';
import {
  buildMeanReversionShadow,
  buildPairsTradingShadow,
  defaultStatArbPairs,
  marketForStatArbExchange,
  normalizeStatArbExchange,
  normalizeStatArbShadowRow,
} from '../shared/stat-arb-shadow.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  getDomesticDailyPriceBars,
  getOverseasDailyPriceBars,
} from '../shared/kis-client.ts';

const CONFIRM_TOKEN = 'luna-stat-arb-shadow';

type AnyRecord = Record<string, any>;
type PriceBar = {
  close: number;
  high: number;
  low: number;
  volume: number;
};
type StatArbOptions = {
  apply: boolean;
  force: boolean;
  json: boolean;
  confirm: string | null;
  exchanges: string[];
  symbol: string | null;
  strategy: string;
  limit: number;
  hours: number;
  ttlMinutes: number;
  lookbackDays: number;
};
type RuntimeDeps = {
  query?: (sql: string, params?: any[]) => Promise<any[]> | any[];
  run?: (sql: string, params?: any[]) => Promise<any> | any;
  initSchema?: () => Promise<any> | any;
  fetchBars?: (symbol: string, exchange: string, options?: AnyRecord) => Promise<PriceBar[]> | PriceBar[];
  listActiveEntryTriggers?: (options: AnyRecord) => Promise<AnyRecord[]> | AnyRecord[];
};
type MeanReversionSymbolOptions = {
  exchange: string;
  symbol: string | null;
  limit: number;
  hours: number;
};

function argValue(name: string, fallback: string | number | null = null, argv = process.argv.slice(2)): string | null {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback == null ? null : String(fallback);
}

function parseList(value: unknown, fallback: string[] = []): string[] {
  const list = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, arr) => arr.indexOf(item) === index);
  return list.length ? list : fallback;
}

function parseArgs(argv = process.argv.slice(2)): StatArbOptions {
  const rawExchanges = argValue('exchanges', argValue('exchange', 'binance,kis,kis_overseas', argv), argv);
  return {
    apply: argv.includes('--apply'),
    force: argv.includes('--force'),
    json: argv.includes('--json'),
    confirm: argValue('confirm', '', argv),
    exchanges: [...new Set(parseList(rawExchanges, ['binance']).map(normalizeStatArbExchange))],
    symbol: argValue('symbol', null, argv),
    strategy: String(argValue('strategy', 'all', argv) || 'all').toLowerCase(),
    limit: Math.max(1, Number(argValue('limit', 20, argv)) || 20),
    hours: Math.max(1, Number(argValue('hours', 24, argv)) || 24),
    ttlMinutes: Math.max(15, Number(argValue('ttl-minutes', 240, argv)) || 240),
    lookbackDays: Math.max(20, Number(argValue('lookback-days', 90, argv)) || 90),
  };
}

function freshEnough(row: AnyRecord | null, ttlMinutes: number, force = false): boolean {
  if (force || !row?.observed_at) return false;
  const ageMs = Date.now() - new Date(row.observed_at).getTime();
  return ageMs >= 0 && ageMs < ttlMinutes * 60 * 1000;
}

function parseObject(value: unknown, fallback: AnyRecord = {}): AnyRecord {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function binanceSymbol(symbol = ''): string {
  return String(symbol || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

async function fetchJson(url: string, timeoutMs = 5000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`http_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchStatArbBars(symbol: string, exchange: string, { lookbackDays = 90 }: AnyRecord = {}): Promise<PriceBar[]> {
  const limit = Math.max(20, Math.min(180, Number(lookbackDays || 90)));
  if (exchange === 'kis') {
    return normalizePriceBars(await getDomesticDailyPriceBars(symbol, { days: limit }));
  }
  if (exchange === 'kis_overseas') {
    return normalizePriceBars(await getOverseasDailyPriceBars(symbol, { days: limit }));
  }
  const normalized = binanceSymbol(symbol);
  if (!normalized) return [];
  const rows = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(normalized)}&interval=1d&limit=${limit}`)
    .catch(() => []);
  return Array.isArray(rows)
    ? rows.map((row) => ({
      close: Number(row?.[4]),
      high: Number(row?.[2]),
      low: Number(row?.[3]),
      volume: Number(row?.[5]),
    })).filter((bar) => Number.isFinite(bar.close) && bar.close > 0)
    : [];
}

function normalizePriceBars(rows: AnyRecord[] = []): PriceBar[] {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      close: Number(row?.close ?? row?.stck_clpr ?? row?.clos ?? row?.price),
      high: Number(row?.high ?? row?.stck_hgpr ?? row?.close ?? row?.price),
      low: Number(row?.low ?? row?.stck_lwpr ?? row?.close ?? row?.price),
      volume: Number(row?.volume ?? row?.acml_vol ?? row?.tvol ?? 0),
    }))
    .filter((bar) => Number.isFinite(bar.close) && bar.close > 0);
}

function priceHistorySource(exchange: string): string {
  if (exchange === 'binance') return 'binance_public_1d_klines';
  if (exchange === 'kis') return 'kis_domestic_daily_price';
  if (exchange === 'kis_overseas') return 'kis_overseas_daily_price';
  return 'unknown_price_history';
}

async function latestStatArbShadow(
  queryFn: NonNullable<RuntimeDeps['query']>,
  { strategyType, symbols, exchange, ttlMinutes, force }: {
    strategyType: string;
    symbols: string[];
    exchange: string;
    ttlMinutes: number;
    force: boolean;
  },
) {
  if (!strategyType || !exchange || !Array.isArray(symbols) || symbols.length === 0) return null;
  const rows = await Promise.resolve(queryFn(
    `SELECT *
       FROM investment.luna_stat_arb_shadow
      WHERE strategy_type = $1
        AND exchange = $2
        AND symbols = $3::jsonb
      ORDER BY observed_at DESC
      LIMIT 1`,
    [strategyType, exchange, JSON.stringify(symbols)],
  )).catch(() => []);
  const row = Array.isArray(rows) ? rows[0] || null : null;
  return freshEnough(row, ttlMinutes, force) ? normalizeStatArbShadowRow(row) : null;
}

function candidateFromTrigger(trigger: AnyRecord = {}, exchange = 'binance') {
  const triggerContext = parseObject(trigger.trigger_context, trigger.trigger_context || {});
  const triggerMeta = parseObject(trigger.trigger_meta, trigger.trigger_meta || {});
  return {
    symbol: trigger.symbol,
    exchange,
    market: marketForStatArbExchange(exchange),
    bars: triggerMeta.bars || triggerContext.bars || triggerMeta.ohlcv || triggerContext.ohlcv || [],
  };
}

async function fetchMeanReversionSymbols(
  { exchange, symbol, limit, hours }: MeanReversionSymbolOptions,
  deps: RuntimeDeps,
): Promise<string[]> {
  if (symbol) return [symbol];
  const defaults = [...new Set(defaultStatArbPairs(exchange).flat())];
  const listFn = (deps.listActiveEntryTriggers || listActiveEntryTriggers) as (options: AnyRecord) => Promise<AnyRecord[]> | AnyRecord[];
  const since = new Date(Date.now() - Math.max(1, Number(hours || 24)) * 60 * 60 * 1000).toISOString();
  const rows = await Promise.resolve(listFn({
    exchange,
    states: ['armed', 'waiting', 'fired'],
    limit,
    updatedAfter: since,
    orderBy: 'updated_desc',
  })).catch(() => []);
  const active = (Array.isArray(rows) ? rows : []).map((row) => candidateFromTrigger(row, exchange).symbol).filter(Boolean);
  return [...new Set([...defaults, ...active])].slice(0, Math.max(1, Number(limit || 20)));
}

async function buildPairRows(exchange: string, options: StatArbOptions, deps: RuntimeDeps) {
  const queryFn = (deps.query || db.query) as NonNullable<RuntimeDeps['query']>;
  const fetchBars = deps.fetchBars || fetchStatArbBars;
  const rows: AnyRecord[] = [];
  const pairs = (defaultStatArbPairs(exchange) as string[][])
    .filter((pair) => !options.symbol || pair.includes(options.symbol));
  for (const pair of pairs) {
    const existing = await latestStatArbShadow(queryFn, {
      strategyType: 'pairs_trading',
      symbols: pair,
      exchange,
      ttlMinutes: options.ttlMinutes,
      force: options.force,
    });
    if (existing) {
      rows.push({ ...existing, status: 'cached', reason: 'fresh_shadow_exists', written: false });
      continue;
    }
    const [barsA, barsB] = await Promise.all([
      Promise.resolve(fetchBars(pair[0], exchange, { lookbackDays: options.lookbackDays })).catch(() => []),
      Promise.resolve(fetchBars(pair[1], exchange, { lookbackDays: options.lookbackDays })).catch(() => []),
    ]);
    rows.push({
      ...buildPairsTradingShadow({
        symbols: pair,
        exchange,
        barsA,
        barsB,
      }, { source: priceHistorySource(exchange) }),
      status: 'planned',
      reason: options.apply && options.confirm === CONFIRM_TOKEN ? 'write_planned' : 'apply_confirm_required',
      written: false,
    });
  }
  return rows;
}

async function buildMeanReversionRows(exchange: string, options: StatArbOptions, deps: RuntimeDeps) {
  const queryFn = (deps.query || db.query) as NonNullable<RuntimeDeps['query']>;
  const fetchBars = deps.fetchBars || fetchStatArbBars;
  const symbols = await fetchMeanReversionSymbols({
    exchange,
    symbol: options.symbol,
    limit: options.limit,
    hours: options.hours,
  }, deps);
  const rows: AnyRecord[] = [];
  for (const symbol of symbols) {
    const existing = await latestStatArbShadow(queryFn, {
      strategyType: 'mean_reversion',
      symbols: [symbol],
      exchange,
      ttlMinutes: options.ttlMinutes,
      force: options.force,
    });
    if (existing) {
      rows.push({ ...existing, status: 'cached', reason: 'fresh_shadow_exists', written: false });
      continue;
    }
    const bars = await Promise.resolve(fetchBars(symbol, exchange, { lookbackDays: options.lookbackDays })).catch(() => []);
    rows.push({
      ...buildMeanReversionShadow({
        symbol,
        exchange,
        bars,
      }, { source: priceHistorySource(exchange) }),
      status: 'planned',
      reason: options.apply && options.confirm === CONFIRM_TOKEN ? 'write_planned' : 'apply_confirm_required',
      written: false,
    });
  }
  return rows;
}

async function insertStatArbShadow(runFn: NonNullable<RuntimeDeps['run']>, payload: AnyRecord) {
  await Promise.resolve(runFn(
    `INSERT INTO investment.luna_stat_arb_shadow
       (strategy_type, symbols, exchange, market, pair_metrics, mean_reversion_metrics, signal, z_score, confidence, data_health, context_evidence, shadow_only)
     VALUES ($1,$2::jsonb,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11::jsonb,$12)`,
    [
      payload.strategyType,
      JSON.stringify(payload.symbols || []),
      payload.exchange,
      payload.market,
      JSON.stringify(payload.pairMetrics || {}),
      JSON.stringify(payload.meanReversionMetrics || {}),
      payload.signal,
      payload.zScore,
      payload.confidence,
      payload.dataHealth,
      JSON.stringify(payload.evidence || {}),
      true,
    ],
  ));
}

export async function runLunaStatArbShadow(options: StatArbOptions = parseArgs(), deps: RuntimeDeps = {}) {
  if (process.env.LUNA_STAT_ARB_SHADOW_ENABLED === 'false') {
    return {
      ok: true,
      status: 'luna_stat_arb_shadow_disabled',
      apply: options.apply,
      confirmRequired: CONFIRM_TOKEN,
      rows: [],
    };
  }

  const runFn = (deps.run || db.run) as NonNullable<RuntimeDeps['run']>;
  const initSchema = deps.initSchema || db.initSchema;
  const canWrite = options.apply && options.confirm === CONFIRM_TOKEN;
  if (canWrite && initSchema) {
    await Promise.resolve(initSchema()).catch(() => null);
  }

  const rows: AnyRecord[] = [];
  for (const exchange of options.exchanges) {
    if (options.strategy === 'all' || options.strategy === 'pairs' || options.strategy === 'pairs_trading') {
      rows.push(...await buildPairRows(exchange, options, deps));
    }
    if (options.strategy === 'all' || options.strategy === 'mean_reversion') {
      rows.push(...await buildMeanReversionRows(exchange, options, deps));
    }
  }

  if (canWrite) {
    for (const row of rows.filter((item) => item.status === 'planned' && item.ok)) {
      await insertStatArbShadow(runFn, row);
      row.status = 'written';
      row.reason = 'stat_arb_shadow_written';
      row.written = true;
    }
  }

  const written = rows.filter((row) => row.written).length;
  const cached = rows.filter((row) => row.status === 'cached').length;
  const planned = rows.filter((row) => row.status === 'planned').length;
  const insufficient = rows.filter((row) => row.dataHealth === 'insufficient').length;
  return {
    ok: true,
    status: written > 0
      ? 'luna_stat_arb_shadow_written'
      : planned > 0
        ? 'luna_stat_arb_shadow_planned'
        : cached > 0
          ? 'luna_stat_arb_shadow_cached'
          : 'luna_stat_arb_shadow_skipped',
    apply: options.apply,
    confirmRequired: CONFIRM_TOKEN,
    summary: {
      candidates: rows.length,
      written,
      planned,
      cached,
      insufficient,
      liveMutation: false,
    },
    rows,
  };
}

async function main() {
  const result = await runLunaStatArbShadow(parseArgs());
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${result.status} candidates=${result.summary?.candidates || 0} written=${result.summary?.written || 0}`);
}

if (isDirectExecution(import.meta.url)) {
  await (runCliMain as any)({
    run: main,
    errorPrefix: 'luna stat arb shadow error:',
  });
}
