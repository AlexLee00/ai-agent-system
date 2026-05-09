#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { getDomesticQuoteSnapshot, getOverseasQuoteSnapshot } from '../shared/kis-client.ts';
import { probeKisDomesticRealtime } from '../mcp/luna-marketdata-mcp/src/tools/kis-ws-domestic.ts';
import { probeKisOverseasRealtime } from '../mcp/luna-marketdata-mcp/src/tools/kis-ws-overseas.ts';

const DEFAULT_TV_HTTP = `http://127.0.0.1:${process.env.TV_METRICS_PORT || 8083}`;

function argValue(name, fallback = null, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function boolArg(name, argv = process.argv.slice(2)) {
  return argv.includes(`--${name}`);
}

async function fetchJson(url, timeoutMs = 5000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(250, Number(timeoutMs || 5000))) });
  if (!response.ok) throw new Error(`http_${response.status}:${url}`);
  return response.json();
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

export function classifyKisRealtime({ market, probe = {}, rest = {}, symbol } = {}) {
  const restOk = rest?.ok === true || Number(rest?.price || 0) > 0;
  const ok = probe?.ok === true && probe?.subscriptionAccepted === true && !probe?.error && restOk;
  return {
    ok,
    status: ok
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
      ...(probe.subscriptionAccepted ? [] : [`${market}_subscription_not_accepted`]),
      ...(probe.error ? [`${market}_ws_error:${String(probe.error).slice(0, 120)}`] : []),
      ...(restOk ? [] : [`${market}_rest_quote_unavailable`]),
    ],
    note: probe.firstTickReceived
      ? 'market tick received'
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
  cryptoTimeframe = '60',
  domesticSymbol = '005930',
  overseasSymbol = 'AAPL',
  timeoutMs = 5000,
  httpBase = DEFAULT_TV_HTTP,
  paper = false,
} = {}) {
  const crypto = await tradingViewCheck({ symbol: cryptoSymbol, timeframe: cryptoTimeframe, timeoutMs, httpBase }).catch((error) => ({
      decision: {
        ok: false,
        status: 'tradingview_realtime_attention',
        symbol: cryptoSymbol,
        timeframe: cryptoTimeframe,
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
    cryptoTimeframe: argValue('crypto-timeframe', '60'),
    domesticSymbol: argValue('domestic-symbol', '005930'),
    overseasSymbol: argValue('overseas-symbol', 'AAPL'),
    timeoutMs: Number(argValue('timeout-ms', 5000)),
    httpBase: argValue('tv-http-base', DEFAULT_TV_HTTP),
    paper: boolArg('paper'),
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
