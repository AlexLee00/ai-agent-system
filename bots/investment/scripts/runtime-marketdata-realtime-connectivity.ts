#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { getDomesticQuoteSnapshot, getOverseasQuoteSnapshot } from '../shared/kis-client.ts';
import { probeKisDomesticRealtime } from '../mcp/luna-marketdata-mcp/src/tools/kis-ws-domestic.ts';
import { probeKisOverseasRealtime } from '../mcp/luna-marketdata-mcp/src/tools/kis-ws-overseas.ts';
import * as db from '../shared/db.ts';
import { normalizeBinanceTradingViewSymbol } from './runtime-tradingview-open-position-subscription-sync.ts';

const DEFAULT_TV_HTTP = `http://127.0.0.1:${process.env.TV_METRICS_PORT || 8083}`;
const DEFAULT_CRYPTO_TIMEFRAMES = process.env.LUNA_MARKETDATA_CRYPTO_TIMEFRAMES
  || process.env.TV_OPEN_POSITION_TIMEFRAMES
  || '60,240,D';
const DEFAULT_REALTIME_WAIT_MS = Number(process.env.LUNA_MARKETDATA_REALTIME_WAIT_MS || 15_000);
const DEFAULT_REALTIME_POLL_MS = Number(process.env.LUNA_MARKETDATA_REALTIME_POLL_MS || 1_500);

function argValue(name, fallback = null, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function boolArg(name, argv = process.argv.slice(2)) {
  return argv.includes(`--${name}`);
}

function parseList(value = '') {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function fetchJson(url, timeoutMs = 5000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(250, Number(timeoutMs || 5000))) });
  if (!response.ok) throw new Error(`http_${response.status}:${url}`);
  return response.json();
}

function positiveMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function timeframeDurationMs(timeframe = '60') {
  const text = String(timeframe || '60').trim().toLowerCase();
  if (text === 'd' || text === '1d') return 24 * 60 * 60 * 1000;
  if (text === 'w' || text === '1w') return 7 * 24 * 60 * 60 * 1000;
  if (text.endsWith('h')) return Math.max(1, Number(text.slice(0, -1)) || 1) * 60 * 60 * 1000;
  if (text.endsWith('m')) return Math.max(1, Number(text.slice(0, -1)) || 1) * 60 * 1000;
  const minutes = Number(text);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : 60 * 60 * 1000;
}

export function classifyTradingViewRealtime({ health = {}, latest = {}, symbol = 'BINANCE:BTCUSDT', timeframe = '60' } = {}) {
  const bars = Array.isArray(latest?.bars) ? latest.bars : [];
  const staleThresholdMs = Math.max(5 * 60 * 1000, timeframeDurationMs(timeframe) + 5 * 60 * 1000);
  const realBars = bars.filter((row) => {
    const source = String(row.source || '').toLowerCase();
    const providerMode = String(row.providerMode || '').toLowerCase();
    return source === 'tradingview_ws_service' && providerMode.includes('websocket') && !row.fallbackReason;
  });
  const staleBars = realBars.filter((row) => Number(row.ageMs || 0) > staleThresholdMs);
  const ok = health?.tv_ws === 'connected' && realBars.length > 0 && staleBars.length === 0;
  const staleSubscriptionCount = Number(health?.staleSubscriptions || 0);
  return {
    ok,
    status: ok ? 'tradingview_realtime_ready' : 'tradingview_realtime_attention',
    symbol,
    timeframe,
    tvWs: health?.tv_ws || 'unknown',
    serviceRealtimeOk: health?.realtimeOk === true,
    subscriptions: Number(health?.subscriptions || 0),
    staleSubscriptions: staleSubscriptionCount,
    fallbackBars: Number(health?.fallbackBars || 0),
    latestCount: bars.length,
    realBars: realBars.length,
    staleRealBars: staleBars.length,
    staleThresholdMs,
    blockers: [
      ...(health?.tv_ws === 'connected' ? [] : ['tradingview_ws_disconnected']),
      ...(realBars.length > 0 ? [] : ['tradingview_realtime_bar_missing']),
      ...(staleBars.length === 0 ? [] : ['tradingview_realtime_bar_stale']),
    ],
    warnings: [
      ...(staleSubscriptionCount === 0 ? [] : ['tradingview_stale_subscriptions_present']),
    ],
  };
}

