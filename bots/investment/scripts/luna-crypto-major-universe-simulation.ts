#!/usr/bin/env node
// @ts-nocheck

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { query } from '../shared/db/core.ts';
import { buildBinanceTopVolumeUniverse } from '../shared/binance-top-volume-universe.ts';
import { buildEntryTriggerFireReadiness } from '../shared/entry-trigger-engine.ts';
import { strategySignalToEntryCandidate } from '../shared/brokers/strategy-to-entry-trigger-adapter.ts';

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 180;
const DEFAULT_BROAD_LIMIT = 20;
const DEFAULT_STRICT_LIMIT = 10;
const DEFAULT_ROUND_TRIP_COST_PCT = 0.30;
const CACHE_DIR = path.join(os.homedir(), '.ai-agent-system', 'cache', 'luna', 'crypto-major-universe-simulation');
const REPORT_DIR = path.join(os.homedir(), '.ai-agent-system', 'reports');
const COINGECKO_MARKETS_URL = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false';
const BINANCE_EXCHANGE_INFO_URL = 'https://api.binance.com/api/v3/exchangeInfo';
const BINANCE_TICKER_URL = 'https://api.binance.com/api/v3/ticker/24hr';
const BINANCE_KLINES_URL = 'https://api.binance.com/api/v3/klines';

const STABLE_OR_FIAT = new Set([
  'USDT', 'USDC', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'BUSD', 'PYUSD', 'USD1',
  'USDS', 'USDE', 'USD0', 'RLUSD', 'BFUSD', 'USDTB', 'SUSDS', 'SUSDE', 'U',
  'EUR', 'EURT', 'AEUR', 'EURI', 'GBP', 'AUD', 'BRL', 'TRY', 'RUB', 'UAH',
  'BIDR', 'IDRT', 'NGN', 'ZAR', 'JPY', 'KRW', 'CHF', 'CAD',
]);
const GOLD_BACKED = new Set(['XAUT', 'PAXG']);
const LEVERAGED_SUFFIX = /(UP|DOWN|BULL|BEAR)$/;

function finiteNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 4) {
  const number = finiteNumber(value, null);
  return number == null ? null : Number(number.toFixed(digits));
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, finiteNumber(value, min)));
}

