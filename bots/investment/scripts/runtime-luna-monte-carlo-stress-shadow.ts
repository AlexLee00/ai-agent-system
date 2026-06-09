#!/usr/bin/env node

import * as db from '../shared/db.ts';
import {
  buildMonteCarloShadow,
  defaultRiskSymbols,
  marketForRiskExchange,
  normalizeRiskExchange,
  normalizeRiskSimulationShadowRow,
} from '../shared/quant/monte-carlo.ts';
import { buildStressTestShadow, HISTORICAL_STRESS_SCENARIOS } from '../shared/quant/stress-test.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  getDomesticDailyPriceBars,
  getOverseasDailyPriceBars,
} from '../shared/kis-client.ts';

const CONFIRM_TOKEN = 'luna-monte-carlo-stress-shadow';

type AnyRecord = Record<string, any>;
type PriceBar = {
  close: number;
  high: number;
  low: number;
  volume: number;
};
type RiskOptions = {
  apply: boolean;
  force: boolean;
  json: boolean;
  confirm: string | null;
  exchanges: string[];
  analysis: string;
  symbol: string | null;
  symbols: string[];
  scenarios: string[];
  limit: number;
  hours: number;
  ttlMinutes: number;
  lookbackDays: number;
  simulations: number;
  horizonDays: number;
};
type RuntimeDeps = {
  query?: (sql: string, params?: any[]) => Promise<any[]> | any[];
  run?: (sql: string, params?: any[]) => Promise<any> | any;
  initSchema?: () => Promise<any> | any;
  fetchBars?: (symbol: string, exchange: string, options?: AnyRecord) => Promise<PriceBar[]> | PriceBar[];
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

function parseArgs(argv = process.argv.slice(2)): RiskOptions {
  const rawExchanges = argValue('exchanges', argValue('exchange', 'binance,kis,kis_overseas', argv), argv);
  const rawScenarios = argValue(
    'scenarios',
    argValue(
      'scenario',
      'base,bull,bear,sideways,black_swan,2008_financial_crisis,2020_covid_crash,2022_luna_ftx,2018_btc_crash',
      argv,
    ),
    argv,
  );
  return {
    apply: argv.includes('--apply'),
    force: argv.includes('--force'),
    json: argv.includes('--json'),
    confirm: argValue('confirm', '', argv),
    exchanges: [...new Set(parseList(rawExchanges, ['binance']).map(normalizeRiskExchange))],
    analysis: String(argValue('analysis', 'all', argv) || 'all').toLowerCase(),
    symbol: argValue('symbol', null, argv),
    symbols: parseList(argValue('symbols', '', argv), []),
    scenarios: parseList(rawScenarios, ['base']),
    limit: Math.max(1, Number(argValue('limit', 8, argv)) || 8),
    hours: Math.max(1, Number(argValue('hours', 24, argv)) || 24),
    ttlMinutes: Math.max(15, Number(argValue('ttl-minutes', 240, argv)) || 240),
    lookbackDays: Math.max(20, Number(argValue('lookback-days', 180, argv)) || 180),
    simulations: Math.max(100, Math.min(10000, Number(argValue('simulations', 1000, argv)) || 1000)),
    horizonDays: Math.max(1, Math.min(252, Number(argValue('horizon-days', 20, argv)) || 20)),
  };
}

function freshEnough(row: AnyRecord | null, ttlMinutes: number, force = false): boolean {
  if (force || !row?.observed_at) return false;
  const ageMs = Date.now() - new Date(row.observed_at).getTime();
  return ageMs >= 0 && ageMs < ttlMinutes * 60 * 1000;
}

export function binanceSymbol(symbol = ''): string {
  const raw = String(symbol || '').trim();
  const withoutProvider = raw.includes(':') ? raw.split(':').pop() : raw;
  return String(withoutProvider || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
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

async function fetchRiskBars(symbol: string, exchange: string, { lookbackDays = 180 }: AnyRecord = {}): Promise<PriceBar[]> {
  const limit = Math.max(20, Math.min(720, Number(lookbackDays || 180)));
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

function priceHistorySource(exchange: string): string {
  if (exchange === 'binance') return 'binance_public_1d_klines';
  if (exchange === 'kis') return 'kis_domestic_daily_price';
  if (exchange === 'kis_overseas') return 'kis_overseas_daily_price';
  return 'unknown_price_history';
}

async function latestRiskSimulationShadow(
  queryFn: NonNullable<RuntimeDeps['query']>,
  { analysisType, symbols, exchange, scenario, ttlMinutes, force }: {
    analysisType: string;
    symbols: string[];
    exchange: string;
    scenario: string;
    ttlMinutes: number;
    force: boolean;
  },
) {
  if (!analysisType || !exchange || !Array.isArray(symbols) || symbols.length === 0) return null;
  const rows = await Promise.resolve(queryFn(
    `SELECT *
       FROM investment.luna_risk_simulation_shadow
      WHERE analysis_type = $1
        AND exchange = $2
        AND scenario = $3
        AND symbols = $4::jsonb
      ORDER BY observed_at DESC
      LIMIT 1`,
    [analysisType, exchange, scenario, JSON.stringify(symbols)],
  )).catch(() => []);
  const row = Array.isArray(rows) ? rows[0] || null : null;
  return freshEnough(row, ttlMinutes, force) ? normalizeRiskSimulationShadowRow(row) : null;
}

function symbolsForExchange(exchange: string, options: RiskOptions): string[] {
  if (options.symbol) return [options.symbol];
  if (options.symbols?.length) return options.symbols.slice(0, options.limit);
  return defaultRiskSymbols(exchange).slice(0, options.limit);
}

async function buildBarsBySymbol(exchange: string, symbols: string[], options: RiskOptions, deps: RuntimeDeps): Promise<Record<string, PriceBar[]>> {
  const fetchBars = deps.fetchBars || fetchRiskBars;
  const entries = await Promise.all(symbols.map(async (symbol) => [
    symbol,
    await Promise.resolve(fetchBars(symbol, exchange, { lookbackDays: options.lookbackDays })).catch(() => []),
  ]));
  return Object.fromEntries(entries);
}

function normalizedScenarioList(analysisType: string, scenarios: unknown): string[] {
  const canonical = [...new Set((Array.isArray(scenarios) ? scenarios : [])
    .map((scenario) => String(scenario || '').trim().toLowerCase())
    .filter(Boolean))];
  if (analysisType === 'stress_test') {
    const valid = Object.keys(HISTORICAL_STRESS_SCENARIOS);
    return canonical.filter((scenario) => valid.includes(scenario));
  }
  return canonical.filter((scenario) => ['base', 'bull', 'bear', 'sideways', 'black_swan'].includes(scenario));
}

async function buildRiskSimulationRows(exchange: string, options: RiskOptions, deps: RuntimeDeps): Promise<AnyRecord[]> {
  const queryFn = (deps.query || db.query) as NonNullable<RuntimeDeps['query']>;
  const symbols = symbolsForExchange(exchange, options);
  const barsBySymbol = await buildBarsBySymbol(exchange, symbols, options, deps);
  const rows: AnyRecord[] = [];
  const analysisTypes = options.analysis === 'all'
    ? ['monte_carlo', 'stress_test']
    : [options.analysis === 'stress' ? 'stress_test' : options.analysis === 'monte' ? 'monte_carlo' : options.analysis];

  for (const analysisType of analysisTypes) {
    const scenarios = normalizedScenarioList(analysisType, options.scenarios);
    for (const scenario of scenarios) {
      const existing = await latestRiskSimulationShadow(queryFn, {
        analysisType,
        symbols,
        exchange,
        scenario,
        ttlMinutes: options.ttlMinutes,
        force: options.force,
      });
      if (existing) {
        rows.push({ ...existing, status: 'cached', reason: 'fresh_shadow_exists', written: false });
        continue;
      }
      const builder = (analysisType === 'stress_test' ? buildStressTestShadow : buildMonteCarloShadow) as unknown as (
        input: AnyRecord,
        options?: AnyRecord,
      ) => AnyRecord;
      rows.push({
        ...builder({
          symbols,
          exchange,
          scenario,
          simulations: options.simulations,
          horizonDays: options.horizonDays,
          barsBySymbol,
        }, { source: priceHistorySource(exchange) }),
        status: 'planned',
        reason: options.apply && options.confirm === CONFIRM_TOKEN ? 'write_planned' : 'apply_confirm_required',
        written: false,
      });
    }
  }
  return rows;
}

async function insertRiskSimulationShadow(runFn: NonNullable<RuntimeDeps['run']>, payload: AnyRecord) {
  await Promise.resolve(runFn(
    `INSERT INTO investment.luna_risk_simulation_shadow
       (analysis_type, symbols, exchange, market, scenario, simulations, var_95, var_99, cvar_95, cvar_99,
        max_loss_estimate, recovery_days_estimate, risk_limits, scenario_metrics, data_health, context_evidence, shadow_only)
     VALUES ($1,$2::jsonb,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16::jsonb,$17)`,
    [
      payload.analysisType,
      JSON.stringify(payload.symbols || []),
      payload.exchange,
      payload.market,
      payload.scenario,
      payload.simulations,
      payload.var95,
      payload.var99,
      payload.cvar95,
      payload.cvar99,
      payload.maxLossEstimate,
      payload.recoveryDaysEstimate,
      JSON.stringify(payload.riskLimits || {}),
      JSON.stringify(payload.scenarioMetrics || {}),
      payload.dataHealth,
      JSON.stringify(payload.evidence || {}),
      true,
    ],
  ));
}

export async function runLunaMonteCarloStressShadow(options: RiskOptions = parseArgs(), deps: RuntimeDeps = {}) {
  if (process.env.LUNA_MONTE_CARLO_STRESS_SHADOW_ENABLED === 'false') {
    return {
      ok: true,
      status: 'luna_monte_carlo_stress_shadow_disabled',
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
    rows.push(...await buildRiskSimulationRows(exchange, options, deps));
  }

  if (canWrite) {
    for (const row of rows.filter((item) => item.status === 'planned' && item.ok)) {
      await insertRiskSimulationShadow(runFn, row);
      row.status = 'written';
      row.reason = 'risk_simulation_shadow_written';
      row.written = true;
    }
  }

  const written = rows.filter((row) => row.written).length;
  const cached = rows.filter((row) => row.status === 'cached').length;
  const planned = rows.filter((row) => row.status === 'planned').length;
  const insufficient = rows.filter((row) => row.dataHealth === 'insufficient').length;
  const critical = rows.filter((row) => row.scenarioMetrics?.riskLevel === 'critical').length;
  return {
    ok: true,
    status: written > 0
      ? 'luna_monte_carlo_stress_shadow_written'
      : planned > 0
        ? 'luna_monte_carlo_stress_shadow_planned'
        : cached > 0
          ? 'luna_monte_carlo_stress_shadow_cached'
          : 'luna_monte_carlo_stress_shadow_skipped',
    apply: options.apply,
    confirmRequired: CONFIRM_TOKEN,
    summary: {
      candidates: rows.length,
      written,
      planned,
      cached,
      insufficient,
      critical,
      liveMutation: false,
    },
    rows,
  };
}

async function main() {
  const result = await runLunaMonteCarloStressShadow(parseArgs());
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${result.status} candidates=${result.summary?.candidates || 0} written=${result.summary?.written || 0}`);
}

if (isDirectExecution(import.meta.url)) {
  await (runCliMain as any)({
    run: main,
    errorPrefix: 'luna monte carlo stress shadow error:',
  });
}