export function classifyTradingViewRealtimeSet({ health = {}, latest = {}, expected = [] } = {}) {
  const bars = Array.isArray(latest?.bars) ? latest.bars : [];
  const hasProtectedMetric = Object.prototype.hasOwnProperty.call(health || {}, 'protectedSubscriptions');
  const expectedRows = (expected || []).map((item) => ({
    symbol: String(item.symbol || '').trim(),
    timeframe: String(item.timeframe || '60').trim(),
  })).filter((item) => item.symbol && item.timeframe);
  const realByKey = new Map();
  const staleRealBars = [];
  for (const row of bars) {
    const source = String(row.source || '').toLowerCase();
    const providerMode = String(row.providerMode || '').toLowerCase();
    const realtime = source === 'tradingview_ws_service' && providerMode.includes('websocket') && !row.fallbackReason;
    if (!realtime) continue;
    const key = `${row.symbol}:${row.timeframe}`;
    realByKey.set(key, row);
    const threshold = Math.max(5 * 60 * 1000, timeframeDurationMs(row.timeframe) + 5 * 60 * 1000);
    if (Number(row.ageMs || 0) > threshold) staleRealBars.push({ key, ageMs: row.ageMs, threshold });
  }
  const missing = expectedRows
    .filter((item) => !realByKey.has(`${item.symbol}:${item.timeframe}`))
    .map((item) => `${item.symbol}:${item.timeframe}`);
  const staleSubscriptionCount = Number(health?.staleSubscriptions || 0);
  const protectedWithoutBars = (Array.isArray(health?.subscriptionDetails) ? health.subscriptionDetails : [])
    .filter((item) => item?.protected === true && item?.lastBarAt == null)
    .map((item) => `${item.symbol || 'unknown'}:${item.timeframe || 'unknown'}`)
    .slice(0, 12);
  const hasBuildId = Boolean(health?.buildId);
  const ok = health?.tv_ws === 'connected'
    && hasProtectedMetric
    && hasBuildId
    && missing.length === 0
    && staleRealBars.length === 0;
  return {
    ok,
    status: ok ? 'tradingview_realtime_ready' : 'tradingview_realtime_attention',
    tvWs: health?.tv_ws || 'unknown',
    buildId: health?.buildId || null,
    serviceRealtimeOk: health?.realtimeOk === true,
    subscriptions: Number(health?.subscriptions || 0),
    protectedSubscriptions: Number(health?.protectedSubscriptions || 0),
    staleSubscriptions: staleSubscriptionCount,
    protectedWithoutBars,
    fallbackBars: Number(health?.fallbackBars || 0),
    latestCount: bars.length,
    expectedCount: expectedRows.length,
    realBars: realByKey.size,
    missingRealBars: missing,
    staleRealBars,
    blockers: [
      ...(health?.tv_ws === 'connected' ? [] : ['tradingview_ws_disconnected']),
      ...(hasProtectedMetric ? [] : ['tradingview_service_reload_required_for_protected_subscriptions']),
      ...(hasBuildId ? [] : ['tradingview_service_reload_required_for_build_id']),
      ...(missing.length === 0 ? [] : [`tradingview_realtime_bar_missing:${missing.slice(0, 12).join(',')}`]),
      ...(staleRealBars.length === 0 ? [] : ['tradingview_realtime_bar_stale']),
    ],
    warnings: [
      ...(staleSubscriptionCount === 0 ? [] : ['tradingview_stale_subscriptions_present']),
      ...(protectedWithoutBars.length === 0 ? [] : [`tradingview_protected_subscription_without_bar:${protectedWithoutBars.join(',')}`]),
      ...(Number(health?.fallbackBars || 0) === 0 ? [] : ['tradingview_rest_fallback_bars_present']),
    ],
  };
}