function mean(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function median(values) {
  const usable = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!usable.length) return null;
  const middle = Math.floor(usable.length / 2);
  return usable.length % 2 ? usable[middle] : (usable[middle - 1] + usable[middle]) / 2;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canonicalSymbol(value) {
  const raw = String(value || '').trim().toUpperCase().replace('-', '/');
  if (!raw) return '';
  if (raw.includes('/')) return raw;
  return raw.endsWith('USDT') ? `${raw.slice(0, -4)}/USDT` : raw;
}

function baseAsset(value) {
  return canonicalSymbol(value).split('/')[0];
}

function binanceSymbol(value) {
  const canonical = canonicalSymbol(value);
  return canonical.includes('/') ? canonical.replace('/', '') : canonical;
}

function isSmokeSymbol(value) {
  return /(^|[_/-])SMOKE([_/-]|$)|(^|[_/-])TEST([_/-]|$)/i.test(String(value || ''));
}

function isEligibleBase(value) {
  const base = String(value || '').trim().toUpperCase();
  return Boolean(base)
    && !STABLE_OR_FIAT.has(base)
    && !GOLD_BACKED.has(base)
    && !LEVERAGED_SUFFIX.test(base)
    && !isSmokeSymbol(base);
}

export function buildUniverseGroups({
  topVolumeSymbols = [],
  marketRows = [],
  tradableSymbols = new Set(),
  broadLimit = DEFAULT_BROAD_LIMIT,
  strictLimit = DEFAULT_STRICT_LIMIT,
} = {}) {
  const tradable = new Set([...tradableSymbols].map((symbol) => String(symbol || '').toUpperCase()));
  const unique = (items) => [...new Set(items)];
  const A = unique(topVolumeSymbols.map(canonicalSymbol))
    .filter((symbol) => isEligibleBase(baseAsset(symbol)));
  const rankedMajors = [...marketRows]
    .filter((row) => isEligibleBase(row?.symbol))
    .filter((row) => tradable.has(`${String(row.symbol).toUpperCase()}USDT`))
    .sort((left, right) => {
      const leftRank = finiteNumber(left?.market_cap_rank, Number.MAX_SAFE_INTEGER);
      const rightRank = finiteNumber(right?.market_cap_rank, Number.MAX_SAFE_INTEGER);
      return leftRank - rightRank;
    });
  const B = unique(rankedMajors.map((row) => canonicalSymbol(`${row.symbol}/USDT`)))
    .slice(0, Math.max(1, Number(broadLimit || DEFAULT_BROAD_LIMIT)));
  const C = B.slice(0, Math.min(B.length, Math.max(1, Number(strictLimit || DEFAULT_STRICT_LIMIT))));
  const broadSet = new Set(B);
  const D = A.filter((symbol) => broadSet.has(symbol));
  return { A, B, C, D };
}

export function filterEligibleBinanceTickerRows(tickerRows = [], exchangeInfo = {}) {
  const baseBySymbol = new Map((exchangeInfo?.symbols || []).map((row) => [
    String(row?.symbol || '').toUpperCase(),
    String(row?.baseAsset || '').toUpperCase(),
  ]));
  return tickerRows.filter((row) => isEligibleBase(baseBySymbol.get(String(row?.symbol || '').toUpperCase())));
}

export function finalizeCoveredUniverseGroups({
  candidateGroups = {},
  dataQuality = [],
  broadLimit = DEFAULT_BROAD_LIMIT,
  strictLimit = DEFAULT_STRICT_LIMIT,
  minimumHourlyRows = DEFAULT_DAYS * 20,
  minimumDailyRows = DEFAULT_DAYS,
} = {}) {
  const qualityBySymbol = new Map(dataQuality.map((item) => [canonicalSymbol(item.symbol), item]));
  const accepted = [];
  const rejected = [];
  for (const symbol of candidateGroups.B || []) {
    const quality = qualityBySymbol.get(canonicalSymbol(symbol));
    const reasons = [];
    if (!quality || quality.hourlyRows < minimumHourlyRows) reasons.push('insufficient_1h_history');
    if (!quality || quality.dailyRows < minimumDailyRows) reasons.push('insufficient_1d_history');
    if (reasons.length) rejected.push({ symbol, reasons, hourlyRows: quality?.hourlyRows ?? 0, dailyRows: quality?.dailyRows ?? 0 });
    else if (accepted.length < broadLimit) accepted.push(symbol);
  }
  const A = [...(candidateGroups.A || [])];
  const B = accepted;
  const C = B.slice(0, Math.min(B.length, strictLimit));
  const broadSet = new Set(B);
  const D = A.filter((symbol) => broadSet.has(symbol));
  return {
    groups: { A, B, C, D },
    coverage: { minimumHourlyRows, minimumDailyRows, rejected },
  };
}

export function normalizeKlineRows(rawRows, { interval = '1h', symbol = '' } = {}) {
  if (!Array.isArray(rawRows)) throw new Error(`kline_raw_shape_invalid:${symbol}:${interval}`);
  const threshold = interval === '1d' ? 0.80 : 0.50;
  const rows = [];
  const outliers = [];
  let previousOpenTime = -1;
  let previousClose = null;

  for (const raw of rawRows) {
    if (!Array.isArray(raw) || raw.length < 12) {
      throw new Error(`kline_raw_shape_invalid:${symbol}:${interval}`);
    }
    const row = {
      openTime: finiteNumber(raw[0], null),
      open: finiteNumber(raw[1], null),
      high: finiteNumber(raw[2], null),
      low: finiteNumber(raw[3], null),
      close: finiteNumber(raw[4], null),
      volume: finiteNumber(raw[5], null),
      closeTime: finiteNumber(raw[6], null),
      trades: finiteNumber(raw[8], null),
    };
    const numbers = [row.openTime, row.open, row.high, row.low, row.close, row.volume, row.closeTime];
    if (
      numbers.some((value) => value == null)
      || row.openTime <= previousOpenTime
      || row.open <= 0
      || row.high <= 0
      || row.low <= 0
      || row.close <= 0
      || row.volume < 0
      || row.high < Math.max(row.open, row.close, row.low)
      || row.low > Math.min(row.open, row.close, row.high)
    ) {
      throw new Error(`kline_value_invalid:${symbol}:${interval}:${row.openTime}`);
    }
    const returnRatio = previousClose == null ? 0 : row.close / previousClose - 1;
    row.isOutlier = Math.abs(returnRatio) > threshold;
    if (row.isOutlier) {
      outliers.push({
        symbol: canonicalSymbol(symbol),
        interval,
        openTime: row.openTime,
        returnPct: round(returnRatio * 100),
      });
    }
    rows.push(row);
    previousOpenTime = row.openTime;
    previousClose = row.close;
  }

  return {
    rows,
    outliers,
    rawShapeValid: true,
    epochUnit: 'milliseconds',
    sourceTimezone: 'UTC',
  };
}

export function resolveClosedKlineCutoffs(now = Date.now()) {
  const timestamp = finiteNumber(now, Date.now());
  return {
    hourlyEndTime: Math.floor(timestamp / 3_600_000) * 3_600_000 - 1,
    dailyEndTime: Math.floor(timestamp / DAY_MS) * DAY_MS - 1,
  };
}

function analyzeFrame(rows) {
  if (!Array.isArray(rows) || rows.length < 20) {
    return { signal: 'NEUTRAL', confidence: 0, volumeBurst: 0, fast: null, slow: null, change: null };
  }
  const closes = rows.map((row) => row.close);
  const latest = closes.at(-1);
  const previous = closes.at(-4);
  const fast = mean(closes.slice(-5));
  const slow = mean(closes.slice(-20));
  const recentChange = previous > 0 ? latest / previous - 1 : 0;
  const volumes = rows.map((row) => row.volume);
  const averageVolume = mean(volumes.slice(-20));
  const volumeBurst = averageVolume > 0 ? volumes.at(-1) / averageVolume : 0;
  const bullish = latest >= slow && fast >= slow && recentChange >= -0.003;
  const bearish = latest < slow && fast < slow && recentChange <= 0.003;
  const signal = bullish ? 'BUY' : bearish ? 'SELL' : 'NEUTRAL';
  const trendSpread = slow > 0 ? Math.abs(fast / slow - 1) : 0;
  const confidence = clamp(0.45 + trendSpread * 8 + Math.abs(recentChange) * 3 + Math.min(volumeBurst, 3) * 0.03, 0.45, 0.90);
  return {
    signal,
    confidence: round(confidence),
    volumeBurst: round(volumeBurst),
    fast: round(fast, 8),
    slow: round(slow, 8),
    change: round(recentChange, 8),
  };
}

export function buildReplayCandidate({
  symbol,
  close,
  targetPrice,
  hourlyFrame = {},
  dailyFrame = {},
  breakoutRetest = false,
  predictiveScore = 0,
} = {}) {
  const bullishFrames = [hourlyFrame, dailyFrame].filter((frame) => frame?.signal === 'BUY').length;
  const mtfAgreement = bullishFrames / 2;
  const alignmentScore = bullishFrames === 2 ? 0.24 : bullishFrames === 1 ? 0.08 : -0.18;
  const matched = bullishFrames === 2;
  const candidate = strategySignalToEntryCandidate({
    signalType: 'entry',
    symbol: canonicalSymbol(symbol),
    market: 'crypto',
    family: 'testah_pullback',
    price: close,
    stop: targetPrice * 0.98,
    target: close + Math.max(close - targetPrice, close * 0.01) * 2,
    rr: 2,
    matched,
    reason: 'offline_1h_1d_pullback_replay',
    regime: { dominant: dailyFrame?.signal === 'BUY' ? 'bull' : 'ranging' },
    details: {
      regimeMatched: matched,
      maFast: hourlyFrame?.fast ?? close,
      previousHigh: targetPrice,
    },
  });
  if (!candidate) throw new Error(`entry_candidate_build_failed:${symbol}`);
  const discoveryScore = clamp(
    0.50
      + mtfAgreement * 0.16
      + Math.max(0, finiteNumber(hourlyFrame?.confidence, 0) - 0.5) * 0.2
      + Math.max(0, finiteNumber(dailyFrame?.confidence, 0) - 0.5) * 0.2,
    0,
    0.90,
  );
  candidate.predictiveScore = clamp(predictiveScore);
  candidate.triggerHints = {
    ...candidate.triggerHints,
    discoveryScore: round(discoveryScore),
    mtfAgreement: round(mtfAgreement),
    mtfAlignmentScore: alignmentScore,
    mtfDominantSignal: matched ? 'BUY' : hourlyFrame?.signal || 'NEUTRAL',
    breakoutRetest: breakoutRetest === true,
    volumeBurst: round(Math.max(finiteNumber(hourlyFrame?.volumeBurst, 0), finiteNumber(dailyFrame?.volumeBurst, 0))),
    technicalTelemetry: {
      mtfAvailable: true,
      volumeAvailable: true,
      intervals: ['1h', '1d'],
      offlineReplay: true,
    },
  };
  const readiness = buildEntryTriggerFireReadiness(candidate, {
    pullbackMinConfidence: 0.62,
    pullbackMinPredictiveScore: 0.55,
    pullbackMinDiscoveryScore: 0.58,
  });
  return { candidate, readiness };
}

function summarizeOutcome(values) {
  const usable = values.map((value) => finiteNumber(value, null)).filter((value) => value != null);
  return {
    available: usable.length,
    winRatePct: usable.length ? round(usable.filter((value) => value > 0).length / usable.length * 100, 2) : null,
    meanPct: round(mean(usable)),
    medianPct: round(median(usable)),
    worstPct: usable.length ? round(Math.min(...usable)) : null,
  };
}

export function summarizeReplay(events = [], periodDays = DEFAULT_DAYS) {
  const usable = events.filter((event) => !isSmokeSymbol(event?.symbol));
  return {
    fires: usable.length,
    uniqueSymbols: new Set(usable.map((event) => canonicalSymbol(event.symbol))).size,
    frequencyPer30Days: round(usable.length / Math.max(1, Number(periodDays || DEFAULT_DAYS)) * 30),
    d1: summarizeOutcome(usable.map((event) => event.d1NetPct)),
    d5: summarizeOutcome(usable.map((event) => event.d5NetPct)),
    d20: summarizeOutcome(usable.map((event) => event.d20NetPct)),
  };
}

function summarizeRows(rows, { pnlPctField, pnlAmountField, winField = null } = {}) {
  const pctValues = rows.map((row) => finiteNumber(row?.[pnlPctField], null)).filter((value) => value != null);
  const amountValues = rows.map((row) => finiteNumber(row?.[pnlAmountField], null)).filter((value) => value != null);
  const winValues = rows
    .map((row) => finiteNumber(row?.[winField || pnlPctField], null))
    .filter((value) => value != null);
  const symbols = {};
  for (const row of rows) {
    const symbol = canonicalSymbol(row?.symbol);
    symbols[symbol] = (symbols[symbol] || 0) + 1;
  }
  return {
    count: rows.length,
    pnlAvailable: pctValues.length,
    pnlAmountAvailable: amountValues.length,
    winBasis: winField || pnlPctField || null,
    winRatePct: winValues.length ? round(winValues.filter((value) => value > 0).length / winValues.length * 100, 2) : null,
    pnlPctMean: round(mean(pctValues)),
    pnlPctMedian: round(median(pctValues)),
    pnlPctWorst: pctValues.length ? round(Math.min(...pctValues)) : null,
    pnlPctUnit: pctValues.length ? 'percent_points' : null,
    pnlAmountTotal: amountValues.length ? round(amountValues.reduce((sum, value) => sum + value, 0)) : null,
    pnlAmountMean: round(mean(amountValues)),
    pnlAmountMedian: round(median(amountValues)),
    pnlAmountWorst: amountValues.length ? round(Math.min(...amountValues)) : null,
    pnlAmountUnit: amountValues.length ? 'USDT' : null,
    pnlPctOutlierCount: pctValues.filter((value) => Math.abs(value) > 1_000).length,
    symbolDistribution: Object.entries(symbols)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 20)
      .map(([symbol, count]) => ({ symbol, count })),
  };
}

