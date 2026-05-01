#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { createMarketdataMcpServer } from '../mcp/luna-marketdata-mcp/src/server.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json();
  return { status: response.status, body };
}

async function withServer(fn) {
  const server = createMarketdataMcpServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

export async function runSmoke() {
  return withServer(async (baseUrl) => {
    const health = await requestJson(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    const list = await requestJson(`${baseUrl}/rpc`, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(list.body.result.tools.length, 5);

    const snapshot = await requestJson(`${baseUrl}/rpc`, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_market_snapshot', arguments: { market: 'binance', symbol: 'BTC/USDT', disableReal: true } },
      }),
    });
    const snapshotJson = snapshot.body.result.content[0].json;
    assert.equal(snapshotJson.ok, true);
    assert.equal(snapshotJson.symbol, 'BTC/USDT');

    const regime = await requestJson(`${baseUrl}/rpc`, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'get_market_regime', params: { symbol: 'ETH/USDT', disableReal: true } }),
    });
    assert.equal(regime.body.result.ok, true);
    assert.ok(String(regime.body.result.regime).includes('_'));

    const subscribe = await requestJson(`${baseUrl}/rpc`, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'subscribe_market_data',
        params: { market: 'tradingview', symbol: 'BTCUSDT', timeframe: '1h', disableReal: true },
      }),
    });
    assert.equal(subscribe.body.result.subscribed, true);

    const book = await requestJson(`${baseUrl}/rpc`, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'get_order_book', params: { depth: 3, disableReal: true } }),
    });
    assert.equal(book.body.result.bids.length, 3);
    assert.equal(book.body.result.asks.length, 3);

    return { ok: true, health: health.body, tools: list.body.result.tools.map((tool) => tool.name), snapshot: snapshotJson };
  });
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('✅ luna-marketdata-mcp-smoke');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ luna-marketdata-mcp-smoke 실패:' });
}
