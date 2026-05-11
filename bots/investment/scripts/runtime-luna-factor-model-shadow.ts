#!/usr/bin/env node

import * as db from '../shared/db.ts';
import { listActiveEntryTriggers } from '../shared/luna-discovery-entry-store.ts';
import {
  buildFactorModelShadow,
  marketForFactorExchange,
  normalizeFactorShadowRow,
  rankFactorModelShadows,
} from '../shared/factor-model-shadow.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const CONFIRM_TOKEN = 'luna-factor-model-shadow';
const VALID_EXCHANGES = new Set(['binance', 'kis', 'kis_overseas']);

function argValue(name, fallback = null, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function parseList(value, fallback = []) {
  const list = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, arr) => arr.indexOf(item) === index);
  return list.length ? list : fallback;
}

function normalizeExchange(value) {
  const raw = String(value || 'binance').trim().toLowerCase();
  if (raw === 'crypto') return 'binance';
  if (raw === 'domestic') return 'kis';
  if (raw === 'overseas') return 'kis_overseas';
  return VALID_EXCHANGES.has(raw) ? raw : 'binance';
}

function parseArgs(argv = process.argv.slice(2)) {
  const rawExchanges = argValue('exchanges', argValue('exchange', 'binance,kis,kis_overseas', argv), argv);
  return {
    apply: argv.includes('--apply'),
    force: argv.includes('--force'),
    json: argv.includes('--json'),
    confirm: argValue('confirm', '', argv),
    exchanges: [...new Set(parseList(rawExchanges, ['binance']).map(normalizeExchange))],
    symbol: argValue('symbol', null, argv),
    limit: Math.max(1, Number(argValue('limit', 20, argv)) || 20),
    hours: Math.max(1, Number(argValue('hours', 24, argv)) || 24),
    ttlMinutes: Math.max(15, Number(argValue('ttl-minutes', 240, argv)) || 240),
    lookbackDays: Math.max(5, Number(argValue('lookback-days', 60, argv)) || 60),
  };
}

function freshEnough(row, ttlMinutes, force = false) {
  if (force || !row?.observed_at) return false;
  const ageMs = Date.now() - new Date(row.observed_at).getTime();
  return ageMs >= 0 && ageMs < ttlMinutes * 60 * 1000;
}