export function classifyKisRealtime({ market, probe = {}, rest = {}, symbol } = {}) {
  const restOk = rest?.ok === true || Number(rest?.price || 0) > 0;
  const probeError = String(probe?.error || '');
  const appkeyAlreadyInUse = /ALREADY IN USE appkey/i.test(probeError);
  const sharedWsReady = appkeyAlreadyInUse
    && probe?.approvalKeyIssued === true
    && probe?.wsOpened === true
    && probe?.subscriptionSent === true
    && restOk;
  const ok = (probe?.ok === true && probe?.subscriptionAccepted === true && !probe?.error && restOk) || sharedWsReady;
  return {
    ok,
    status: sharedWsReady
      ? `${market}_shared_ws_in_use_rest_ready`
      : ok
      ? probe.firstTickReceived
        ? `${market}_realtime_tick_ready`
        : `${market}_preopen_realtime_subscription_ready`
      : `${market}_realtime_attention`,
    market,
    symbol,
    approvalKeyIssued: probe.approvalKeyIssued === true,
    wsOpened: probe.wsOpened === true,
    subscriptionSent: probe.subscriptionSent === true,
    subscriptionAccepted: probe.subscriptionAccepted === true,
    firstTickReceived: probe.firstTickReceived === true,
    restOk,
    restProviderMode: rest?.providerMode || 'rest',
    blockers: [
      ...(probe.approvalKeyIssued ? [] : [`${market}_approval_key_missing`]),
      ...(probe.wsOpened ? [] : [`${market}_ws_not_opened`]),
      ...(probe.subscriptionSent ? [] : [`${market}_subscription_not_sent`]),
      ...(probe.subscriptionAccepted || sharedWsReady ? [] : [`${market}_subscription_not_accepted`]),
      ...(probe.error && !sharedWsReady ? [`${market}_ws_error:${String(probe.error).slice(0, 120)}`] : []),
      ...(restOk ? [] : [`${market}_rest_quote_unavailable`]),
    ],
    warnings: [
      ...(sharedWsReady ? [`${market}_ws_appkey_already_in_use_existing_stream_assumed`] : []),
    ],
    note: probe.firstTickReceived
      ? 'market tick received'
      : sharedWsReady
        ? 'KIS allows limited appkey websocket sessions; an existing stream is using the appkey while REST quote is healthy'
      : 'no tick is acceptable before market open if approval/ws/subscription/rest are ready',
  };
}

async function tradingViewCheck({ symbol, timeframe, timeoutMs, httpBase }) {
  const base = String(httpBase || DEFAULT_TV_HTTP).replace(/\/$/, '');
  const normalizedTimeframe = String(timeframe || '60');
  await fetchJson(`${base}/subscribe?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(normalizedTimeframe)}`, timeoutMs).catch(() => null);
  const [health, latest] = await Promise.all([
    fetchJson(`${base}/health`, timeoutMs),
    fetchJson(`${base}/latest?symbols=${encodeURIComponent(symbol)}&timeframes=${encodeURIComponent(normalizedTimeframe)}&requireReal=true`, timeoutMs),
  ]);
  return {
    health,
    latest,
    decision: classifyTradingViewRealtime({ health, latest, symbol, timeframe: normalizedTimeframe }),
  };
}

async function fetchTradingViewSetSnapshot({ base, normalizedSymbols, normalizedTimeframes, timeoutMs }) {
  const [health, latest] = await Promise.all([
    fetchJson(`${base}/health`, timeoutMs),
    fetchJson(`${base}/latest?symbols=${encodeURIComponent(normalizedSymbols.join(','))}&timeframes=${encodeURIComponent(normalizedTimeframes.join(','))}&requireReal=true`, timeoutMs),
  ]);
  const expected = normalizedSymbols.flatMap((symbol) => normalizedTimeframes.map((timeframe) => ({ symbol, timeframe })));
  return {
    health,
    latest,
    expected,
    decision: classifyTradingViewRealtimeSet({ health, latest, expected }),
  };
}

