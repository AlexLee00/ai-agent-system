#!/usr/bin/env node

import * as db from '../shared/db.ts';
import { listActiveEntryTriggers } from '../shared/luna-discovery-entry-store.ts';
import {
  buildRlPolicyShadow,
  marketForRlExchange,
  normalizeRlExchange,
  normalizeRlPolicyShadowRow,
} from '../shared/rl-policy-shadow.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  getDomesticDailyPriceBars,
  getOverseasDailyPriceBars,
} from '../shared/kis-client.ts';

const CONFIRM_TOKEN = 'luna-rl-policy-shadow';
type AnyRecord = Record<string, any>;
type PriceBar = {
  close: number;
  high: number;
  low: number;
  volume: number;
};
type RlOptions = {
  apply: boolean;
  force: boolean;
  json: boolean;
  confirm: string | null;
  exchanges: string[];
  symbol: string | null;
  limit: number;
  hours: number;
  ttlMinutes: number;
  lookbackDays: number;
  maxInferenceCalls: number;
};
type RuntimeDeps = {
  query?: (sql: string, params?: any[]) => Promise<any[]> | any[];
  run?: (sql: string, params?: any[]) => Promise<any> | any;
  initSchema?: () => Promise<any> | any;
  fetchBars?: (symbol: string, exchange: string, options?: AnyRecord) => Promise<PriceBar[]> | PriceBar[];
  listActiveEntryTriggers?: (options: AnyRecord) => Promise<AnyRecord[]> | AnyRecord[];
};

