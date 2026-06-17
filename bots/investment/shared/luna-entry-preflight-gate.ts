// @ts-nocheck

import * as db from './db.ts';
import { getBrokerAdapter } from './brokers/broker-router.ts';
import { getTossCredentials } from './secrets.ts';
import { getParameter } from './luna-parameter-store.ts';
import { fetchPhaseABars, normalizePhaseAMarket, normalizePhaseASymbol } from './luna-phase-a-market-data.ts';
import { evaluateSecuritiesWarningGate } from './luna-securities-warning-gate.ts';
import { dropIncompleteLastBar } from './luna-strategy-families.ts';

export const LUNA_PREFLIGHT_PARAM_KEYS = Object.freeze({
  minRr: 'c4.min_rr',
  eMinSamples: 'c4.e_min_samples',
  sidewaysBlockThreshold: 'c4.sideways_block_threshold',
  minLiquidity: 'c4.min_liquidity',
});

export const LUNA_PREFLIGHT_DEFAULTS = Object.freeze({
  minRr: 2.0,
  eMinSamples: 30,
  sidewaysBlockThreshold: 0.5,
  minLiquidity: {
    crypto: 1_000_000,
    domestic: 1_000_000_000,
    overseas: 5_000_000,
  },
  liquidityBars: 20,
  trendFamilies: ['turtle_breakout', 'testah_pullback'],
});