async function tradingViewCheckSet({
  symbols = [],
  timeframes = ['60'],
  timeoutMs,
  httpBase,
  realtimeWaitMs = DEFAULT_REALTIME_WAIT_MS,
  realtimePollMs = DEFAULT_REALTIME_POLL_MS,
}) {
  const base = String(httpBase || DEFAULT_TV_HTTP).replace(/\/$/, '');
  const normalizedSymbols = [...new Set((symbols || []).map((symbol) => String(symbol || '').trim()).filter(Boolean))];
  const normalizedTimeframes = [...new Set((timeframes || []).map((timeframe) => String(timeframe || '60').trim()).filter(Boolean))];
  for (const symbol of normalizedSymbols) {
    for (const timeframe of normalizedTimeframes) {
      await fetchJson(`${base}/subscribe?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&protected=true`, timeoutMs).catch(() => null);
    }
  }
  const waitMs = Math.max(0, positiveMs(realtimeWaitMs, DEFAULT_REALTIME_WAIT_MS));
  const pollMs = Math.max(250, positiveMs(realtimePollMs, DEFAULT_REALTIME_POLL_MS));
  const deadline = Date.now() + waitMs;
  let attempts = 0;
  let snapshot = null;
  do {
    attempts += 1;
    snapshot = await fetchTradingViewSetSnapshot({ base, normalizedSymbols, normalizedTimeframes, timeoutMs });
    if (snapshot.decision?.ok === true) break;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return {
    ...snapshot,
    realtimeWaitMs: waitMs,
    realtimePollMs: pollMs,
    pollAttempts: attempts,
  };
}

async function kisDomesticCheck({ symbol, timeoutMs, paper }) {
  const [probe, quote] = await Promise.all([
    probeKisDomesticRealtime({ symbol, timeoutMs, paper }),
    getDomesticQuoteSnapshot(symbol, paper).catch((error) => ({ ok: false, error: error?.message || String(error) })),
  ]);
  const rest = {
    ok: Number(quote?.price || 0) > 0,
    providerMode: 'rest',
    symbol: quote?.symbol || symbol,
    price: Number(quote?.price || 0),
    error: quote?.error || null,
  };
  return { probe, rest, decision: classifyKisRealtime({ market: 'kis_domestic', probe, rest, symbol }) };
}

async function kisOverseasCheck({ symbol, timeoutMs, paper }) {
  const [probe, quote] = await Promise.all([
    probeKisOverseasRealtime({ symbol, timeoutMs, paper }),
    getOverseasQuoteSnapshot(symbol).catch((error) => ({ ok: false, error: error?.message || String(error) })),
  ]);
  const rest = {
    ok: Number(quote?.price || 0) > 0,
    providerMode: 'rest',
    symbol: quote?.symbol || symbol,
    price: Number(quote?.price || 0),
    error: quote?.error || null,
  };
  return { probe, rest, decision: classifyKisRealtime({ market: 'kis_overseas', probe, rest, symbol }) };
}

export async function buildMarketdataRealtimeConnectivityReport({
  cryptoSymbol = 'BINANCE:BTCUSDT',
  cryptoSymbols = null,
  cryptoTimeframe = '60',
  cryptoTimeframes = DEFAULT_CRYPTO_TIMEFRAMES,
  domesticSymbol = '005930',
  overseasSymbol = 'AAPL',
  timeoutMs = 5000,
  httpBase = DEFAULT_TV_HTTP,
  paper = false,
  realtimeWaitMs = DEFAULT_REALTIME_WAIT_MS,
  realtimePollMs = DEFAULT_REALTIME_POLL_MS,
} = {}) {
  await db.initSchema().catch(() => {});
  const openCryptoPositions = await db.getOpenPositions('binance', false).catch(() => []);
  const resolvedCryptoSymbols = parseList(cryptoSymbols || '')
    .map(normalizeBinanceTradingViewSymbol)
    .filter(Boolean);
  const positionCryptoSymbols = openCryptoPositions
    .map((row) => normalizeBinanceTradingViewSymbol(row?.symbol))
    .filter(Boolean);
  const cryptoSymbolList = [...new Set((resolvedCryptoSymbols.length > 0 ? resolvedCryptoSymbols : positionCryptoSymbols.length > 0 ? positionCryptoSymbols : [cryptoSymbol]) || [])];
  const cryptoTimeframeList = parseList(cryptoTimeframes || cryptoTimeframe || '60');
  const crypto = await tradingViewCheckSet({
    symbols: cryptoSymbolList,
    timeframes: cryptoTimeframeList,
    timeoutMs,
    httpBase,
    realtimeWaitMs,
    realtimePollMs,
  }).catch((error) => ({
      decision: {
        ok: false,
        status: 'tradingview_realtime_attention',
        symbols: cryptoSymbolList,
        timeframes: cryptoTimeframeList,
        blockers: [error?.message || String(error)],
      },
      error: error?.message || String(error),
    }));
  // KIS allows limited appkey-level websocket usage. Probe domestic/overseas
  // sequentially so the pre-open readiness check does not create its own
  // false "ALREADY IN USE appkey" failure.
  const domestic = await kisDomesticCheck({ symbol: domesticSymbol, timeoutMs, paper });
  const overseas = await kisOverseasCheck({ symbol: overseasSymbol, timeoutMs, paper });
  const decisions = [crypto.decision, domestic.decision, overseas.decision];
  const blockers = decisions.flatMap((item) => item?.blockers || []);
  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'marketdata_realtime_connectivity_ready' : 'marketdata_realtime_connectivity_attention',
    checkedAt: new Date().toISOString(),
    policy: {
      crypto: 'tradingview_realtime_required',
      domestic: 'kis_realtime_probe_plus_rest',
      overseas: 'kis_realtime_probe_plus_rest',
      noTradeExecution: true,
      cryptoScope: positionCryptoSymbols.length > 0 ? 'open_binance_positions' : 'fallback_symbol',
      cryptoSymbols: cryptoSymbolList,
      cryptoTimeframes: cryptoTimeframeList,
    },
    crypto,
    domestic,
    overseas,
    blockers,
  };
}