function parseObject(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function binanceSymbol(symbol = '') {
  return String(symbol || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

async function fetchJson(url, timeoutMs = 5000) {
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

async function fetchMarketFactorContext(candidate = {}, { lookbackDays = 60 } = {}) {
  if (candidate.exchange !== 'binance') return candidate;
  const symbol = binanceSymbol(candidate.symbol);
  if (!symbol) return candidate;
  const limit = Math.max(5, Math.min(120, Number(lookbackDays || 60)));
  const [klines, ticker] = await Promise.all([
    fetchJson(`https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1d&limit=${limit}`).catch(() => null),
    fetchJson(`https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`).catch(() => null),
  ]);
  const bars = Array.isArray(klines)
    ? klines.map((row) => ({
      close: Number(row?.[4]),
      high: Number(row?.[2]),
      low: Number(row?.[3]),
      volume: Number(row?.[5]),
    })).filter((bar) => Number.isFinite(bar.close) && bar.close > 0)
    : null;
  return {
    ...candidate,
    bars: bars?.length ? bars : candidate.bars,
    quoteVolume: Number(ticker?.quoteVolume || candidate.quoteVolume || 0) || candidate.quoteVolume,
    factorContext: {
      ...(candidate.factorContext || {}),
      marketDataSource: bars?.length ? 'binance_public_1d_klines' : 'candidate_fallback',
      tickerSource: ticker?.symbol ? 'binance_public_24hr_ticker' : 'candidate_fallback',
    },
  };
}

async function latestFactorShadow(queryFn, { symbol, exchange, ttlMinutes, force }) {
  if (!symbol || !exchange) return null;
  const rows = await Promise.resolve(queryFn(
    `SELECT *
       FROM investment.luna_factor_model_shadow
      WHERE symbol = $1
        AND exchange = $2
      ORDER BY observed_at DESC
      LIMIT 1`,
    [symbol, exchange],
  )).catch(() => []);
  const row = Array.isArray(rows) ? rows[0] || null : null;
  return freshEnough(row, ttlMinutes, force) ? normalizeFactorShadowRow(row) : null;
}

async function latestRegime(queryFn, market) {
  const rows = await Promise.resolve(queryFn(
    `SELECT market, regime, confidence, indicators, captured_at
       FROM investment.market_regime_snapshots
      WHERE market = $1
      ORDER BY captured_at DESC
      LIMIT 1`,
    [market],
  )).catch(() => []);
  const row = Array.isArray(rows) ? rows[0] || null : null;
  return row ? {
    market,
    regime: row.regime || null,
    regimeConfidence: Number(row.confidence || 0),
    indicators: parseObject(row.indicators, {}),
    capturedAt: row.captured_at || null,
  } : { market, regime: null, regimeConfidence: null, indicators: {}, capturedAt: null };
}

function candidateFromTrigger(trigger = {}, exchange = 'binance') {
  const triggerContext = parseObject(trigger.trigger_context, trigger.trigger_context || {});
  const triggerMeta = parseObject(trigger.trigger_meta, trigger.trigger_meta || {});
  const blockMeta = parseObject(trigger.block_meta, trigger.block_meta || triggerMeta || {});
  return {
    id: trigger.id || trigger.trigger_id || null,
    symbol: trigger.symbol,
    exchange,
    market: marketForFactorExchange(exchange),
    confidence: Number(trigger.confidence || 0),
    predictiveScore: Number(trigger.predictive_score ?? trigger.predictiveScore ?? 0),
    entry_price: trigger.target_price ?? trigger.entry_price ?? triggerMeta.entry_price ?? triggerMeta.entryPrice ?? null,
    atr: triggerMeta.atr ?? triggerMeta.atr_value ?? triggerContext.hints?.atr ?? null,
    quoteVolume: triggerMeta.quoteVolume ?? triggerMeta.quote_volume ?? triggerContext.quoteVolume ?? null,
    fundamentals: triggerMeta.fundamentals || triggerContext.fundamentals || null,
    trigger_context: triggerContext,
    trigger_meta: triggerMeta,
    block_meta: blockMeta,
    factorContext: triggerMeta.factorContext || triggerContext.factorContext || {},
  };
}

async function fetchCandidates({ exchange, symbol, limit, hours }, deps) {
  const listFn = deps.listActiveEntryTriggers || listActiveEntryTriggers;
  const since = new Date(Date.now() - Math.max(1, Number(hours || 24)) * 60 * 60 * 1000).toISOString();
  const rows = await Promise.resolve(listFn({
    exchange,
    symbol,
    states: ['armed', 'waiting', 'fired'],
    limit,
    updatedAfter: since,
    orderBy: 'updated_desc',
  })).catch(() => []);
  return (Array.isArray(rows) ? rows : []).map((row) => candidateFromTrigger(row, exchange));
}

async function insertFactorShadow(runFn, payload) {
  await Promise.resolve(runFn(
    `INSERT INTO investment.luna_factor_model_shadow
       (symbol, exchange, market, factor_scores, composite_score, rank, allocation_hint, data_health, context_evidence, shadow_only)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8,$9::jsonb,$10)`,
    [
      payload.symbol,
      payload.exchange,
      payload.market,
      JSON.stringify(payload.factorScores || {}),
      payload.compositeScore,
      payload.rank,
      JSON.stringify(payload.allocationHint || {}),
      payload.dataHealth,
      JSON.stringify(payload.evidence || {}),
      true,
    ],
  ));
}

async function analyzeExchange(exchange, options, deps, marketContext) {
  const queryFn = deps.query || db.query;
  const marketFactorContextFn = deps.fetchMarketFactorContext || fetchMarketFactorContext;
  const candidates = await fetchCandidates({
    exchange,
    symbol: options.symbol,
    limit: options.limit,
    hours: options.hours,
  }, deps);
  const rows = [];
  for (const candidate of candidates) {
    const existing = await latestFactorShadow(queryFn, {
      symbol: candidate.symbol,
      exchange,
      ttlMinutes: options.ttlMinutes,
      force: options.force,
    });
    if (existing) {
      rows.push({
        ...existing,
        status: 'cached',
        reason: 'fresh_shadow_exists',
        written: false,
      });
      continue;
    }
    const enrichedCandidate = await Promise.resolve(marketFactorContextFn(candidate, {
      lookbackDays: options.lookbackDays,
    })).catch(() => candidate);
    rows.push({
      ...buildFactorModelShadow(enrichedCandidate, {
        exchange,
        market: marketForFactorExchange(exchange),
        marketContext,
        source: enrichedCandidate.factorContext?.marketDataSource || 'entry_triggers',
      }),
      status: 'planned',
      reason: options.apply && options.confirm === CONFIRM_TOKEN ? 'write_planned' : 'apply_confirm_required',
      written: false,
    });
  }
  return rankFactorModelShadows(rows);
}

export async function runLunaFactorModelShadow(options = parseArgs(), deps = {}) {
  if (process.env.LUNA_FACTOR_MODEL_SHADOW_ENABLED === 'false') {
    return {
      ok: true,
      status: 'luna_factor_model_shadow_disabled',
      apply: options.apply,
      confirmRequired: CONFIRM_TOKEN,
      rows: [],
    };
  }

  const queryFn = deps.query || db.query;
  const runFn = deps.run || db.run;
  const initSchema = deps.initSchema || db.initSchema;
  const canWrite = options.apply && options.confirm === CONFIRM_TOKEN;
  if (canWrite && initSchema) {
    await Promise.resolve(initSchema()).catch(() => null);
  }

  const rows = [];
  for (const exchange of options.exchanges) {
    const market = marketForFactorExchange(exchange);
    const regime = await latestRegime(queryFn, market);
    rows.push(...await analyzeExchange(exchange, options, deps, {
      regime: regime.regime,
      regimeConfidence: regime.regimeConfidence,
      marketReturn: regime.indicators?.marketReturn ?? regime.indicators?.return ?? null,
    }));
  }

  if (canWrite) {
    for (const row of rows.filter((item) => item.status === 'planned' && item.ok)) {
      await insertFactorShadow(runFn, row);
      row.status = 'written';
      row.reason = 'factor_shadow_written';
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
      ? 'luna_factor_model_shadow_written'
      : planned > 0
        ? 'luna_factor_model_shadow_planned'
        : cached > 0
          ? 'luna_factor_model_shadow_cached'
          : 'luna_factor_model_shadow_skipped',
    apply: options.apply,
    confirmRequired: CONFIRM_TOKEN,
    summary: {
      candidates: rows.length,
      written,
      planned,
      cached,
      insufficient,
      llmCalls: 0,
      liveMutation: false,
    },
    rows,
  };
}

async function main() {
  const result = await runLunaFactorModelShadow(parseArgs());
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${result.status} candidates=${result.summary?.candidates || 0} written=${result.summary?.written || 0}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna factor model shadow 오류:',
  });
}