export function classifyHistoricalRows(rows = [], groups = {}, options = {}) {
  const usable = rows.filter((row) => !isSmokeSymbol(row?.symbol));
  return Object.fromEntries(['A', 'B', 'C', 'D'].map((name) => {
    const members = new Set((groups?.[name] || []).map(canonicalSymbol));
    const selected = usable.filter((row) => members.has(canonicalSymbol(row?.symbol)));
    return [name, summarizeRows(selected, options)];
  }));
}

function hasRecordedGuardBlock(row) {
  const meta = row?.trigger_meta || {};
  const reason = String(meta.reason || '').toLowerCase();
  return /(?:gate|guard)_blocked/.test(reason)
    || meta?.tradingViewGuard?.blocked === true
    || meta?.entryChartGuard?.blocked === true
    || meta?.riskGateDetails?.blocked === true;
}

export function summarizeEntryRows(rows, groups) {
  const usable = rows.filter((row) => !isSmokeSymbol(row?.symbol));
  return Object.fromEntries(['A', 'B', 'C', 'D'].map((name) => {
    const members = new Set((groups?.[name] || []).map(canonicalSymbol));
    const selected = usable.filter((row) => members.has(canonicalSymbol(row?.symbol)));
    const fires = selected.filter((row) => row?.fired_at || String(row?.trigger_state || '').toLowerCase() === 'fired').length;
    const blocked = selected.filter(hasRecordedGuardBlock).length;
    const expired = selected.filter((row) => String(row?.trigger_state || '').toLowerCase() === 'expired').length;
    const symbols = {};
    selected.forEach((row) => {
      const symbol = canonicalSymbol(row.symbol);
      symbols[symbol] = (symbols[symbol] || 0) + 1;
    });
    return [name, {
      count: selected.length,
      fires,
      fireRatePct: selected.length ? round(fires / selected.length * 100, 2) : null,
      guardBlocked: blocked,
      guardBlockRatePct: selected.length ? round(blocked / selected.length * 100, 2) : null,
      expired,
      expiredRatePct: selected.length ? round(expired / selected.length * 100, 2) : null,
      symbolDistribution: Object.entries(symbols)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 20)
        .map(([symbol, count]) => ({ symbol, count })),
    }];
  }));
}

