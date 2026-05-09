#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { classifyKisRealtime, classifyTradingViewRealtime } from './runtime-marketdata-realtime-connectivity.ts';

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

  return { ok: true, tvReady, tvFallback, kisPreopen, kisMissingApproval };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('marketdata realtime connectivity smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'marketdata-realtime-connectivity-smoke failed:' });
}
