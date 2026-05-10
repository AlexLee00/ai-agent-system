#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  classifyKisRealtime,
  classifyTradingViewRealtime,
  classifyTradingViewRealtimeSet,
} from './runtime-marketdata-realtime-connectivity.ts';
import { redactKisWsDiagnosticMessage } from '../mcp/luna-marketdata-mcp/src/tools/kis-ws-domestic.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const investmentRoot = path.resolve(__dirname, '..');

function readMarketdataMcpKisRoutingDiagnostic() {
  const raw = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      [
        "process.env.LUNA_MCP_SERVER_ENABLED='true';",
        "process.env.LUNA_MARKETDATA_MCP_PORT='4088';",
        "process.env.KIS_USE_MCP='true';",
        "const mod = await import('./shared/kis-client.ts');",
        'console.log(JSON.stringify(mod.getKisMcpRoutingDiagnostics()));',
      ].join(' '),
    ],
    {
      cwd: investmentRoot,
      encoding: 'utf8',
    },
  );
  return JSON.parse(String(raw || '{}'));
}

export async function runSmoke() {
  const tvReady = classifyTradingViewRealtime({
    symbol: 'BINANCE:BTCUSDT',
    timeframe: '60',
    health: {
      tv_ws: 'connected',
      realtimeOk: true,
      subscriptions: 3,
      staleSubscriptions: 0,
      fallbackBars: 0,
    },
    latest: {
      bars: [{
        source: 'tradingview_ws_service',
        providerMode: 'websocket_http_latest',
        fallbackReason: null,
        ageMs: 30_000,
      }],
    },
  });
  assert.equal(tvReady.ok, true);
  assert.equal(tvReady.status, 'tradingview_realtime_ready');

  const tvFallback = classifyTradingViewRealtime({
    health: {
      tv_ws: 'connected',
      staleSubscriptions: 0,
      fallbackBars: 1,
    },
    latest: {
      bars: [{
        source: 'tradingview_ws_service_binance_rest_fallback',
        providerMode: 'binance_rest_live_fallback',
        fallbackReason: 'tradingview_ws_latest_empty',
        ageMs: 10_000,
      }],
    },
  });
  assert.equal(tvFallback.ok, false);
  assert.equal(tvFallback.blockers.includes('tradingview_realtime_bar_missing'), true);

  const tvSetReady = classifyTradingViewRealtimeSet({
    health: {
      tv_ws: 'connected',
      realtimeOk: true,
      subscriptions: 6,
      protectedSubscriptions: 6,
      staleSubscriptions: 0,
      fallbackBars: 0,
    },
    latest: {
      bars: [
        { symbol: 'BINANCE:BTCUSDT', timeframe: '60', source: 'tradingview_ws_service', providerMode: 'websocket_http_latest', fallbackReason: null, ageMs: 30_000 },
        { symbol: 'BINANCE:BTCUSDT', timeframe: '240', source: 'tradingview_ws_service', providerMode: 'websocket_http_latest', fallbackReason: null, ageMs: 30_000 },
        { symbol: 'BINANCE:CETUSUSDT', timeframe: '60', source: 'tradingview_ws_service', providerMode: 'websocket_http_latest', fallbackReason: null, ageMs: 30_000 },
        { symbol: 'BINANCE:CETUSUSDT', timeframe: '240', source: 'tradingview_ws_service', providerMode: 'websocket_http_latest', fallbackReason: null, ageMs: 30_000 },
      ],
    },
    expected: [
      { symbol: 'BINANCE:BTCUSDT', timeframe: '60' },
      { symbol: 'BINANCE:BTCUSDT', timeframe: '240' },
      { symbol: 'BINANCE:CETUSUSDT', timeframe: '60' },
      { symbol: 'BINANCE:CETUSUSDT', timeframe: '240' },
    ],
  });
  assert.equal(tvSetReady.ok, true);
  assert.equal(tvSetReady.expectedCount, 4);
  assert.equal(tvSetReady.realBars, 4);
  assert.deepEqual(tvSetReady.missingRealBars, []);

  const tvSetMissing = classifyTradingViewRealtimeSet({
    health: {
      tv_ws: 'connected',
      realtimeOk: true,
      subscriptions: 6,
      protectedSubscriptions: 2,
      staleSubscriptions: 0,
      fallbackBars: 4,
    },
    latest: {
      bars: [
        { symbol: 'BINANCE:BTCUSDT', timeframe: '60', source: 'tradingview_ws_service', providerMode: 'websocket_http_latest', fallbackReason: null, ageMs: 30_000 },
        { symbol: 'BINANCE:CETUSUSDT', timeframe: '60', source: 'tradingview_ws_service_binance_rest_fallback', providerMode: 'binance_rest_live_fallback', fallbackReason: 'tradingview_ws_latest_empty', ageMs: 30_000 },
      ],
    },
    expected: [
      { symbol: 'BINANCE:BTCUSDT', timeframe: '60' },
      { symbol: 'BINANCE:CETUSUSDT', timeframe: '60' },
    ],
  });
  assert.equal(tvSetMissing.ok, false);
  assert.deepEqual(tvSetMissing.missingRealBars, ['BINANCE:CETUSUSDT:60']);
  assert.equal(tvSetMissing.blockers.some((item) => item.includes('BINANCE:CETUSUSDT:60')), true);
  assert.equal(tvSetMissing.warnings.includes('tradingview_rest_fallback_bars_present'), true);

  const tvSetLegacyService = classifyTradingViewRealtimeSet({
    health: {
      tv_ws: 'connected',
      realtimeOk: true,
      subscriptions: 2,
      staleSubscriptions: 0,
      fallbackBars: 0,
    },
    latest: {
      bars: [
        { symbol: 'BINANCE:BTCUSDT', timeframe: '60', source: 'tradingview_ws_service', providerMode: 'websocket_http_latest', fallbackReason: null, ageMs: 30_000 },
      ],
    },
    expected: [{ symbol: 'BINANCE:BTCUSDT', timeframe: '60' }],
  });
  assert.equal(tvSetLegacyService.ok, true);
  assert.equal(tvSetLegacyService.warnings.includes('tradingview_service_reload_required_for_protected_subscriptions'), true);

  const kisPreopen = classifyKisRealtime({
    market: 'kis_overseas',
    symbol: 'AAPL',
    probe: {
      ok: true,
      approvalKeyIssued: true,
      wsOpened: true,
      subscriptionSent: true,
      subscriptionAccepted: true,
      firstTickReceived: false,
    },
    rest: { ok: true, providerMode: 'rest', price: 100 },
  });
  assert.equal(kisPreopen.ok, true);
  assert.equal(kisPreopen.status, 'kis_overseas_preopen_realtime_subscription_ready');

  const kisSharedWs = classifyKisRealtime({
    market: 'kis_overseas',
    symbol: 'AAPL',
    probe: {
      ok: false,
      approvalKeyIssued: true,
      wsOpened: true,
      subscriptionSent: true,
      subscriptionAccepted: false,
      firstTickReceived: false,
      error: 'ALREADY IN USE appkey',
    },
    rest: { ok: true, providerMode: 'rest', price: 100 },
  });
  assert.equal(kisSharedWs.ok, true);
  assert.equal(kisSharedWs.status, 'kis_overseas_shared_ws_in_use_rest_ready');
  assert.equal(kisSharedWs.blockers.length, 0);
  assert.equal(kisSharedWs.warnings.includes('kis_overseas_ws_appkey_already_in_use_existing_stream_assumed'), true);

  const redacted = redactKisWsDiagnosticMessage('{"header":{"approval_key":"abc"},"body":{"output":{"iv":"iv-secret","key":"key-secret"}}}');
  assert.equal(redacted.includes('abc'), false);
  assert.equal(redacted.includes('iv-secret'), false);
  assert.equal(redacted.includes('key-secret'), false);
  assert.equal(redacted.includes('[redacted]'), true);

  const kisMissingApproval = classifyKisRealtime({
    market: 'kis_domestic',
    symbol: '005930',
    probe: {
      ok: false,
      approvalKeyIssued: false,
      wsOpened: false,
      subscriptionSent: false,
      subscriptionAccepted: false,
    },
    rest: { ok: true, providerMode: 'rest', price: 70000 },
  });
  assert.equal(kisMissingApproval.ok, false);
  assert.equal(kisMissingApproval.blockers.includes('kis_domestic_approval_key_missing'), true);

  const kisRouting = readMarketdataMcpKisRoutingDiagnostic();
  assert.equal(kisRouting.marketdataMcpServerMode, true);
  assert.equal(kisRouting.enabledDefault, true);
  assert.equal(kisRouting.useBridge, false);

  return { ok: true, tvReady, tvFallback, tvSetReady, tvSetMissing, tvSetLegacyService, kisPreopen, kisSharedWs, kisMissingApproval, kisRouting, redactionChecked: true };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('marketdata realtime connectivity smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'marketdata-realtime-connectivity-smoke failed:' });
}
