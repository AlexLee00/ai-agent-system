#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildAuthoritativeIndicatorSnapshot,
  buildChartOverlayIndicatorAnalysis,
} from '../shared/position-reevaluator.ts';

const payload = {
  provider: 'yfinance',
  close: 100,
  rsi: 55,
  macd: 1.2,
  macd_signal: 1,
  macd_hist: 0.2,
  bb_pct: 0.6,
  signal: 'BUY',
};

const cryptoSnapshot = buildAuthoritativeIndicatorSnapshot({
  payload,
  yahooSymbol: 'BTC-USD',
  interval: '1h',
  overlay: {
    ok: true,
    provider: 'tradingview_ws',
    source: 'tradingview_ws_service',
    providerMode: 'websocket_http_latest',
    symbol: 'BINANCE:BTCUSDT',
    price: 101,
    open: 99,
    high: 102,
    low: 98,
    ageMs: 1234,
    exchangeEventAt: '2026-05-09T07:00:00.000Z',
  },
});

assert.equal(cryptoSnapshot.symbol, 'BINANCE:BTCUSDT');
assert.equal(cryptoSnapshot.close, 101);
assert.equal(cryptoSnapshot.provider, 'tradingview_ws+yfinance_indicators');
assert.equal(cryptoSnapshot.indicatorProvider, 'yfinance');
assert.equal(cryptoSnapshot.authoritativeSource, 'tradingview_ws_service');
assert.equal(cryptoSnapshot.providerMode, 'websocket_http_latest');
assert.equal(cryptoSnapshot.realtimeAgeMs, 1234);

const kisSnapshot = buildAuthoritativeIndicatorSnapshot({
  payload,
  yahooSymbol: 'ABEV',
  interval: '1d',
  overlay: {
    ok: true,
    provider: 'kis',
    source: 'kis_overseas_rest',
    symbol: 'ABEV',
    price: 3.31,
    open: 3.25,
    high: 3.34,
    low: 3.22,
  },
});

assert.equal(kisSnapshot.provider, 'kis+yfinance_indicators');
assert.equal(kisSnapshot.close, 3.31);
assert.equal(kisSnapshot.authoritativeSource, 'kis_overseas_rest');

const fallbackSnapshot = buildAuthoritativeIndicatorSnapshot({
  payload,
  yahooSymbol: 'BTC-USD',
  interval: '4h',
});

assert.equal(fallbackSnapshot.symbol, 'BTC-USD');
assert.equal(fallbackSnapshot.close, 100);
assert.equal(fallbackSnapshot.provider, 'yfinance');
assert.equal(fallbackSnapshot.authoritativeSource, null);

const chartOnly = buildChartOverlayIndicatorAnalysis({
  symbol: 'UNI/USDT',
  exchange: 'binance',
  interval: '4h',
  overlay: {
    ok: true,
    provider: 'tradingview_ws_binance_fallback',
    source: 'tradingview_ws_service_binance_rest_fallback',
    providerMode: 'binance_rest_live_fallback',
    fallbackReason: 'tradingview_ws_latest_empty',
    symbol: 'BINANCE:UNIUSDT',
    price: 3.94,
    open: 3.91,
    high: 3.95,
    low: 3.9,
  },
});

assert.equal(chartOnly.snapshot.symbol, 'BINANCE:UNIUSDT');
assert.equal(chartOnly.snapshot.close, 3.94);
assert.equal(chartOnly.snapshot.authoritativeSource, 'tradingview_ws_service_binance_rest_fallback');
assert.equal(chartOnly.signal, 'BUY');

console.log(JSON.stringify({ ok: true, checked: 4 }, null, 2));
