// @ts-nocheck
/**
 * Entry chart guard for Luna entry triggers.
 *
 * The guard is intentionally opt-in via LUNA_TRADINGVIEW_ENTRY_GUARD_ENABLED.
 * Crypto uses TradingView, while domestic/overseas equities use KIS official
 * market data only. KRX/TradingView stock routing is intentionally deferred.
 */

import { execFileSync } from 'node:child_process';

const DISABLE_VALUES = new Set(['0', 'false', 'off', 'disabled', 'no']);
const ENABLE_VALUES = new Set(['1', 'true', 'on', 'enabled', 'yes']);
const launchctlCache = new Map();

function launchctlEnv(name) {
  if (launchctlCache.has(name)) return launchctlCache.get(name);
  let value = '';
  try {
    value = execFileSync('launchctl', ['getenv', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 500,
    }).trim();
  } catch {
    value = '';
  }
  launchctlCache.set(name, value);
  return value;
}

function envRaw(name, env = process.env) {
  const raw = String(env[name] ?? '').trim();
  if (raw) return raw;
  if (env === process.env) return launchctlEnv(name);
  return '';
}

function strEnv(name, fallback = '', env = process.env) {
  const raw = envRaw(name, env);
  return raw || fallback;
}

function numEnv(name, fallback = 0, env = process.env) {
  const raw = envRaw(name, env);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function boolEnv(name, fallback = false, env = process.env) {
  const raw = envRaw(name, env).toLowerCase();
  if (!raw) return fallback;
  if (ENABLE_VALUES.has(raw)) return true;
  if (DISABLE_VALUES.has(raw)) return false;
  return fallback;
}

function normalizeMarket(exchange = '') {
  const value = String(exchange || '').trim().toLowerCase();
  if (value === 'binance' || value === 'crypto') return 'binance';
  if (value === 'kis' || value === 'domestic') return 'kis';
  if (value === 'kis_overseas' || value === 'overseas') return 'kis_overseas';
  return value || 'unknown';
}

export function entryChartSourcePolicy(exchange = '') {
  const market = normalizeMarket(exchange);
  if (market === 'binance') return 'tradingview';
  if (market === 'kis' || market === 'kis_overseas') return 'kis';
  return 'unsupported';
}

function supportedMarket(exchange = '', env = process.env) {
  const market = normalizeMarket(exchange);
  const list = strEnv(
    'LUNA_ENTRY_CHART_GUARD_MARKETS',
    'binance,crypto,kis,domestic,kis_overseas,overseas',
    env,
  )
    .split(',')
    .map((item) => normalizeMarket(item))
    .filter(Boolean);
  return list.includes(market);
}

export function isTradingViewEntryGuardEnabled(env = process.env) {
  const raw = envRaw('LUNA_TRADINGVIEW_ENTRY_GUARD_ENABLED', env).toLowerCase();
  if (!raw) return false;
  return !DISABLE_VALUES.has(raw);
}

export function normalizeTradingViewSymbol(symbol = '', exchange = 'binance') {
  const text = String(symbol || '').trim().toUpperCase();
  if (!text) return null;
  if (text.includes(':')) return text;
  const market = normalizeMarket(exchange);
  if (market !== 'binance') return null;
  const mapped = resolveMappedTradingViewSymbol(text, market);
  if (mapped) return mapped;
  return `BINANCE:${text.replace('/', '')}`;
}

function parseJsonMapEnv(name) {
  const raw = envRaw(name);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function resolveMappedTradingViewSymbol(symbol, market) {
  const map = parseJsonMapEnv('LUNA_TRADINGVIEW_SYMBOL_MAP_JSON');
  const keys = [
    `${market}:${symbol}`,
    symbol,
    symbol.replace('/', ''),
  ];
  for (const key of keys) {
    const mapped = String(map[key] || '').trim().toUpperCase();
    if (mapped) return mapped;
  }
  return null;
}

export function normalizeTradingViewTimeframe(timeframe = '60') {
  const text = String(timeframe || '60').trim().toLowerCase();
  const map = {
    '1m': '1',
    '3m': '3',
    '5m': '5',
    '15m': '15',
    '30m': '30',
    '60m': '60',
    '1h': '60',
    '2h': '120',
    '4h': '240',
    '1d': 'D',
    d: 'D',
    day: 'D',
    '1w': 'W',
    w: 'W',
    week: 'W',
  };
  return map[text] || String(timeframe || '60').trim() || '60';
}

function mcpUrl(env = process.env) {
  const base = strEnv('LUNA_MARKETDATA_MCP_URL', `http://127.0.0.1:${env.LUNA_MARKETDATA_MCP_PORT || 4088}`, env);
  return `${base.replace(/\/$/, '')}/rpc`;
}

function tvHttpBase(env = process.env) {
  return strEnv('LUNA_TRADINGVIEW_WS_HTTP_URL', `http://127.0.0.1:${env.TV_METRICS_PORT || 8083}`, env).replace(/\/$/, '');
}

function tradingViewMaxAgeMsForTimeframe(timeframe = '60', env = process.env) {
  const normalized = normalizeTradingViewTimeframe(timeframe);
  if (normalized === 'D') {
    return Math.max(24 * 60 * 60 * 1000, numEnv('LUNA_TRADINGVIEW_ENTRY_DAILY_MAX_AGE_MS', 36 * 60 * 60 * 1000, env));
  }
  if (normalized === 'W') {
    return Math.max(7 * 24 * 60 * 60 * 1000, numEnv('LUNA_TRADINGVIEW_ENTRY_WEEKLY_MAX_AGE_MS', 10 * 24 * 60 * 60 * 1000, env));
  }
  return Math.max(60_000, numEnv('LUNA_TRADINGVIEW_ENTRY_MAX_AGE_MS', 7_200_000, env));
}

function directHttpFallbackEnabled(env = process.env) {
  return boolEnv('LUNA_TRADINGVIEW_ENTRY_GUARD_DIRECT_HTTP_FALLBACK', true, env);
}

function officialDirectRestFallbackEnabled(env = process.env) {
  return boolEnv('LUNA_ENTRY_CHART_KIS_DIRECT_REST_FALLBACK', true, env);
}

function dailyTrendFilterEnabled(env = process.env) {
  return boolEnv('LUNA_ENTRY_DAILY_TREND_FILTER_ENABLED', true, env);
}

function dailyTrendFetchEnabled(env = process.env) {
  return boolEnv('LUNA_ENTRY_DAILY_TREND_FETCH_ENABLED', true, env);
}

function officialMarketForExchange(exchange = '') {
  const market = normalizeMarket(exchange);
  if (market === 'binance') return 'binance';
  if (market === 'kis') return 'kis_domestic';
  if (market === 'kis_overseas') return 'kis_overseas';
  return null;
}

export function normalizeOfficialSymbol(symbol = '', exchange = 'binance') {
  const text = String(symbol || '').trim().toUpperCase();
  const market = normalizeMarket(exchange);
  if (!text) return '';
  if (market === 'binance') {
    if (text.includes('/')) return text;
    if (text.includes(':')) return text.split(':').pop().replace(/USDT$/, '/USDT');
    if (text.endsWith('USDT')) return `${text.slice(0, -4)}/USDT`;
    return text;
  }
  if (market === 'kis') return text.includes(':') ? text.split(':').pop() : text;
  if (market === 'kis_overseas') return text.includes(':') ? text.split(':').pop() : text;
  return text;
}

function isoDateDaysAgo(days = 80) {
  return new Date(Date.now() - Math.max(1, Number(days) || 80) * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function normalizeDailyBar(row = {}) {
  if (Array.isArray(row)) {
    return {
      timestamp: Number(row[0] || 0),
      open: Number(row[1] || 0),
      high: Number(row[2] || 0),
      low: Number(row[3] || 0),
      close: Number(row[4] || 0),
      volume: Number(row[5] || 0),
    };
  }
  const timestamp = Number(row.timestamp ?? row.ts ?? row.candle_ts ?? 0);
  return {
    date: row.date || row.Date || null,
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    open: Number(row.open ?? row.Open ?? 0),
    high: Number(row.high ?? row.High ?? 0),
    low: Number(row.low ?? row.Low ?? 0),
    close: Number(row.close ?? row.Close ?? row.price ?? 0),
    volume: Number(row.volume ?? row.Volume ?? 0),
    source: row.source || null,
  };
}

function normalizeDailyBars(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => normalizeDailyBar(row))
    .filter((row) => row.close > 0)
    .sort((a, b) => {
      const left = a.timestamp || Date.parse(a.date || '') || 0;
      const right = b.timestamp || Date.parse(b.date || '') || 0;
      return left - right;
    });
}

function smaAt(values = [], endIndex = values.length - 1, window = 20) {
  const size = Math.max(1, Math.round(Number(window) || 20));
  const end = Math.min(values.length - 1, endIndex);
  const start = end - size + 1;
  if (start < 0) return NaN;
  let sum = 0;
  for (let index = start; index <= end; index += 1) sum += Number(values[index] || 0);
  return sum / size;
}

export function evaluateDailyTrendSnapshot(snapshot = {}, env = process.env) {
  if (!dailyTrendFilterEnabled(env)) {
    return { ok: true, skipped: true, reason: 'daily_trend_filter_disabled', checks: [] };
  }
  const shortWindow = Math.max(2, Math.round(numEnv('LUNA_ENTRY_DAILY_TREND_SHORT_MA', 5, env)));
  const longWindow = Math.max(shortWindow + 1, Math.round(numEnv('LUNA_ENTRY_DAILY_TREND_LONG_MA', 20, env)));
  const slopeLookback = Math.max(1, Math.round(numEnv('LUNA_ENTRY_DAILY_TREND_SLOPE_LOOKBACK', 3, env)));
  const minLongSlopePct = numEnv('LUNA_ENTRY_DAILY_TREND_MIN_LONG_SLOPE_PCT', 0, env);
  const minCloseLocation = Math.min(1, Math.max(0, numEnv('LUNA_ENTRY_DAILY_TREND_MIN_CLOSE_LOCATION', 0.5, env)));
  const bars = normalizeDailyBars(snapshot?.dailyBars || snapshot?.daily_bars || snapshot?.ohlcv || []);
  const requiredBars = longWindow + slopeLookback;

  if (bars.length < requiredBars) {
    return {
      ok: false,
      blocked: true,
      reason: 'daily_trend_bars_insufficient',
      requiredBars,
      bars: bars.length,
      checks: [],
    };
  }

  const closes = bars.map((bar) => Number(bar.close || 0));
  const latestBar = bars[bars.length - 1];
  const price = Number(snapshot?.price ?? snapshot?.close ?? latestBar.close ?? 0);
  const high = Number(snapshot?.high ?? latestBar.high ?? 0);
  const low = Number(snapshot?.low ?? latestBar.low ?? 0);
  const shortSma = smaAt(closes, closes.length - 1, shortWindow);
  const longSma = smaAt(closes, closes.length - 1, longWindow);
  const priorLongSma = smaAt(closes, closes.length - 1 - slopeLookback, longWindow);
  const longSlopePct = priorLongSma > 0 ? (longSma - priorLongSma) / priorLongSma : NaN;

  const checks = [
    { name: 'daily_price_above_short_sma', ok: price > shortSma, value: price, threshold: shortSma, window: shortWindow },
    { name: 'daily_price_above_long_sma', ok: price > longSma, value: price, threshold: longSma, window: longWindow },
    { name: 'daily_short_sma_above_long_sma', ok: shortSma > longSma, value: shortSma, threshold: longSma },
    { name: 'daily_long_sma_slope_pct', ok: Number.isFinite(longSlopePct) && longSlopePct >= minLongSlopePct, value: longSlopePct, min: minLongSlopePct, lookback: slopeLookback },
  ];

  if (high > low && price >= low && price <= high) {
    const closeLocation = (price - low) / (high - low);
    checks.push({
      name: 'daily_close_location',
      ok: closeLocation >= minCloseLocation,
      value: closeLocation,
      min: minCloseLocation,
    });
  }

  const failed = checks.filter((item) => !item.ok);
  return {
    ok: failed.length === 0,
    blocked: failed.length > 0,
    reason: failed.length > 0 ? 'daily_trend_not_bullish' : 'daily_trend_bullish',
    checks,
    trend: {
      shortWindow,
      longWindow,
      slopeLookback,
      shortSma,
      longSma,
      priorLongSma,
      longSlopePct,
      latestClose: latestBar.close,
      price,
      bars: bars.length,
    },
  };
}

async function fetchCryptoDailyTrendBars({ symbol, env = process.env } = {}) {
  const days = Math.max(30, Math.round(numEnv('LUNA_ENTRY_DAILY_TREND_LOOKBACK_DAYS', 90, env)));
  const { getOHLCV } = await import('./ohlcv-fetcher.ts');
  const normalized = normalizeOfficialSymbol(symbol, 'binance');
  const rows = await getOHLCV(normalized, '1d', isoDateDaysAgo(days), null, 'binance');
  return normalizeDailyBars(rows).slice(-days);
}

async function enrichCryptoDailyTrend(snapshot = {}, { symbol, env = process.env } = {}) {
  if (!dailyTrendFilterEnabled(env) || !dailyTrendFetchEnabled(env) || Array.isArray(snapshot?.dailyBars)) return snapshot;
  try {
    const dailyBars = await fetchCryptoDailyTrendBars({ symbol: symbol || snapshot?.symbol, env });
    return {
      ...snapshot,
      dailyBars,
      dailyTrendSource: 'binance_ohlcv_daily_for_tradingview_guard',
    };
  } catch (error) {
    return {
      ...snapshot,
      dailyTrendError: error?.message || String(error),
    };
  }
}

async function enrichOfficialDailyTrend(snapshot = {}, { market, symbol, exchange, env = process.env } = {}) {
  if (!dailyTrendFilterEnabled(env) || !dailyTrendFetchEnabled(env) || Array.isArray(snapshot?.dailyBars)) return snapshot;
  try {
    const kis = await import('./kis-client.ts');
    const days = Math.max(30, Math.round(numEnv('LUNA_ENTRY_DAILY_TREND_LOOKBACK_DAYS', 90, env)));
    const officialSymbol = normalizeOfficialSymbol(symbol || snapshot?.symbol, exchange);
    const dailyBars = market === 'kis_domestic'
      ? await kis.getDomesticDailyPriceBars(officialSymbol, { days })
      : await kis.getOverseasDailyPriceBars(officialSymbol, { days });
    return {
      ...snapshot,
      dailyBars,
      dailyTrendSource: `${market}_daily_price`,
    };
  } catch (error) {
    return {
      ...snapshot,
      dailyTrendError: error?.message || String(error),
    };
  }
}

function shouldTryDirectHttpSnapshot(snapshot = {}) {
  const source = String(snapshot?.source || '').toLowerCase();
  const providerMode = String(snapshot?.providerMode || '').toLowerCase();
  return snapshot?.ok === false
    || snapshot?.error
    || source === 'luna-marketdata-mcp'
    || providerMode.includes('simulated')
    || providerMode.includes('real_required');
}

async function fetchOfficialRestEntrySnapshot({ market, symbol, exchange = 'kis', env = process.env } = {}) {
  try {
    const kis = await import('./kis-client.ts');
    if (market === 'kis_domestic') {
      const quote = await kis.getDomesticQuoteSnapshot(symbol);
      return await enrichOfficialDailyTrend({
        ok: Number(quote?.price || 0) > 0,
        source: 'kis_domestic_rest_direct',
        providerMode: 'rest',
        market,
        symbol: normalizeOfficialSymbol(quote?.symbol || symbol, exchange),
        timeframe: '1d',
        price: Number(quote?.price || 0),
        open: Number(quote?.open || 0),
        high: Number(quote?.high || 0),
        low: Number(quote?.low || 0),
        volume24h: Number(quote?.volume || 0),
        stale: false,
        fetchedAt: new Date().toISOString(),
        entryChartFallback: 'kis_direct_rest',
      }, { market, symbol, exchange, env });
    }
    if (market === 'kis_overseas') {
      const quote = await kis.getOverseasQuoteSnapshot(symbol);
      return await enrichOfficialDailyTrend({
        ok: Number(quote?.price || 0) > 0,
        source: 'kis_overseas_rest_direct',
        providerMode: 'rest',
        market,
        symbol: normalizeOfficialSymbol(quote?.symbol || symbol, exchange),
        timeframe: '1d',
        price: Number(quote?.price || 0),
        open: Number(quote?.open || 0),
        high: Number(quote?.high || 0),
        low: Number(quote?.low || 0),
        changePct24h: Number(quote?.changePct || 0) / 100,
        stale: false,
        fetchedAt: new Date().toISOString(),
        entryChartFallback: 'kis_direct_rest',
      }, { market, symbol, exchange, env });
    }
    return { ok: false, error: 'official_rest_market_unsupported', market, symbol };
  } catch (error) {
    return { ok: false, error: error?.message || String(error), market, symbol };
  }
}

function snapshotFromTradingViewBar({ symbol, timeframe, bar, row, status, env = process.env }) {
  const price = Number(bar?.close || bar?.price || 0);
  const maxAgeMs = tradingViewMaxAgeMsForTimeframe(timeframe, env);
  const ageMs = Number(row?.ageMs ?? 0);
  return {
    ok: price > 0,
    source: row?.source || 'tradingview_ws_service',
    providerMode: row?.providerMode || 'websocket_http_latest',
    fallbackReason: row?.fallbackReason || null,
    market: 'tradingview',
    symbol,
    timeframe,
    price,
    open: Number(bar?.open || 0),
    high: Number(bar?.high || 0),
    low: Number(bar?.low || 0),
    volume24h: Number(bar?.volume || 0),
    ageMs: Number.isFinite(ageMs) ? ageMs : null,
    maxAgeMs,
    stale: Number.isFinite(ageMs) && ageMs > maxAgeMs,
    tvWsStatus: status?.tv_ws || null,
    exchangeEventAt: bar?.timestamp ? new Date(Number(bar.timestamp)).toISOString() : null,
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchTradingViewHttpLatestSnapshot({
  symbol,
  exchange = 'binance',
  timeframe = null,
  env = process.env,
} = {}) {
  const normalizedSymbol = normalizeTradingViewSymbol(symbol, exchange);
  if (!normalizedSymbol) return { ok: false, error: 'symbol_missing' };
  const tvTimeframe = normalizeTradingViewTimeframe(timeframe || env.LUNA_TRADINGVIEW_ENTRY_GUARD_TIMEFRAME || '1h');
  const timeoutMs = Math.max(250, numEnv('LUNA_TRADINGVIEW_ENTRY_GUARD_TIMEOUT_MS', 2500, env));
  const base = tvHttpBase(env);

  try {
    const subscribeUrl = `${base}/subscribe?symbol=${encodeURIComponent(normalizedSymbol)}&timeframe=${encodeURIComponent(tvTimeframe)}`;
    await fetch(subscribeUrl, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
    const latestUrl = `${base}/latest?symbols=${encodeURIComponent(normalizedSymbol)}&timeframes=${encodeURIComponent(tvTimeframe)}`;
    const response = await fetch(latestUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, error: `tradingview_http_latest_${response.status}` };
    const payload = await response.json();
    const row = payload?.bars?.[0];
    if (!row?.bar) return { ok: false, error: 'tradingview_http_latest_empty', status: payload };
    return snapshotFromTradingViewBar({
      symbol: normalizedSymbol,
      timeframe: tvTimeframe,
      bar: row.bar,
      row,
      status: payload,
      env,
    });
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

export async function fetchOfficialEntrySnapshot({
  symbol,
  exchange = 'binance',
  env = process.env,
} = {}) {
  const market = officialMarketForExchange(exchange);
  const officialSymbol = normalizeOfficialSymbol(symbol, exchange);
  if (!market) return { ok: false, error: 'official_market_unsupported' };
  if (!officialSymbol) return { ok: false, error: 'symbol_missing' };
  const timeoutMs = Math.max(250, numEnv('LUNA_TRADINGVIEW_ENTRY_GUARD_TIMEOUT_MS', 2500, env));
  const body = {
    jsonrpc: '2.0',
    id: `entry-official-${Date.now()}`,
    method: 'tools/call',
    params: {
      name: 'get_market_snapshot',
      arguments: {
        market,
        symbol: officialSymbol,
        liveFire: true,
        timeoutMs,
      },
    },
  };

  try {
    const response = await fetch(mcpUrl(env), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, error: `official_market_http_${response.status}`, market, symbol: officialSymbol };
    const payload = await response.json();
    const snapshot = payload?.result?.content?.find?.((item) => item?.type === 'json')?.json
      || payload?.result?.content?.[0]?.json
      || payload?.result
      || null;
    if (!snapshot) {
      const fallback = officialDirectRestFallbackEnabled(env)
        ? await fetchOfficialRestEntrySnapshot({ market, symbol: officialSymbol, exchange, env })
        : null;
      return fallback?.ok ? fallback : { ok: false, error: 'official_market_snapshot_empty', market, symbol: officialSymbol, directRestFallback: fallback };
    }
    const source = String(snapshot?.source || '').toLowerCase();
    const providerMode = String(snapshot?.providerMode || '').toLowerCase();
    if (source === 'luna-marketdata-mcp' || providerMode.includes('simulated') || providerMode.includes('real_required')) {
      const fallback = officialDirectRestFallbackEnabled(env)
        ? await fetchOfficialRestEntrySnapshot({ market, symbol: officialSymbol, exchange, env })
        : null;
      return fallback?.ok ? fallback : {
        ok: false,
        error: 'official_real_snapshot_required',
        market,
        symbol: officialSymbol,
        rawSnapshot: snapshot,
        directRestFallback: fallback,
      };
    }
    return await enrichOfficialDailyTrend(
      { ...snapshot, entryChartFallback: 'official_marketdata' },
      { market, symbol: officialSymbol, exchange, env },
    );
  } catch (error) {
    const fallback = officialDirectRestFallbackEnabled(env)
      ? await fetchOfficialRestEntrySnapshot({ market, symbol: officialSymbol, exchange, env })
      : null;
    return fallback?.ok
      ? fallback
      : { ok: false, error: error?.message || String(error), market, symbol: officialSymbol, directRestFallback: fallback };
  }
}

export async function fetchTradingViewEntrySnapshot({ symbol, exchange = 'binance', timeframe = null, env = process.env } = {}) {
  if (entryChartSourcePolicy(exchange) !== 'tradingview') {
    return { ok: false, error: 'tradingview_not_used_for_market', market: normalizeMarket(exchange), symbol };
  }
  const normalizedSymbol = normalizeTradingViewSymbol(symbol, exchange);
  if (!normalizedSymbol) return { ok: false, error: 'symbol_missing' };
  const tvTimeframe = timeframe || env.LUNA_TRADINGVIEW_ENTRY_GUARD_TIMEFRAME || '1h';
  const timeoutMs = Math.max(250, numEnv('LUNA_TRADINGVIEW_ENTRY_GUARD_TIMEOUT_MS', 2500, env));
  const body = {
    jsonrpc: '2.0',
    id: `tv-entry-${Date.now()}`,
    method: 'tools/call',
    params: {
      name: 'get_market_snapshot',
      arguments: {
        market: 'tradingview',
        symbol: normalizedSymbol,
        timeframe: tvTimeframe,
        requireReal: boolEnv('LUNA_TRADINGVIEW_ENTRY_GUARD_REQUIRE_REAL', true, env),
        liveFire: true,
        timeoutMs,
      },
    },
  };

  try {
    const response = await fetch(mcpUrl(env), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, error: `tradingview_mcp_http_${response.status}` };
    const payload = await response.json();
    const snapshot = payload?.result?.content?.find?.((item) => item?.type === 'json')?.json
      || payload?.result?.content?.[0]?.json
      || payload?.result
      || null;
    const result = snapshot || { ok: false, error: 'tradingview_snapshot_empty' };
    if (directHttpFallbackEnabled(env) && shouldTryDirectHttpSnapshot(result)) {
      const direct = await fetchTradingViewHttpLatestSnapshot({ symbol: normalizedSymbol, exchange, timeframe: tvTimeframe, env });
      if (direct?.ok) return enrichCryptoDailyTrend(direct, { symbol: normalizedSymbol, env });
      return { ...result, directHttpFallback: direct };
    }
    return enrichCryptoDailyTrend(result, { symbol: normalizedSymbol, env });
  } catch (error) {
    const result = { ok: false, error: error?.message || String(error) };
    if (directHttpFallbackEnabled(env)) {
      const direct = await fetchTradingViewHttpLatestSnapshot({ symbol: normalizedSymbol, exchange, timeframe: tvTimeframe, env });
      if (direct?.ok) return enrichCryptoDailyTrend(direct, { symbol: normalizedSymbol, env });
      return { ...result, directHttpFallback: direct };
    }
    return result;
  }
}

export async function fetchEntryChartSnapshot({ symbol, exchange = 'binance', timeframe = null, env = process.env } = {}) {
  const policy = entryChartSourcePolicy(exchange);
  if (policy === 'tradingview') {
    return fetchTradingViewEntrySnapshot({ symbol, exchange, timeframe, env });
  }
  if (policy === 'kis') {
    return fetchOfficialEntrySnapshot({ symbol, exchange, env });
  }
  return { ok: false, error: 'entry_chart_market_unsupported', market: normalizeMarket(exchange), symbol };
}

function snapshotFromPolicy({ policy, event = null, candidate = {} } = {}) {
  if (policy === 'kis') {
    return event?.officialChartSnapshot
      || event?.kisSnapshot
      || event?.entryChartSnapshot
      || candidate?.block_meta?.officialChartSnapshot
      || candidate?.block_meta?.kisSnapshot
      || candidate?.block_meta?.entryChartSnapshot
      || candidate?.officialChartSnapshot
      || candidate?.kisSnapshot
      || candidate?.entryChartSnapshot
      || null;
  }
  if (policy === 'tradingview') {
    return event?.tradingViewSnapshot
      || event?.tradingviewSnapshot
      || event?.chartSnapshot
      || event?.entryChartSnapshot
      || candidate?.block_meta?.tradingViewSnapshot
      || candidate?.block_meta?.entryChartSnapshot
      || candidate?.tradingViewSnapshot
      || candidate?.entryChartSnapshot
      || null;
  }
  return null;
}

function violatesEntryChartPolicy(snapshot = {}, policy = 'unsupported') {
  const source = String(snapshot?.source || '').toLowerCase();
  const market = String(snapshot?.market || '').toLowerCase();
  if (policy === 'kis') {
    return source.includes('tradingview') || market === 'tradingview';
  }
  if (policy === 'tradingview') {
    return Boolean(source || market) && !source.includes('tradingview') && market !== 'tradingview';
  }
  return true;
}

export function evaluateTradingViewSnapshot(snapshot = {}, env = process.env) {
  const minChangePct24h = numEnv('LUNA_TRADINGVIEW_ENTRY_MIN_CHANGE_PCT_24H', 0, env);
  const minCandleChangePct = numEnv('LUNA_TRADINGVIEW_ENTRY_MIN_CANDLE_CHANGE_PCT', 0, env);
  const requireReal = boolEnv('LUNA_TRADINGVIEW_ENTRY_GUARD_REQUIRE_REAL', true, env);
  const source = String(snapshot?.source || '').toLowerCase();
  const providerMode = String(snapshot?.providerMode || '').toLowerCase();
  const price = Number(snapshot?.price ?? snapshot?.close ?? 0);
  const open = Number(snapshot?.open ?? 0);
  const changePct24h = Number(snapshot?.changePct24h ?? snapshot?.change_pct_24h ?? NaN);
  const stale = snapshot?.stale === true;

  if (snapshot?.ok === false || snapshot?.error) {
    return { ok: false, blocked: true, reason: snapshot?.error || 'tradingview_snapshot_error', snapshot };
  }
  if (!(price > 0)) {
    return { ok: false, blocked: true, reason: 'tradingview_price_missing', snapshot };
  }
  if (stale) {
    return { ok: false, blocked: true, reason: 'tradingview_snapshot_stale', snapshot };
  }
  if (requireReal && (providerMode.includes('simulated') || providerMode.includes('real_required') || source === 'luna-marketdata-mcp')) {
    return { ok: false, blocked: true, reason: 'tradingview_real_snapshot_required', snapshot };
  }

  const checks = [];
  if (Number.isFinite(changePct24h)) {
    checks.push({
      name: 'change_pct_24h',
      ok: changePct24h >= minChangePct24h,
      value: changePct24h,
      min: minChangePct24h,
    });
  }
  if (open > 0) {
    const candleChangePct = (price - open) / open;
    checks.push({
      name: 'current_candle_change_pct',
      ok: candleChangePct >= minCandleChangePct,
      value: candleChangePct,
      min: minCandleChangePct,
    });
  }
  const dailyTrend = evaluateDailyTrendSnapshot(snapshot, env);
  if (!dailyTrend.skipped) {
    checks.push(...dailyTrend.checks);
  }

  if (checks.length === 0) {
    return { ok: false, blocked: true, reason: 'tradingview_bullish_evidence_missing', snapshot };
  }
  const failed = checks.filter((item) => !item.ok);
  if (failed.length > 0) {
    return { ok: false, blocked: true, reason: dailyTrend.blocked ? 'tradingview_daily_trend_not_bullish' : 'tradingview_chart_not_bullish', checks, dailyTrend, snapshot };
  }
  return { ok: true, blocked: false, reason: 'tradingview_chart_bullish', checks, dailyTrend, snapshot };
}

export function evaluateKisDailySnapshot(snapshot = {}, env = process.env) {
  const minDailyChangePct = numEnv('LUNA_KIS_ENTRY_MIN_DAILY_CHANGE_PCT', 0, env);
  const minCloseLocation = Math.min(1, Math.max(0, numEnv('LUNA_KIS_ENTRY_MIN_CLOSE_LOCATION', 0.5, env)));
  const requireOpenUp = boolEnv('LUNA_KIS_ENTRY_REQUIRE_DAILY_OPEN_UP', true, env);
  const requireReal = boolEnv('LUNA_TRADINGVIEW_ENTRY_GUARD_REQUIRE_REAL', true, env);
  const source = String(snapshot?.source || '').toLowerCase();
  const providerMode = String(snapshot?.providerMode || '').toLowerCase();
  const price = Number(snapshot?.price ?? snapshot?.close ?? 0);
  const open = Number(snapshot?.open ?? 0);
  const high = Number(snapshot?.high ?? 0);
  const low = Number(snapshot?.low ?? 0);
  const changePct24h = Number(snapshot?.changePct24h ?? snapshot?.change_pct_24h ?? NaN);
  const stale = snapshot?.stale === true;

  if (snapshot?.ok === false || snapshot?.error) {
    return { ok: false, blocked: true, reason: snapshot?.error || 'kis_daily_snapshot_error', snapshot };
  }
  if (!(price > 0)) {
    return { ok: false, blocked: true, reason: 'kis_daily_price_missing', snapshot };
  }
  if (stale) {
    return { ok: false, blocked: true, reason: 'kis_daily_snapshot_stale', snapshot };
  }
  if (requireReal && (providerMode.includes('simulated') || providerMode.includes('real_required') || source === 'luna-marketdata-mcp')) {
    return { ok: false, blocked: true, reason: 'kis_daily_real_snapshot_required', snapshot };
  }

  const checks = [];
  if (requireOpenUp && open > 0) {
    const openChangePct = (price - open) / open;
    checks.push({
      name: 'daily_open_to_current_change_pct',
      ok: openChangePct >= minDailyChangePct,
      value: openChangePct,
      min: minDailyChangePct,
    });
  }
  if (Number.isFinite(changePct24h)) {
    checks.push({
      name: 'daily_previous_close_change_pct',
      ok: changePct24h >= minDailyChangePct,
      value: changePct24h,
      min: minDailyChangePct,
    });
  }
  if (high > low && price >= low && price <= high) {
    const closeLocation = (price - low) / (high - low);
    checks.push({
      name: 'daily_close_location',
      ok: closeLocation >= minCloseLocation,
      value: closeLocation,
      min: minCloseLocation,
    });
  }
  const dailyTrend = evaluateDailyTrendSnapshot(snapshot, env);
  if (!dailyTrend.skipped) {
    checks.push(...dailyTrend.checks);
  }

  if (checks.length === 0) {
    return { ok: false, blocked: true, reason: 'kis_daily_bullish_evidence_missing', snapshot };
  }
  const failed = checks.filter((item) => !item.ok);
  if (failed.length > 0) {
    return { ok: false, blocked: true, reason: dailyTrend.blocked ? 'kis_daily_trend_not_bullish' : 'kis_daily_chart_not_bullish', checks, dailyTrend, snapshot };
  }
  return { ok: true, blocked: false, reason: 'kis_daily_chart_bullish', checks, dailyTrend, snapshot };
}

export async function evaluateTradingViewEntryGuard({ candidate = {}, event = null, exchange = 'binance', env = process.env } = {}) {
  if (!isTradingViewEntryGuardEnabled(env)) {
    return { ok: true, blocked: false, enabled: false, reason: 'tradingview_entry_guard_disabled' };
  }
  if (!supportedMarket(exchange, env)) {
    return { ok: true, blocked: false, enabled: true, skipped: true, reason: 'market_not_supported' };
  }

  const sourcePolicy = entryChartSourcePolicy(exchange);
  const snapshot = snapshotFromPolicy({ policy: sourcePolicy, event, candidate })
    || await fetchEntryChartSnapshot({
      symbol: candidate?.symbol || event?.symbol,
      exchange,
      env,
    });
  if (violatesEntryChartPolicy(snapshot, sourcePolicy)) {
    return {
      ok: false,
      blocked: true,
      enabled: true,
      reason: 'entry_chart_source_policy_violation',
      sourcePolicy,
      symbol: candidate?.symbol || event?.symbol || null,
      exchange,
      snapshot,
    };
  }
  const evaluated = sourcePolicy === 'kis'
    ? evaluateKisDailySnapshot(snapshot, env)
    : evaluateTradingViewSnapshot(snapshot, env);
  return {
    ...evaluated,
    enabled: true,
    sourcePolicy,
    symbol: candidate?.symbol || event?.symbol || null,
    exchange,
  };
}

export default {
  isTradingViewEntryGuardEnabled,
  entryChartSourcePolicy,
  normalizeTradingViewSymbol,
  normalizeOfficialSymbol,
  normalizeTradingViewTimeframe,
  fetchTradingViewHttpLatestSnapshot,
  fetchOfficialEntrySnapshot,
  fetchTradingViewEntrySnapshot,
  fetchEntryChartSnapshot,
  evaluateDailyTrendSnapshot,
  evaluateTradingViewSnapshot,
  evaluateKisDailySnapshot,
  evaluateTradingViewEntryGuard,
};
