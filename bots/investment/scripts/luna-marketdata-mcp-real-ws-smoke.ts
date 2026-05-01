#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { binanceOrderBook, binanceSnapshot, unsubscribeBinanceMarketData } from '../mcp/luna-marketdata-mcp/src/tools/binance-ws.ts';
import { kisDomesticSnapshot } from '../mcp/luna-marketdata-mcp/src/tools/kis-ws-domestic.ts';
import { kisOverseasSnapshot } from '../mcp/luna-marketdata-mcp/src/tools/kis-ws-overseas.ts';
import { tradingViewSnapshot } from '../mcp/luna-marketdata-mcp/src/tools/tradingview-ws.ts';
import { callMarketdataTool, closeMarketdataMcpSubscriptions } from '../mcp/luna-marketdata-mcp/src/server.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function assertSnapshot(snapshot, market, symbol) {
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.market, market);
  assert.equal(snapshot.symbol, symbol);
  assert.ok(Number(snapshot.price || 0) > 0);
  assert.ok(['websocket', 'rest', 'simulated_fallback'].includes(snapshot.providerMode));
}

export async function runSmoke() {
  try {
    const binance = await binanceSnapshot({ symbol: 'BTC/USDT', disableReal: true });
    assertSnapshot(binance, 'binance', 'BTC/USDT');
    assert.equal(binance.providerMode, 'simulated_fallback');

    const binanceBook = await binanceOrderBook({ symbol: 'BTC/USDT', depth: 3, disableReal: true });
    assert.equal(binanceBook.ok, true);
    assert.equal(binanceBook.bids.length, 3);
    assert.equal(binanceBook.asks.length, 3);

    const domestic = await kisDomesticSnapshot({ symbol: '005930', disableReal: true });
    assertSnapshot(domestic, 'kis_domestic', '005930');

    const overseas = await kisOverseasSnapshot({ symbol: 'AAPL', disableReal: true });
    assertSnapshot(overseas, 'kis_overseas', 'AAPL');

    const tv = await tradingViewSnapshot({ symbol: 'BINANCE:BTCUSDT', timeframe: '1h', disableReal: true });
    assertSnapshot(tv, 'tradingview', 'BINANCE:BTCUSDT');

    const subscribed = await callMarketdataTool('subscribe_market_data', {
      market: 'binance',
      symbol: 'BTC/USDT',
      disableReal: true,
    });
    assert.equal(subscribed.ok, true);
    assert.equal(subscribed.subscribed, true);
    assert.equal(subscribed.subscription.provider.providerMode, 'simulated_fallback');

    const unsubscribed = unsubscribeBinanceMarketData({ symbol: 'BTC/USDT' });
    assert.equal(unsubscribed.ok, true);

    return {
      ok: true,
      providerModes: {
        binance: binance.providerMode,
        orderBook: binanceBook.providerMode,
        kisDomestic: domestic.providerMode,
        kisOverseas: overseas.providerMode,
        tradingView: tv.providerMode,
      },
    };
  } finally {
    closeMarketdataMcpSubscriptions();
  }
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna-marketdata-mcp-real-ws-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'luna-marketdata-mcp-real-ws-smoke failed:' });
}