export const LUNA_ENTRY_PREFLIGHT_SCHEMA_SQL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS investment.luna_entry_preflight_log (
     id                 BIGSERIAL PRIMARY KEY,
     strategy_signal_id BIGINT,
     market             TEXT NOT NULL,
     symbol             TEXT NOT NULL,
     family             TEXT NOT NULL,
     candle_ts          TIMESTAMPTZ,
     decision           TEXT NOT NULL CHECK (decision IN ('pass', 'block', 'pass_with_skips')),
     gates              JSONB NOT NULL DEFAULT '[]'::jsonb,
     regime             JSONB NOT NULL DEFAULT '{}'::jsonb,
     rr                 NUMERIC,
     evaluated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     shadow_only        BOOLEAN NOT NULL DEFAULT TRUE
   )`,
  `CREATE INDEX IF NOT EXISTS idx_luna_entry_preflight_log_symbol_time
     ON investment.luna_entry_preflight_log(symbol, evaluated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_luna_entry_preflight_log_decision_time
     ON investment.luna_entry_preflight_log(decision, evaluated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_luna_entry_preflight_log_family_time
     ON investment.luna_entry_preflight_log(market, family, evaluated_at DESC)`,
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

function optionParameter(options: any, key: string, fallback: any, market: string | null = null) {
  const params = options.parameters || {};
  if (Object.prototype.hasOwnProperty.call(params, key)) {
    const value = params[key];
    if (market && value && typeof value === 'object' && !Array.isArray(value)) return value[market] ?? fallback;
    return value;
  }
  if (market && Object.prototype.hasOwnProperty.call(params, `${key}.${market}`)) return params[`${key}.${market}`];
  return undefined;
}

async function parameterValue(key: string, scope: string, fallback: any, options: any = {}, deps: any = {}, market: string | null = null) {
  const fromOptions = optionParameter(options, key, fallback, market);
  if (fromOptions !== undefined) return fromOptions;
  try {
    const row = await (deps.getParameter || getParameter)(key, scope, {
      bypassCache: options.bypassParameterCache === true,
      env: options.env || process.env,
      queryFn: deps.queryFn || options.queryFn || db.query,
    });
    const value = row?.value;
    if (market && value && typeof value === 'object' && !Array.isArray(value)) return value[market] ?? fallback;
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

export async function loadEntryPreflightParameters(options: any = {}, deps: any = {}) {
  const market = normalizePhaseAMarket(options.market || 'crypto');
  const minLiquidityDefault = LUNA_PREFLIGHT_DEFAULTS.minLiquidity[market] ?? LUNA_PREFLIGHT_DEFAULTS.minLiquidity.crypto;
  return {
    minRr: finite(await parameterValue(LUNA_PREFLIGHT_PARAM_KEYS.minRr, 'global', LUNA_PREFLIGHT_DEFAULTS.minRr, options, deps), LUNA_PREFLIGHT_DEFAULTS.minRr),
    eMinSamples: finite(await parameterValue(LUNA_PREFLIGHT_PARAM_KEYS.eMinSamples, 'global', LUNA_PREFLIGHT_DEFAULTS.eMinSamples, options, deps), LUNA_PREFLIGHT_DEFAULTS.eMinSamples),
    sidewaysBlockThreshold: finite(await parameterValue(
      LUNA_PREFLIGHT_PARAM_KEYS.sidewaysBlockThreshold,
      'global',
      LUNA_PREFLIGHT_DEFAULTS.sidewaysBlockThreshold,
      options,
      deps,
    ), LUNA_PREFLIGHT_DEFAULTS.sidewaysBlockThreshold),
    minLiquidity: finite(await parameterValue(
      LUNA_PREFLIGHT_PARAM_KEYS.minLiquidity,
      'market',
      LUNA_PREFLIGHT_DEFAULTS.minLiquidity,
      options,
      deps,
      market,
    ), minLiquidityDefault),
    liquidityBars: finite(options.liquidityBars, LUNA_PREFLIGHT_DEFAULTS.liquidityBars),
  };
}

function normalizeSignal(signal: any = {}) {
  const market = normalizePhaseAMarket(signal.market || signal.exchange || 'crypto');
  const regime = signal.regime || {};
  return {
    strategySignalId: signal.strategySignalId ?? signal.strategy_signal_id ?? signal.id ?? null,
    market,
    symbol: normalizePhaseASymbol(signal.symbol || '', market),
    family: signal.family || '',
    signalType: signal.signalType || signal.signal_type || null,
    candleTs: signal.candleTs || signal.candle_ts || null,
    price: finite(signal.price, null),
    stop: finite(signal.stop, null),
    target: finite(signal.target, null),
    rr: finite(signal.rr, null),
    regime,
    dominantRegime: regime?.dominant || regime?.current_regime || regime?.regime || null,
    sidewaysProbability: finite(regime?.probabilities?.sideways ?? regime?.sidewaysProbability ?? regime?.sideways_probability, null),
    raw: signal,
  };
}

function gate(name: string, status: string, reason: string, details: any = {}) {
  return { name, status, reason, details };
}

function rMultiple(entry: any, exit: any) {
  const entryPrice = finite(entry.price, null);
  const stop = finite(entry.stop, null);
  const exitPrice = finite(exit.price, null);
  if (entryPrice == null || stop == null || exitPrice == null || !(entryPrice > stop)) return null;
  return (exitPrice - entryPrice) / (entryPrice - stop);
}

export function pairHistoricalStrategySignals(rows = [], family = null, dominant = null) {
  const sorted = (Array.isArray(rows) ? rows : [])
    .map(normalizeSignal)
    .filter((row) => row.symbol && (!family || row.family === family) && (!dominant || row.dominantRegime === dominant))
    .sort((a, b) => {
      const left = `${a.symbol}:${new Date(a.candleTs || 0).getTime()}`;
      const right = `${b.symbol}:${new Date(b.candleTs || 0).getTime()}`;
      return left.localeCompare(right);
    });
  const openBySymbol = new Map();
  const pairs = [];
  for (const row of sorted) {
    if (row.signalType === 'entry') {
      if (!openBySymbol.has(row.symbol)) openBySymbol.set(row.symbol, row);
      continue;
    }
    if (!['exit', 'invalidate'].includes(row.signalType)) continue;
    const entry = openBySymbol.get(row.symbol);
    if (!entry) continue;
    const r = rMultiple(entry, row);
    if (r != null) pairs.push({ entry, exit: row, r });
    openBySymbol.delete(row.symbol);
  }
  return pairs;
}

async function loadHistoricalSignals(signal: any, options: any = {}, deps: any = {}) {
  if (Array.isArray(options.historicalSignals)) return options.historicalSignals;
  const rows = await (deps.queryFn || options.queryFn || db.query)(
    `SELECT id, market, symbol, family, signal_type, candle_ts, price, stop, target, rr, regime
       FROM luna_strategy_signals
      WHERE family = $1
        AND COALESCE(regime->>'dominant', '') = COALESCE($2, '')
      ORDER BY symbol, candle_ts`,
    [signal.family, signal.dominantRegime || ''],
  ).catch(() => []);
  return rows || [];
}

export async function evaluateExpectancyGate(signal: any, params: any, options: any = {}, deps: any = {}) {
  const historical = await loadHistoricalSignals(signal, options, deps);
  const pairs = pairHistoricalStrategySignals(historical, signal.family, signal.dominantRegime);
  const sampleCount = pairs.length;
  if (sampleCount < Number(params.eMinSamples)) {
    return gate('G-E', 'skip', 'skip_insufficient_sample', {
      sampleCount,
      minSamples: Number(params.eMinSamples),
      family: signal.family,
      dominantRegime: signal.dominantRegime || null,
    });
  }
  const avgR = pairs.reduce((sum, item) => sum + Number(item.r || 0), 0) / sampleCount;
  return avgR > 0
    ? gate('G-E', 'pass', 'expectancy_positive', { sampleCount, avgR: round(avgR, 4) })
    : gate('G-E', 'block', 'expectancy_non_positive', { sampleCount, avgR: round(avgR, 4) });
}

export function evaluateRrGate(signal: any, params: any) {
  const rr = finite(signal.rr, null);
  if (rr == null) return gate('G-rr', 'block', 'rr_unavailable', { rr, minRr: Number(params.minRr) });
  return rr >= Number(params.minRr)
    ? gate('G-rr', 'pass', 'rr_pass', { rr: round(rr, 4), minRr: Number(params.minRr) })
    : gate('G-rr', 'block', 'rr_below_min', { rr: round(rr, 4), minRr: Number(params.minRr) });
}

export function evaluateSidewaysGate(signal: any, params: any) {
  const trendFamily = LUNA_PREFLIGHT_DEFAULTS.trendFamilies.includes(signal.family);
  const sideways = finite(signal.sidewaysProbability, null);
  if (!trendFamily) return gate('G-sideways', 'skip', 'non_trend_family', { family: signal.family });
  if (sideways == null) return gate('G-sideways', 'skip', 'sideways_probability_unavailable', {});
  return sideways > Number(params.sidewaysBlockThreshold)
    ? gate('G-sideways', 'block', 'sideways_probability_above_threshold', { sidewaysProbability: round(sideways, 4), threshold: Number(params.sidewaysBlockThreshold) })
    : gate('G-sideways', 'pass', 'sideways_probability_ok', { sidewaysProbability: round(sideways, 4), threshold: Number(params.sidewaysBlockThreshold) });
}

function averageTurnover(bars = [], required = 20) {
  const normalized = (Array.isArray(bars) ? bars : [])
    .map((bar) => ({
      close: finite(bar.close ?? bar.c ?? bar.price, null),
      volume: finite(bar.volume ?? bar.v, null),
    }))
    .filter((bar) => bar.close != null && bar.volume != null && bar.close > 0 && bar.volume >= 0);
  if (normalized.length < required) return null;
  const window = normalized.slice(-required);
  return window.reduce((sum, bar) => sum + bar.close * bar.volume, 0) / window.length;
}

export async function evaluateLiquidityGate(signal: any, params: any, options: any = {}, deps: any = {}) {
  let bars = Array.isArray(options.bars) ? options.bars : null;
  if (!bars && signal.symbol) {
    const fetched = await (deps.fetchPhaseABars || fetchPhaseABars)({
      symbol: signal.symbol,
      market: signal.market,
      timeframe: '1d',
      lookbackDays: 80,
      getOhlcv: options.getOhlcv,
    }).catch((error: any) => ({ bars: [], error: error?.message || String(error) }));
    bars = fetched?.bars || [];
  }
  const completed = dropIncompleteLastBar(bars || [], signal.market, options.now || new Date());
  const avgTurnover = averageTurnover(completed, Number(params.liquidityBars || 20));
  if (avgTurnover == null) {
    return gate('G-liquidity', 'skip', 'liquidity_data_unavailable', {
      bars: completed.length,
      requiredBars: Number(params.liquidityBars || 20),
    });
  }
  return avgTurnover >= Number(params.minLiquidity)
    ? gate('G-liquidity', 'pass', 'liquidity_pass', { avgTurnover: round(avgTurnover, 2), minLiquidity: Number(params.minLiquidity) })
    : gate('G-liquidity', 'block', 'liquidity_below_min', { avgTurnover: round(avgTurnover, 2), minLiquidity: Number(params.minLiquidity) });
}

export function aggregatePreflightDecision(gates = []) {
  if ((gates || []).some((item) => item.status === 'block')) return 'block';
  if ((gates || []).some((item) => item.status === 'skip')) return 'pass_with_skips';
  return 'pass';
}

function shouldRunTossCrossCheck(signal: any, options: any = {}) {
  if (!['domestic', 'overseas'].includes(signal.market)) return false;
  if (options.crossCheckWithToss === false) return false;
  if (options.crossCheckWithToss === true) return true;
  return signal.market === 'domestic';
}

export async function evaluateTossCrossCheckGate(signal: any, options: any = {}, deps: any = {}) {
  if (!['domestic', 'overseas'].includes(signal.market)) {
    return gate('G-toss-cross-check', 'skip', 'non_stock_market', { market: signal.market, advisoryOnly: true });
  }
  if (!shouldRunTossCrossCheck(signal, options)) {
    return gate('G-toss-cross-check', 'skip', 'toss_cross_check_disabled_for_market', { market: signal.market, advisoryOnly: true });
  }
  const credentials = (deps.getTossCredentials || getTossCredentials)();
  const account = signal.market === 'domestic' ? credentials.accountDomestic : credentials.accountOverseas;
  if (!account) {
    return gate('G-toss-cross-check', 'skip', 'toss_cross_check_skipped_no_account', {
      market: signal.market,
      symbol: signal.symbol,
      advisoryOnly: true,
      attempted: false,
    });
  }

  try {
    const crossCheckFn = deps.tossCrossCheckFn || options.tossCrossCheckFn;
    const result = crossCheckFn
      ? await crossCheckFn(signal, { account, credentials, options })
      : await defaultTossCrossCheck(signal, { account });
    return gate('G-toss-cross-check', 'pass', 'toss_cross_check_recorded', {
      market: signal.market,
      symbol: signal.symbol,
      advisoryOnly: true,
      attempted: true,
      matched: result?.matched ?? null,
      buyingPower: result?.buyingPower ?? null,
      sellableQuantity: result?.sellableQuantity ?? null,
      commissions: result?.commissions ?? null,
    });
  } catch (error) {
    return gate('G-toss-cross-check', 'skip', 'toss_cross_check_lookup_failed', {
      market: signal.market,
      symbol: signal.symbol,
      advisoryOnly: true,
      attempted: true,
      error: String(error?.message || error || 'unknown_error').slice(0, 280),
    });
  }
}

async function defaultTossCrossCheck(signal: any, { account }: any = {}) {
  const adapter = getBrokerAdapter('toss');
  const currency = signal.market === 'domestic' ? 'KRW' : 'USD';
  const [buyingPower, sellableQuantity, commissions] = await Promise.all([
    adapter.getBuyingPower?.({ account, currency }),
    adapter.getSellableQuantity?.(signal.symbol, { account }),
    adapter.getCommissions?.({ account }),
  ]);
  return {
    matched: null,
    buyingPower,
    sellableQuantity,
    commissions,
  };
}

export async function evaluateEntryPreflight(signalInput: any = {}, options: any = {}, deps: any = {}) {
  const signal = normalizeSignal(signalInput);
  const params = await loadEntryPreflightParameters({ ...options, market: signal.market }, deps);
  const decisiveGates = [
    evaluateRrGate(signal, params),
    await evaluateExpectancyGate(signal, params, options, deps),
    evaluateSidewaysGate(signal, params),
    await evaluateLiquidityGate(signal, params, options, deps),
  ];
  if (options.securitiesWarningGate !== false) {
    decisiveGates.push(await evaluateSecuritiesWarningGate(signal, options, deps));
  }
  const advisoryGates = [
    await evaluateTossCrossCheckGate(signal, options, deps),
  ];
  const decision = aggregatePreflightDecision(decisiveGates);
  const gates = [...decisiveGates, ...advisoryGates];
  return {
    strategySignalId: signal.strategySignalId,
    market: signal.market,
    symbol: signal.symbol,
    family: signal.family,
    candleTs: signal.candleTs,
    decision,
    gates,
    regime: signal.regime || {},
    rr: signal.rr,
    evaluatedAt: (options.now ? new Date(options.now) : new Date()).toISOString(),
    shadowOnly: true,
    liveMutation: false,
  };
}

export async function evaluateEntryPreflightsForSignals(signals = [], options: any = {}, deps: any = {}) {
  const entries = (signals || []).filter((signal) => (signal.signalType || signal.signal_type) === 'entry');
  const evaluations = [];
  for (const signal of entries) {
    evaluations.push(await evaluateEntryPreflight(signal, options, deps));
  }
  return evaluations;
}

export async function insertEntryPreflightLog(row: any, runFn = db.run) {
  return runFn(
    `INSERT INTO luna_entry_preflight_log
       (strategy_signal_id, market, symbol, family, candle_ts, decision, gates, regime, rr, evaluated_at, shadow_only)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)
     RETURNING id`,
    [
      row.strategySignalId ?? null,
      normalizePhaseAMarket(row.market),
      row.symbol,
      row.family,
      row.candleTs ?? null,
      row.decision,
      JSON.stringify(row.gates || []),
      JSON.stringify(row.regime || {}),
      row.rr ?? null,
      row.evaluatedAt || new Date().toISOString(),
      row.shadowOnly !== false,
    ],
  );
}

export async function insertEntryPreflightLogs(rows = [], runFn = db.run) {
  const inserted = [];
  for (const row of rows || []) {
    const result = await insertEntryPreflightLog(row, runFn);
    inserted.push(result?.rows?.[0]?.id || null);
  }
  return inserted;
}

export function summarizeEntryPreflightEvaluations(rows = []) {
  const pass = (rows || []).filter((row) => row.decision === 'pass').length;
  const block = (rows || []).filter((row) => row.decision === 'block').length;
  const skips = (rows || []).filter((row) => row.decision === 'pass_with_skips').length;
  return { pass, block, skips, line: `프리플라이트: 통과 ${pass}·차단 ${block}·스킵 ${skips}` };
}

export const _testOnly = {
  normalizeSignal,
  averageTurnover,
  rMultiple,
  optionParameter,
};

export default {
  evaluateEntryPreflight,
  evaluateEntryPreflightsForSignals,
  insertEntryPreflightLogs,
  summarizeEntryPreflightEvaluations,
};