function summarizeLlmRows(rows, groups) {
  const usable = rows.filter((row) => !isSmokeSymbol(row?.symbol));
  return Object.fromEntries(['A', 'B', 'C', 'D'].map((name) => {
    const members = new Set((groups?.[name] || []).map(canonicalSymbol));
    const selected = usable.filter((row) => members.has(canonicalSymbol(row?.symbol)));
    const deterministicFires = selected.filter((row) => row?.deterministic_fire === true).length;
    const llmFires = selected.filter((row) => row?.llm_fire === true).length;
    return [name, {
      count: selected.length,
      deterministicFires,
      llmFires,
      deterministicFireRatePct: selected.length ? round(deterministicFires / selected.length * 100, 2) : null,
      llmFireRatePct: selected.length ? round(llmFires / selected.length * 100, 2) : null,
    }];
  }));
}

async function loadLayer1(groups, days = 90) {
  const journal = await query(`
    SELECT symbol, exchange, status, pnl_amount, pnl_percent, pnl_net, created_at
      FROM trade_journal
     WHERE LOWER(COALESCE(exchange, '')) = 'binance'
       AND CASE
             WHEN created_at > 100000000000 THEN to_timestamp(created_at / 1000.0)
             ELSE to_timestamp(created_at)
           END >= NOW() - ($1::text || ' days')::interval
  `, [days]);
  const closeouts = await query(`
    SELECT symbol, exchange, pnl_realized, slippage_pct, fee_total, review_status, created_at
      FROM position_closeout_reviews
     WHERE LOWER(COALESCE(exchange, '')) = 'binance'
       AND created_at >= NOW() - ($1::text || ' days')::interval
  `, [days]);
  const triggers = await query(`
    SELECT symbol, exchange, trigger_state, trigger_type, confidence, predictive_score,
           trigger_meta, fired_at, created_at
      FROM entry_triggers
     WHERE LOWER(COALESCE(exchange, '')) = 'binance'
       AND created_at >= NOW() - ($1::text || ' days')::interval
  `, [days]);
  const llmShadow = await query(`
    SELECT symbol, exchange, deterministic_fire, llm_fire,
           deterministic_confidence, llm_confidence, observed_at
      FROM luna_entry_llm_shadow
     WHERE LOWER(COALESCE(exchange, '')) = 'binance'
       AND observed_at >= NOW() - ($1::text || ' days')::interval
  `, [days]);

  return {
    lookbackDays: days,
    sourceRows: {
      tradeJournal: journal.length,
      closeoutReviews: closeouts.length,
      entryTriggers: triggers.length,
      entryLlmShadow: llmShadow.length,
    },
    tradeJournal: classifyHistoricalRows(journal, groups, {
      pnlPctField: 'pnl_percent',
      pnlAmountField: 'pnl_net',
    }),
    closeoutReviews: classifyHistoricalRows(closeouts, groups, {
      winField: 'pnl_realized',
      pnlAmountField: 'pnl_realized',
    }),
    entryTriggers: summarizeEntryRows(triggers, groups),
    entryLlmShadow: summarizeLlmRows(llmShadow, groups),
    exclusions: ['SMOKE', 'TEST'],
  };
}