const DEFAULT_SYMBOLS = {
  binance: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
  kis: ['005930', '005380', '000660'],
  kis_overseas: ['AAPL', 'NVDA', 'MSFT', 'SPY'],
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

function parseArgs(argv = process.argv.slice(2)): RlOptions {
  const rawExchanges = argValue('exchanges', argValue('exchange', 'binance,kis,kis_overseas', argv), argv);
  return {
    apply: argv.includes('--apply'),
    force: argv.includes('--force'),
    json: argv.includes('--json'),
    confirm: argValue('confirm', '', argv),
    exchanges: [...new Set(parseList(rawExchanges, ['binance']).map(normalizeRlExchange))],
    symbol: argValue('symbol', null, argv),
    limit: Math.max(1, Number(argValue('limit', 20, argv)) || 20),
    hours: Math.max(1, Number(argValue('hours', 24, argv)) || 24),
    ttlMinutes: Math.max(15, Number(argValue('ttl-minutes', 240, argv)) || 240),
    lookbackDays: Math.max(20, Number(argValue('lookback-days', 90, argv)) || 90),
    maxInferenceCalls: Math.max(0, Number(argValue('max-inference-calls', 0, argv)) || 0),
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

async function fetchRlBars(symbol: string, exchange: string, { lookbackDays = 90 }: AnyRecord = {}): Promise<PriceBar[]> {
  const limit = Math.max(20, Math.min(240, Number(lookbackDays || 90)));
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

async function latestRlPolicyShadow(
  queryFn: NonNullable<RuntimeDeps['query']>,
  { symbol, exchange, ttlMinutes, force }: { symbol: string; exchange: string; ttlMinutes: number; force: boolean },
) {
  if (!symbol || !exchange) return null;
  const rows = await Promise.resolve(queryFn(
    `SELECT *
       FROM investment.luna_rl_policy_shadow
      WHERE symbol = $1
        AND exchange = $2
      ORDER BY observed_at DESC
      LIMIT 1`,
    [symbol, exchange],
  )).catch(() => []);
  const row = Array.isArray(rows) ? rows[0] || null : null;
  return freshEnough(row, ttlMinutes, force) ? normalizeRlPolicyShadowRow(row) : null;
}

async function latestFactorRows(queryFn: NonNullable<RuntimeDeps['query']>, { exchange, hours, limit }: AnyRecord): Promise<AnyRecord[]> {
  const rows = await Promise.resolve(queryFn(
    `SELECT DISTINCT ON (symbol, exchange) *
       FROM investment.luna_factor_model_shadow
      WHERE exchange = $1
        AND observed_at >= NOW() - ($2::int * INTERVAL '1 hour')
      ORDER BY symbol, exchange, observed_at DESC, rank ASC NULLS LAST
      LIMIT $3`,
    [exchange, Math.max(1, Number(hours || 24)), Math.max(1, Number(limit || 20))],
  )).catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

async function latestStatArbRows(queryFn: NonNullable<RuntimeDeps['query']>, { exchange, hours, limit }: AnyRecord): Promise<AnyRecord[]> {
  const rows = await Promise.resolve(queryFn(
    `SELECT *
       FROM investment.luna_stat_arb_shadow
      WHERE exchange = $1
        AND observed_at >= NOW() - ($2::int * INTERVAL '1 hour')
      ORDER BY observed_at DESC, confidence DESC
      LIMIT $3`,
    [exchange, Math.max(1, Number(hours || 24)), Math.max(1, Number(limit || 50))],
  )).catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

async function latestRegimeRow(queryFn: NonNullable<RuntimeDeps['query']>, { market, hours }: AnyRecord): Promise<AnyRecord | null> {
  const rows = await Promise.resolve(queryFn(
    `SELECT market, rule_regime, rule_confidence, llm_regime, llm_confidence, match, captured_at
       FROM investment.luna_regime_llm_shadow
      WHERE market = $1
        AND captured_at >= NOW() - ($2::int * INTERVAL '1 hour')
      ORDER BY captured_at DESC
      LIMIT 1`,
    [market, Math.max(1, Number(hours || 24))],
  )).catch(() => []);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function latestEntryRows(queryFn: NonNullable<RuntimeDeps['query']>, {
  exchange,
  hours,
  limit,
  symbols = [],
}: AnyRecord): Promise<AnyRecord[]> {
  const targetSymbols = [...new Set(
    (Array.isArray(symbols) ? symbols : [])
      .map((symbol) => normalizeSymbol(symbol))
      .filter(Boolean),
  )];
  const params: any[] = [exchange, Math.max(1, Number(hours || 24))];
  const symbolWhere = targetSymbols.length > 0
    ? `AND UPPER(symbol) = ANY($${params.push(targetSymbols)}::text[])`
    : '';
  params.push(Math.max(1, Number(limit || 20)));
  const rows = await Promise.resolve(queryFn(
    `SELECT DISTINCT ON (symbol, exchange) *
       FROM investment.luna_entry_llm_shadow
      WHERE exchange = $1
        AND observed_at >= NOW() - ($2::int * INTERVAL '1 hour')
        ${symbolWhere}
      ORDER BY symbol, exchange, observed_at DESC, llm_confidence DESC
      LIMIT $${params.length}`,
    params,
  )).catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

async function latestPositionRows(queryFn: NonNullable<RuntimeDeps['query']>, { exchange }: AnyRecord): Promise<AnyRecord[]> {
  const rows = await Promise.resolve(queryFn(
    `SELECT symbol, amount, avg_price, unrealized_pnl, paper, execution_mode, broker_account_mode, trade_mode, updated_at
       FROM investment.positions
      WHERE exchange = $1
        AND amount > 0
      ORDER BY updated_at DESC
      LIMIT 100`,
    [exchange],
  )).catch(() => []);
  return (Array.isArray(rows) ? rows : []).filter((row) => row?.paper !== true);
}

async function activeTriggerSymbols(exchange: string, options: RlOptions, deps: RuntimeDeps): Promise<string[]> {
  const listFn = (deps.listActiveEntryTriggers || listActiveEntryTriggers) as (options: AnyRecord) => Promise<AnyRecord[]> | AnyRecord[];
  const since = new Date(Date.now() - Math.max(1, Number(options.hours || 24)) * 60 * 60 * 1000).toISOString();
  const rows = await Promise.resolve(listFn({
    exchange,
    states: ['armed', 'waiting', 'fired'],
    limit: options.limit,
    updatedAfter: since,
    orderBy: 'updated_desc',
  })).catch(() => []);
  return (Array.isArray(rows) ? rows : []).map((row) => String(row.symbol || '').trim()).filter(Boolean);
}

function factorEvidence(row: AnyRecord = {}) {
  if (!row?.symbol) return {};
  return {
    symbol: row.symbol,
    compositeScore: Number(row.composite_score ?? 0.5),
    rank: row.rank == null ? null : Number(row.rank),
    factorScores: parseObject(row.factor_scores, {}),
    allocationHint: parseObject(row.allocation_hint, {}),
    evidence: {
      source: 'investment.luna_factor_model_shadow',
      observedAt: row.observed_at || null,
    },
  };
}

function statArbEvidence(rows: AnyRecord[] = [], symbol = '') {
  const found = rows.find((row) => {
    const symbols = parseObject(row.symbols, row.symbols || []);
    return Array.isArray(symbols) && symbols.includes(symbol);
  });
  if (!found) return {};
  return {
    strategyType: found.strategy_type,
    symbols: parseObject(found.symbols, found.symbols || []),
    signal: found.signal,
    zScore: Number(found.z_score || 0),
    confidence: Number(found.confidence || 0),
    evidence: {
      source: 'investment.luna_stat_arb_shadow',
      observedAt: found.observed_at || null,
    },
  };
}

function regimeEvidence(row: AnyRecord | null = {}) {
  row = row || {};
  if (!row?.market) return {};
  return {
    regime: row.llm_regime || row.rule_regime || 'unknown',
    ruleRegime: row.rule_regime || null,
    llmRegime: row.llm_regime || null,
    confidence: Number(row.llm_confidence ?? row.rule_confidence ?? 0),
    match: row.match,
    evidence: {
      source: 'investment.luna_regime_llm_shadow',
      observedAt: row.captured_at || null,
    },
  };
}

function entryEvidence(row: AnyRecord = {}) {
  if (!row?.symbol) return {};
  return {
    fire: row.llm_fire === true,
    confidence: Number(row.llm_confidence ?? row.deterministic_confidence ?? 0),
    dynamicThreshold: Number(row.dynamic_threshold ?? 0.7),
    positionSizePct: Number(row.position_size_pct ?? 0),
    reasoning: row.reasoning || null,
    evidence: {
      source: 'investment.luna_entry_llm_shadow',
      observedAt: row.observed_at || null,
      triggerId: row.trigger_id || null,
    },
  };
}

function normalizeSymbol(value = ''): string {
  return String(value || '').trim().toUpperCase();
}

function portfolioEvidence(rows: AnyRecord[] = [], symbol = '') {
  const target = normalizeSymbol(symbol);
  const sameSymbol = rows.find((row) => normalizeSymbol(row.symbol) === target);
  if (!sameSymbol) {
    return {
      cashPct: 1,
      positionPct: 0,
      unrealizedPnlPct: 0,
      riskBudgetPct: 0.02,
      exchangeOpenPositionCount: rows.length,
      sameSymbolOpen: false,
    };
  }
  const amount = Number(sameSymbol.amount || 0);
  const avgPrice = Number(sameSymbol.avg_price || 0);
  const value = amount > 0 && avgPrice > 0 ? amount * avgPrice : 0;
  const positionPct = value > 0 ? Math.min(0.35, Math.max(0.03, value / Math.max(value * 4, value))) : 0.1;
  return {
    cashPct: Math.max(0, 1 - positionPct),
    positionPct,
    unrealizedPnlPct: Number(sameSymbol.unrealized_pnl || 0),
    riskBudgetPct: 0.02,
    exchangeOpenPositionCount: rows.length,
    sameSymbolOpen: true,
    evidence: {
      source: 'investment.positions',
      updatedAt: sameSymbol.updated_at || null,
    },
  };
}

async function symbolsForExchange(exchange: string, options: RlOptions, deps: RuntimeDeps): Promise<string[]> {
  if (options.symbol) return [options.symbol];
  const queryFn = (deps.query || db.query) as NonNullable<RuntimeDeps['query']>;
  const factors = await latestFactorRows(queryFn, { exchange, hours: options.hours, limit: options.limit });
  const triggers = await activeTriggerSymbols(exchange, options, deps);
  const defaults = (DEFAULT_SYMBOLS as AnyRecord)[exchange] || DEFAULT_SYMBOLS.binance;
  return [...new Set([
    ...factors.map((row) => row.symbol).filter(Boolean),
    ...triggers,
    ...defaults,
  ])].slice(0, Math.max(1, Number(options.limit || 20)));
}

async function buildPolicyRows(exchange: string, options: RlOptions, deps: RuntimeDeps): Promise<AnyRecord[]> {
  const queryFn = (deps.query || db.query) as NonNullable<RuntimeDeps['query']>;
  const fetchBars = deps.fetchBars || fetchRlBars;
  const market = marketForRlExchange(exchange);
  const symbols = await symbolsForExchange(exchange, options, deps);
  const [factorRows, statRows, entryRows, regimeRow, positionRows] = await Promise.all([
    latestFactorRows(queryFn, { exchange, hours: options.hours, limit: Math.max(options.limit, symbols.length) }),
    latestStatArbRows(queryFn, { exchange, hours: options.hours, limit: 50 }),
    latestEntryRows(queryFn, {
      exchange,
      hours: options.hours,
      limit: Math.max(options.limit, symbols.length),
      symbols,
    }),
    latestRegimeRow(queryFn, { market, hours: options.hours }),
    latestPositionRows(queryFn, { exchange }),
  ]);
  const factorBySymbol = new Map(factorRows.map((row) => [row.symbol, row]));
  const entryBySymbol = new Map(entryRows.map((row) => [row.symbol, row]));
  const rows: AnyRecord[] = [];
  for (const symbol of symbols) {
    const existing = await latestRlPolicyShadow(queryFn, {
      symbol,
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
      ...buildRlPolicyShadow({
        symbol,
        exchange,
        market,
        bars,
        factorEvidence: factorEvidence(factorBySymbol.get(symbol)),
        statArbEvidence: statArbEvidence(statRows, symbol),
        entryEvidence: entryEvidence(entryBySymbol.get(symbol)),
        regimeEvidence: regimeEvidence(regimeRow),
        portfolio: portfolioEvidence(positionRows, symbol),
      }, {
        source: 'runtime_luna_rl_policy_shadow',
        optionalDepsReady: false,
        modelLoaded: false,
      }),
      status: 'planned',
      reason: options.apply && options.confirm === CONFIRM_TOKEN ? 'write_planned' : 'apply_confirm_required',
      written: false,
    });
  }
  return rows;
}

async function insertRlPolicyShadow(runFn: NonNullable<RuntimeDeps['run']>, payload: AnyRecord) {
  await Promise.resolve(runFn(
    `INSERT INTO investment.luna_rl_policy_shadow
       (symbol, exchange, market, state_vector, action, action_type, action_size_pct, confidence,
        reward_estimate, model_status, data_health, context_evidence, shadow_only)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`,
    [
      payload.symbol,
      payload.exchange,
      payload.market,
      JSON.stringify(payload.stateVector || {}),
      payload.action,
      payload.actionType,
      payload.actionSizePct,
      payload.confidence,
      payload.rewardEstimate,
      payload.modelStatus,
      payload.dataHealth,
      JSON.stringify(payload.evidence || {}),
      true,
    ],
  ));
}

export async function runLunaRlPolicyShadow(options: RlOptions = parseArgs(), deps: RuntimeDeps = {}) {
  if (process.env.LUNA_RL_POLICY_SHADOW_ENABLED === 'false') {
    return {
      ok: true,
      status: 'luna_rl_policy_shadow_disabled',
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
    rows.push(...await buildPolicyRows(exchange, options, deps));
  }

  if (canWrite) {
    for (const row of rows.filter((item) => item.status === 'planned' && item.ok)) {
      await insertRlPolicyShadow(runFn, row);
      row.status = 'written';
      row.reason = 'rl_policy_shadow_written';
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
      ? 'luna_rl_policy_shadow_written'
      : planned > 0
        ? 'luna_rl_policy_shadow_planned'
        : cached > 0
          ? 'luna_rl_policy_shadow_cached'
          : 'luna_rl_policy_shadow_skipped',
    apply: options.apply,
    confirmRequired: CONFIRM_TOKEN,
    summary: {
      candidates: rows.length,
      written,
      planned,
      cached,
      insufficient,
      maxInferenceCalls: options.maxInferenceCalls,
      externalInferenceCalls: 0,
      liveMutation: false,
      serviceStarted: false,
    },
    rows,
  };
}

async function main() {
  const result = await runLunaRlPolicyShadow(parseArgs());
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${result.status} candidates=${result.summary?.candidates || 0} written=${result.summary?.written || 0}`);
}

if (isDirectExecution(import.meta.url)) {
  await (runCliMain as any)({
    run: main,
    errorPrefix: 'luna rl policy shadow error:',
  });
}