async function main() {
  const report = await buildMarketdataRealtimeConnectivityReport({
    cryptoSymbol: argValue('crypto-symbol', 'BINANCE:BTCUSDT'),
    cryptoSymbols: argValue('crypto-symbols', null),
    cryptoTimeframe: argValue('crypto-timeframe', '60'),
    cryptoTimeframes: argValue('crypto-timeframes', DEFAULT_CRYPTO_TIMEFRAMES),
    domesticSymbol: argValue('domestic-symbol', '005930'),
    overseasSymbol: argValue('overseas-symbol', 'AAPL'),
    timeoutMs: Number(argValue('timeout-ms', 5000)),
    httpBase: argValue('tv-http-base', DEFAULT_TV_HTTP),
    paper: boolArg('paper'),
    realtimeWaitMs: Number(argValue('realtime-wait-ms', DEFAULT_REALTIME_WAIT_MS)),
    realtimePollMs: Number(argValue('realtime-poll-ms', DEFAULT_REALTIME_POLL_MS)),
  });
  if (boolArg('json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.status} / blockers=${report.blockers.length}`);
    console.log(`crypto: ${report.crypto?.decision?.status}`);
    console.log(`domestic: ${report.domestic?.decision?.status}`);
    console.log(`overseas: ${report.overseas?.decision?.status}`);
  }
  if (!boolArg('no-fail') && report.ok !== true) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'runtime-marketdata-realtime-connectivity failed:' });
}