async function fetchJson(url, { attempts = 3, timeoutMs = 30_000 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'LunaCryptoMajorUniverseSimulation/1.0' },
      });
      if (!response.ok) throw new Error(`http_${response.status}:${url}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(300 * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function loadCachedJson(file, loader, { refresh = false } = {}) {
  if (!refresh) {
    try {
      return { data: await readJson(file), cached: true, file };
    } catch {
      // Cache miss is the only reason to call the external source.
    }
  }
  const data = await loader();
  await writeJson(file, data);
  return { data, cached: false, file };
}

function cacheName(prefix, value) {
  const digest = createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
  return path.join(CACHE_DIR, `${prefix}-${digest}.json`);
}

async function fetchKlineRange(symbol, interval, startTime, endTime) {
  const all = [];
  let cursor = startTime;
  const step = interval === '1d' ? DAY_MS : 3_600_000;
  while (cursor < endTime) {
    const params = new URLSearchParams({
      symbol,
      interval,
      startTime: String(cursor),
      endTime: String(endTime),
      limit: '1000',
    });
    const page = await fetchJson(`${BINANCE_KLINES_URL}?${params}`);
    if (!Array.isArray(page)) throw new Error(`kline_response_not_array:${symbol}:${interval}`);
    if (!page.length) break;
    all.push(...page);
    const lastOpenTime = finiteNumber(page.at(-1)?.[0], null);
    if (lastOpenTime == null || lastOpenTime < cursor) throw new Error(`kline_cursor_invalid:${symbol}:${interval}`);
    cursor = lastOpenTime + step;
    if (page.length < 1000) break;
    await sleep(120);
  }
  return all;
}

async function loadKlines(symbol, interval, startTime, endTime, { refresh = false } = {}) {
  const key = `${symbol}:${interval}:${startTime}:${endTime}`;
  const file = cacheName('binance-klines', key);
  const loaded = await loadCachedJson(
    file,
    () => fetchKlineRange(symbol, interval, startTime, endTime),
    { refresh },
  );
  const rawSample = loaded.data[0] || null;
  return {
    ...normalizeKlineRows(loaded.data, { interval, symbol }),
    cached: loaded.cached,
    cacheFile: file,
    rawSampleLength: Array.isArray(rawSample) ? rawSample.length : null,
    rawSampleSha256: rawSample == null
      ? null
      : createHash('sha256').update(JSON.stringify(rawSample)).digest('hex'),
  };
}

export function findClosedDailyIndex(rows, timestamp) {
  let low = 0;
  let high = rows.length - 1;
  let answer = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].closeTime <= timestamp) {
      answer = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return answer;
}

export function findForwardDailyIndex(rows, entryTime, horizonDays) {
  const targetTime = Number(entryTime) + Number(horizonDays) * DAY_MS;
  if (!Number.isFinite(targetTime)) return -1;
  return rows.findIndex((row) => Number(row.closeTime) >= targetTime);
}

export function futureNetPct(dailyRows, entryTime, horizon, entryPrice, costPct) {
  const row = dailyRows[findForwardDailyIndex(dailyRows, entryTime, horizon)];
  if (!row || !Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  return round((row.close / entryPrice - 1) * 100 - costPct);
}

function replaySymbol({ symbol, hourlyRows, dailyRows, days, roundTripCostPct }) {
  const events = [];
  let lastFireAt = -Infinity;
  const cooldownMs = DAY_MS;
  for (let index = 50; index < hourlyRows.length; index += 1) {
    const current = hourlyRows[index];
    const decisionTime = Number(current.closeTime ?? current.openTime);
    if (current.isOutlier || decisionTime - lastFireAt < cooldownMs) continue;
    const dailyIndex = findClosedDailyIndex(dailyRows, decisionTime);
    if (dailyIndex < 20) continue;
    const hourlyWindow = hourlyRows.slice(Math.max(0, index - 39), index + 1);
    const dailyWindow = dailyRows.slice(Math.max(0, dailyIndex - 29), dailyIndex + 1);
    if (hourlyWindow.some((row) => row.isOutlier) || dailyWindow.some((row) => row.isOutlier)) continue;
    const hourlyFrame = analyzeFrame(hourlyWindow);
    const dailyFrame = analyzeFrame(dailyWindow);
    const support = mean(hourlyWindow.slice(-20).map((row) => row.close));
    const recentLow = Math.min(...hourlyWindow.slice(-6).map((row) => row.low));
    const breakoutRetest = support > 0 && recentLow <= support * 1.01 && current.close >= support;
    const dailySpread = dailyFrame.slow > 0 ? dailyFrame.fast / dailyFrame.slow - 1 : 0;
    const hourMomentum = hourlyWindow.at(-1).close / hourlyWindow.at(-25).close - 1;
    const predictiveScore = clamp(0.52 + Math.max(-0.05, hourMomentum) * 3 + Math.max(-0.05, dailySpread) * 4, 0, 0.90);
    const decision = buildReplayCandidate({
      symbol,
      close: current.close,
      targetPrice: support,
      hourlyFrame,
      dailyFrame,
      breakoutRetest,
      predictiveScore,
    });
    if (!decision.readiness.ok) continue;
    events.push({
      symbol: canonicalSymbol(symbol),
      firedAt: new Date(decisionTime).toISOString(),
      firedAtKst: new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Seoul',
        dateStyle: 'short',
        timeStyle: 'medium',
      }).format(new Date(decisionTime)),
      entryPrice: current.close,
      reason: decision.readiness.reason,
      d1NetPct: futureNetPct(dailyRows, decisionTime, 1, current.close, roundTripCostPct),
      d5NetPct: futureNetPct(dailyRows, decisionTime, 5, current.close, roundTripCostPct),
      d20NetPct: futureNetPct(dailyRows, decisionTime, 20, current.close, roundTripCostPct),
    });
    lastFireAt = decisionTime;
  }
  return events;
}

function summarizeGroupReplay(allEvents, groups, days) {
  return Object.fromEntries(['A', 'B', 'C', 'D'].map((name) => {
    const members = new Set((groups[name] || []).map(canonicalSymbol));
    return [name, summarizeReplay(allEvents.filter((event) => members.has(canonicalSymbol(event.symbol))), days)];
  }));
}

function buildComparisonTable(layer1, layer2) {
  return ['A', 'B', 'C', 'D'].map((name) => ({
    universe: name,
    members: layer2.groups[name].length,
    historicalJournalRows: layer1.tradeJournal[name].count,
    historicalJournalWinRatePct: layer1.tradeJournal[name].winRatePct,
    historicalEntryFireRatePct: layer1.entryTriggers[name].fireRatePct,
    historicalGuardBlockRatePct: layer1.entryTriggers[name].guardBlockRatePct,
    replayFires: layer2.summary[name].fires,
    replayD5WinRatePct: layer2.summary[name].d5.winRatePct,
    replayD5MeanPct: layer2.summary[name].d5.meanPct,
    replayD5MedianPct: layer2.summary[name].d5.medianPct,
    replayD5WorstPct: layer2.summary[name].d5.worstPct,
    replayFrequencyPer30Days: layer2.summary[name].frequencyPer30Days,
  }));
}

function marketCapWhiteList(groups, marketRows) {
  const byBase = new Map(marketRows.map((row) => [String(row?.symbol || '').toUpperCase(), row]));
  return groups.B.map((symbol) => {
    const row = byBase.get(baseAsset(symbol)) || {};
    return {
      symbol,
      marketCapRank: finiteNumber(row.market_cap_rank, null),
      marketCapUsd: finiteNumber(row.market_cap, null),
      sourceId: row.id || null,
    };
  });
}

function buildQualityGates({ groups, layer1, layer2 }) {
  const forbidden = new Set([...STABLE_OR_FIAT, ...GOLD_BACKED]);
  const allMembers = [...new Set(Object.values(groups).flat())];
  const dExpected = groups.A.filter((symbol) => new Set(groups.B).has(symbol));
  const qualities = layer2.dataQuality;
  const broadMembers = new Set(groups.B);
  const broadQualities = qualities.filter((item) => broadMembers.has(item.symbol));
  const outlierCount = qualities.reduce(
    (sum, item) => sum + item.hourlyOutliers.length + item.dailyOutliers.length,
    0,
  );
  return {
    '1_units': {
      pass: Object.values(layer1.tradeJournal).every((item) => item.pnlPctUnit == null || item.pnlPctUnit === 'percent_points')
        && Object.values(layer1.closeoutReviews).every((item) => item.pnlAmountUnit == null || item.pnlAmountUnit === 'USDT'),
      replayReturnUnit: 'percent_points_net_of_cost',
      historicalAmountUnit: 'USDT',
    },
    '2_missingness': {
      pass: broadQualities.length === groups.B.length
        && broadQualities.every((item) => (
          item.hourlyRows >= layer2.coverage.minimumHourlyRows
          && item.dailyRows >= layer2.coverage.minimumDailyRows
        )),
      nullForwardReturnsAreExcludedFromHorizonDenominators: true,
      broadUniverseCoverage: layer2.coverage,
    },
    '3_outliers': {
      pass: true,
      detectedKlineOutliers: outlierCount,
      policy: 'A fire is skipped when the current 1h row or its 40h/30d feature windows contain a detected outlier.',
    },
    '4_exclusions': {
      pass: allMembers.every((symbol) => !forbidden.has(baseAsset(symbol)) && !LEVERAGED_SUFFIX.test(baseAsset(symbol))),
      excludedClasses: ['stable', 'fiat', 'leveraged', 'XAUT', 'PAXG', 'SMOKE', 'TEST'],
    },
    '5_membership': {
      pass: JSON.stringify(groups.D) === JSON.stringify(dExpected)
        && new Set(groups.A).size === groups.A.length
        && new Set(groups.B).size === groups.B.length,
      dIsExactIntersection: true,
    },
    '6_costs': {
      pass: layer2.costAssumption.totalRoundTripCostPct > 0,
      ...layer2.costAssumption,
    },
    '7_read_only': {
      pass: true,
      dbWrites: 0,
      orderPathAccess: 0,
      databaseOperations: 'SELECT only',
    },
    '8_raw_samples': {
      pass: qualities.every((item) => item.hourlyRawSampleLength >= 12 && item.dailyRawSampleLength >= 12),
      actualApiSampleHashesRecorded: true,
      fixtureShapeCoveredBySmoke: true,
    },
    '9_time': {
      pass: qualities.every((item) => item.epochUnit === 'milliseconds'),
      sourceTimezone: 'UTC',
      presentationTimezone: 'Asia/Seoul',
      kstBoundaryExplicit: true,
    },
  };
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const item = process.argv.find((value) => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}

export async function runSimulation({
  days = DEFAULT_DAYS,
  broadLimit = DEFAULT_BROAD_LIMIT,
  strictLimit = DEFAULT_STRICT_LIMIT,
  roundTripCostPct = DEFAULT_ROUND_TRIP_COST_PCT,
  refresh = false,
  now = Date.now(),
} = {}) {
  await mkdir(CACHE_DIR, { recursive: true });
  const snapshotDate = new Date(now).toISOString().slice(0, 10);
  const { hourlyEndTime, dailyEndTime } = resolveClosedKlineCutoffs(now);
  const coinGecko = await loadCachedJson(
    path.join(CACHE_DIR, `coingecko-market-cap-${snapshotDate}.json`),
    () => fetchJson(COINGECKO_MARKETS_URL),
    { refresh },
  );
  const exchangeInfo = await loadCachedJson(
    path.join(CACHE_DIR, `binance-exchange-info-${snapshotDate}.json`),
    () => fetchJson(BINANCE_EXCHANGE_INFO_URL),
    { refresh },
  );
  const tickers = await loadCachedJson(
    path.join(CACHE_DIR, `binance-ticker-24h-${snapshotDate}.json`),
    () => fetchJson(BINANCE_TICKER_URL),
    { refresh },
  );
  const topVolume = buildBinanceTopVolumeUniverse({
    exchangeInfo: exchangeInfo.data,
    tickerRows: filterEligibleBinanceTickerRows(tickers.data, exchangeInfo.data),
    limit: 30,
    fetchedAt: new Date(now).toISOString(),
  });
  const tradableSymbols = new Set((exchangeInfo.data?.symbols || [])
    .filter((row) => row?.status === 'TRADING' && row?.quoteAsset === 'USDT' && row?.isSpotTradingAllowed !== false)
    .map((row) => String(row.symbol).toUpperCase()));
  const candidateGroups = buildUniverseGroups({
    topVolumeSymbols: topVolume.symbols,
    marketRows: coinGecko.data,
    tradableSymbols,
    broadLimit: broadLimit + 10,
    strictLimit,
  });
  if (candidateGroups.B.length < broadLimit) {
    throw new Error(`major_candidate_pool_too_small:B=${candidateGroups.B.length}`);
  }

  const startTime = hourlyEndTime - Math.max(180, Number(days || DEFAULT_DAYS)) * DAY_MS;
  const allSymbols = [...new Set([...candidateGroups.A, ...candidateGroups.B])];
  const allEvents = [];
  const dataQuality = [];
  let cacheHits = 0;
  let cacheMisses = 0;

  for (const [index, symbol] of allSymbols.entries()) {
    console.error(`[major-universe] klines ${index + 1}/${allSymbols.length} ${symbol}`);
    const rawSymbol = binanceSymbol(symbol);
    const hourly = await loadKlines(rawSymbol, '1h', startTime, hourlyEndTime, { refresh });
    const daily = await loadKlines(rawSymbol, '1d', startTime - 30 * DAY_MS, dailyEndTime, { refresh });
    cacheHits += Number(hourly.cached) + Number(daily.cached);
    cacheMisses += Number(!hourly.cached) + Number(!daily.cached);
    dataQuality.push({
      symbol,
      hourlyRows: hourly.rows.length,
      dailyRows: daily.rows.length,
      hourlyOutliers: hourly.outliers,
      dailyOutliers: daily.outliers,
      rawShapeValid: hourly.rawShapeValid && daily.rawShapeValid,
      hourlyRawSampleLength: hourly.rawSampleLength,
      dailyRawSampleLength: daily.rawSampleLength,
      hourlyRawSampleSha256: hourly.rawSampleSha256,
      dailyRawSampleSha256: daily.rawSampleSha256,
      epochUnit: 'milliseconds',
      sourceTimezone: 'UTC',
      presentationTimezone: 'Asia/Seoul',
    });
    allEvents.push(...replaySymbol({
      symbol,
      hourlyRows: hourly.rows,
      dailyRows: daily.rows,
      days,
      roundTripCostPct,
    }));
    if (index < allSymbols.length - 1) await sleep(120);
  }

  const minimumDays = Math.max(180, Number(days || DEFAULT_DAYS));
  const finalized = finalizeCoveredUniverseGroups({
    candidateGroups,
    dataQuality,
    broadLimit,
    strictLimit,
    minimumHourlyRows: minimumDays * 20,
    minimumDailyRows: minimumDays,
  });
  const groups = finalized.groups;
  if (groups.B.length < broadLimit || groups.C.length < Math.min(8, strictLimit)) {
    throw new Error(`major_universe_coverage_too_small:B=${groups.B.length}:C=${groups.C.length}`);
  }
  const selectedSymbols = new Set([...groups.A, ...groups.B]);
  const selectedEvents = allEvents.filter((event) => selectedSymbols.has(event.symbol));
  const layer1 = await loadLayer1(groups, 90);

  const layer2 = {
    lookbackDays: minimumDays,
    intervals: ['1h', '1d'],
    dataCutoffs: {
      hourlyLastClosedBefore: new Date(hourlyEndTime + 1).toISOString(),
      dailyLastClosedBefore: new Date(dailyEndTime + 1).toISOString(),
    },
    groups,
    coverage: finalized.coverage,
    summary: summarizeGroupReplay(selectedEvents, groups, minimumDays),
    eventCount: selectedEvents.length,
    events: selectedEvents,
    costAssumption: {
      roundTripFeePct: 0.20,
      slippagePct: round(roundTripCostPct - 0.20),
      totalRoundTripCostPct: roundTripCostPct,
    },
    cache: { directory: CACHE_DIR, hits: cacheHits, misses: cacheMisses },
    dataQuality,
  };
  const report = {
    status: 'done',
    generatedAt: new Date().toISOString(),
    readOnly: true,
    dbWrites: 0,
    orderPathAccess: 0,
    universes: {
      A: 'current Binance USDT spot top-30 by 24h quote volume',
      B: `CoinGecko market-cap majors tradable on Binance USDT spot, top ${groups.B.length}`,
      C: `strict market-cap majors, top ${groups.C.length}`,
      D: 'intersection of A and B',
      groups,
    },
    whiteList: marketCapWhiteList(groups, coinGecko.data),
    sources: {
      marketCap: { url: COINGECKO_MARKETS_URL, snapshotDate, cached: coinGecko.cached },
      binanceExchangeInfo: { url: BINANCE_EXCHANGE_INFO_URL, snapshotDate, cached: exchangeInfo.cached },
      binanceTicker24h: { url: BINANCE_TICKER_URL, snapshotDate, cached: tickers.cached },
      binanceKlines: { url: BINANCE_KLINES_URL, intervals: ['1h', '1d'] },
      database: ['trade_journal', 'position_closeout_reviews', 'entry_triggers', 'luna_entry_llm_shadow'],
    },
    layer1,
    layer2,
    comparison: buildComparisonTable(layer1, layer2),
    limitations: [
      'A and D use the current 24h-volume snapshot across the full replay window, so survivorship and current-membership bias remain.',
      'B requires at least 3,600 hourly and 180 daily rows per member; A is the current-volume baseline and includes each member\'s available history, so newly listed A members have shorter replay exposure.',
      'B and C use a current CoinGecko market-cap snapshot rather than historical constituents, so delisted or fallen assets are absent.',
      'The replay reuses the current pure entry-fire decision but reconstructs only 1h/1d technical inputs; it does not reproduce historical news, LLM, portfolio, balance, or live guard state.',
      `Returns are virtual close-to-close outcomes with a fixed ${roundTripCostPct}% round-trip fee/slippage deduction; fills, spread, funding, and market impact are not simulated.`,
      'Layer-1 closeout wins and losses use the sign of pnl_realized; slippage_pct is not treated as a return or win criterion.',
    ],
  };
  report.qualityGates = buildQualityGates({ groups, layer1, layer2 });
  const reportPath = path.join(REPORT_DIR, `luna-crypto-major-universe-simulation-${snapshotDate.replaceAll('-', '')}.json`);
  await writeJson(reportPath, report);
  return { reportPath, report };
}

if (isDirectExecution(import.meta.url)) {
  runCliMain({
    run: () => runSimulation({
      days: Number(argValue('days', DEFAULT_DAYS)),
      broadLimit: Number(argValue('broad-limit', DEFAULT_BROAD_LIMIT)),
      strictLimit: Number(argValue('strict-limit', DEFAULT_STRICT_LIMIT)),
      roundTripCostPct: Number(argValue('cost-pct', DEFAULT_ROUND_TRIP_COST_PCT)),
      refresh: process.argv.includes('--refresh'),
    }),
    onSuccess: ({ reportPath, report }) => {
      if (process.argv.includes('--json')) {
        console.log(JSON.stringify({ status: report.status, reportPath, comparison: report.comparison }, null, 2));
      } else {
        console.log(`[luna-crypto-major-universe-simulation] ${report.status} ${reportPath}`);
      }
    },
    errorPrefix: '[luna-crypto-major-universe-simulation] failed:',
  });
}
