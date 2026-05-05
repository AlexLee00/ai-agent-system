#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { normalizeTradingViewTimeframe } from '../mcp/luna-marketdata-mcp/src/tools/tradingview-ws.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  entryChartSourcePolicy,
  evaluateDailyTrendSnapshot,
  evaluateKisDailySnapshot,
  evaluateTradingViewEntryGuard,
  evaluateTradingViewSnapshot,
  fetchEntryChartSnapshot,
  normalizeOfficialSymbol,
  normalizeTradingViewSymbol,
} from '../shared/tradingview-entry-guard.ts';

function makeDailyBars({ start = 100, step = 1, count = 30 } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const close = start + step * index;
    return {
      date: `202605${String(index + 1).padStart(2, '0')}`,
      open: close - Math.max(0.1, Math.abs(step) * 0.5),
      high: close + Math.max(1, Math.abs(step)),
      low: close - Math.max(1, Math.abs(step)),
      close,
      volume: 1000 + index,
    };
  });
}

export async function runSmoke() {
  const bullishDailyBars = makeDailyBars({ start: 100, step: 1, count: 30 });
  const bearishDailyBars = makeDailyBars({ start: 130, step: -1, count: 30 });
  const domesticBullishDailyBars = makeDailyBars({ start: 70, step: 1, count: 30 })
    .map((bar) => ({ ...bar, close: bar.close * 700, open: bar.open * 700, high: bar.high * 700, low: bar.low * 700 }));
  const overseasBullishDailyBars = makeDailyBars({ start: 70, step: 1, count: 30 })
    .map((bar) => ({ ...bar, close: bar.close * 2, open: bar.open * 2, high: bar.high * 2, low: bar.low * 2 }));
  const baseEnv = {
    LUNA_TRADINGVIEW_ENTRY_GUARD_ENABLED: 'true',
    LUNA_TRADINGVIEW_ENTRY_GUARD_REQUIRE_REAL: 'true',
    LUNA_ENTRY_DAILY_TREND_FETCH_ENABLED: 'false',
    LUNA_TRADINGVIEW_ENTRY_MIN_CHANGE_PCT_24H: '0',
    LUNA_TRADINGVIEW_ENTRY_MIN_CANDLE_CHANGE_PCT: '0',
    LUNA_KIS_ENTRY_MIN_DAILY_CHANGE_PCT: '0',
    LUNA_KIS_ENTRY_MIN_CLOSE_LOCATION: '0.5',
    LUNA_ENTRY_CHART_GUARD_MARKETS: 'binance,crypto,kis,domestic,kis_overseas,overseas',
  };

  assert.equal(normalizeTradingViewSymbol('BTC/USDT', 'binance'), 'BINANCE:BTCUSDT');
  assert.equal(normalizeTradingViewSymbol('005930', 'kis'), null);
  assert.equal(normalizeTradingViewSymbol('AAPL', 'kis_overseas'), null);
  assert.equal(normalizeOfficialSymbol('005930', 'kis'), '005930');
  assert.equal(normalizeOfficialSymbol('AAPL', 'kis_overseas'), 'AAPL');
  assert.equal(entryChartSourcePolicy('binance'), 'tradingview');
  assert.equal(entryChartSourcePolicy('kis'), 'kis');
  assert.equal(entryChartSourcePolicy('kis_overseas'), 'kis');
  assert.equal(normalizeTradingViewTimeframe('1h'), '60');
  assert.equal(normalizeTradingViewTimeframe('1d'), 'D');

  const bullish = evaluateTradingViewSnapshot({
    ok: true,
    source: 'tradingview_ws_service',
    providerMode: 'websocket',
    price: 130,
    open: 128,
    high: 132,
    low: 124,
    changePct24h: 0.01,
    dailyBars: bullishDailyBars,
    stale: false,
  }, baseEnv);
  assert.equal(bullish.ok, true);

  const bearish = evaluateTradingViewSnapshot({
    ok: true,
    source: 'tradingview_ws_service',
    providerMode: 'websocket',
    price: 98,
    open: 100,
    changePct24h: -0.01,
    dailyBars: bearishDailyBars,
    stale: false,
  }, baseEnv);
  assert.equal(bearish.blocked, true);
  assert.match(bearish.reason, /tradingview_(chart|daily_trend)_not_bullish/);

  const fallback = evaluateTradingViewSnapshot({
    ok: true,
    source: 'luna-marketdata-mcp',
    providerMode: 'simulated_fallback',
    price: 102,
    changePct24h: 0.01,
    dailyBars: bullishDailyBars,
    stale: false,
  }, baseEnv);
  assert.equal(fallback.blocked, true);
  assert.equal(fallback.reason, 'tradingview_real_snapshot_required');

  const disabled = await evaluateTradingViewEntryGuard({
    candidate: { symbol: 'BTC/USDT' },
    exchange: 'binance',
    env: { LUNA_TRADINGVIEW_ENTRY_GUARD_ENABLED: 'false' },
  });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.enabled, false);

  const eventPass = await evaluateTradingViewEntryGuard({
    candidate: { symbol: 'BTC/USDT' },
    event: {
      tradingViewSnapshot: {
        ok: true,
        source: 'tradingview_ws_service',
        providerMode: 'websocket',
        price: 130,
        open: 128,
        high: 132,
        low: 124,
        dailyBars: bullishDailyBars,
        stale: false,
      },
    },
    exchange: 'binance',
    env: baseEnv,
  });
  assert.equal(eventPass.ok, true);

  const domesticPass = await evaluateTradingViewEntryGuard({
    candidate: { symbol: '005930' },
    event: {
      officialChartSnapshot: {
        ok: true,
        source: 'kis_domestic_rest',
        providerMode: 'rest',
        price: 71000,
        open: 70000,
        high: 71500,
        low: 69000,
        dailyBars: domesticBullishDailyBars,
        stale: false,
      },
    },
    exchange: 'kis',
    env: baseEnv,
  });
  assert.equal(domesticPass.ok, true);
  assert.equal(domesticPass.sourcePolicy, 'kis');

  const overseasPass = await evaluateTradingViewEntryGuard({
    candidate: { symbol: 'AAPL' },
    event: {
      officialChartSnapshot: {
        ok: true,
        source: 'kis_overseas_rest',
        providerMode: 'rest',
        price: 202,
        open: 200,
        high: 204,
        low: 198,
        dailyBars: overseasBullishDailyBars,
        stale: false,
      },
    },
    exchange: 'kis_overseas',
    env: baseEnv,
  });
  assert.equal(overseasPass.ok, true);
  assert.equal(overseasPass.sourcePolicy, 'kis');

  const domesticTradingViewRejected = await evaluateTradingViewEntryGuard({
    candidate: { symbol: '005930' },
    event: {
      entryChartSnapshot: {
        ok: true,
        source: 'tradingview_ws_service',
        providerMode: 'websocket',
        market: 'tradingview',
        price: 71000,
        open: 70000,
        stale: false,
      },
    },
    exchange: 'kis',
    env: baseEnv,
  });
  assert.equal(domesticTradingViewRejected.blocked, true);
  assert.equal(domesticTradingViewRejected.reason, 'entry_chart_source_policy_violation');

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options = {}) => {
    const body = JSON.parse(String(options?.body || '{}'));
    calls.push(body?.params?.arguments || {});
    const args = body?.params?.arguments || {};
    const market = args.market;
    return {
      ok: true,
      async json() {
        return {
          result: {
            content: [{
              type: 'json',
              json: {
                ok: true,
                source: market === 'tradingview' ? 'tradingview_ws_service' : `${market}_rest`,
                providerMode: market === 'tradingview' ? 'websocket' : 'rest',
                market,
                symbol: args.symbol,
                price: 101,
                open: 100,
                high: 102,
                low: 99,
                stale: false,
              },
            }],
          },
        };
      },
    };
  };
  try {
    const fetchedDomestic = await fetchEntryChartSnapshot({ symbol: '005930', exchange: 'kis', env: baseEnv });
    const fetchedOverseas = await fetchEntryChartSnapshot({ symbol: 'AAPL', exchange: 'kis_overseas', env: baseEnv });
    const fetchedCrypto = await fetchEntryChartSnapshot({ symbol: 'BTC/USDT', exchange: 'binance', env: baseEnv });
    assert.equal(fetchedDomestic.market, 'kis_domestic');
    assert.equal(fetchedDomestic.symbol, '005930');
    assert.equal(fetchedOverseas.market, 'kis_overseas');
    assert.equal(fetchedOverseas.symbol, 'AAPL');
    assert.equal(fetchedCrypto.market, 'tradingview');
    assert.equal(fetchedCrypto.symbol, 'BINANCE:BTCUSDT');
    assert.deepEqual(calls.map((call) => call.market), ['kis_domestic', 'kis_overseas', 'tradingview']);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const officialDomesticPass = evaluateKisDailySnapshot({
    ok: true,
    source: 'kis_domestic_rest',
    providerMode: 'rest',
    price: 71000,
    open: 70000,
    high: 71500,
    low: 69000,
    dailyBars: domesticBullishDailyBars,
    stale: false,
  }, baseEnv);
  assert.equal(officialDomesticPass.ok, true);
  assert.equal(officialDomesticPass.reason, 'kis_daily_chart_bullish');

  const officialOverseasPass = evaluateKisDailySnapshot({
    ok: true,
    source: 'kis_overseas_rest',
    providerMode: 'rest',
    price: 202,
    open: 200,
    high: 204,
    low: 198,
    changePct24h: 0.01,
    dailyBars: overseasBullishDailyBars,
    stale: false,
  }, baseEnv);
  assert.equal(officialOverseasPass.ok, true);
  assert.equal(officialOverseasPass.reason, 'kis_daily_chart_bullish');

  const officialDomesticBearish = evaluateKisDailySnapshot({
    ok: true,
    source: 'kis_domestic_rest',
    providerMode: 'rest',
    price: 69500,
    open: 70000,
    high: 71500,
    low: 69000,
    dailyBars: bearishDailyBars.map((bar) => ({ ...bar, close: bar.close * 700, open: bar.open * 700, high: bar.high * 700, low: bar.low * 700 })),
    stale: false,
  }, baseEnv);
  assert.equal(officialDomesticBearish.blocked, true);
  assert.match(officialDomesticBearish.reason, /kis_daily_(chart|trend)_not_bullish/);

  const dailyTrend = evaluateDailyTrendSnapshot({
    price: 129,
    high: 130,
    low: 124,
    dailyBars: bullishDailyBars,
  }, baseEnv);
  assert.equal(dailyTrend.ok, true);
  assert.equal(dailyTrend.reason, 'daily_trend_bullish');

  const weakDailyTrend = evaluateDailyTrendSnapshot({
    price: 101,
    high: 132,
    low: 100,
    dailyBars: bearishDailyBars,
  }, baseEnv);
  assert.equal(weakDailyTrend.blocked, true);
  assert.equal(weakDailyTrend.reason, 'daily_trend_not_bullish');

  return {
    ok: true,
    bullish,
    bearish,
    fallback,
    disabled,
    eventPass,
    domesticPass,
    overseasPass,
    domesticTradingViewRejected,
    officialDomesticPass,
    officialOverseasPass,
    officialDomesticBearish,
    dailyTrend,
    weakDailyTrend,
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('tradingview entry guard smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ tradingview-entry-guard-smoke 실패:',
  });
}
