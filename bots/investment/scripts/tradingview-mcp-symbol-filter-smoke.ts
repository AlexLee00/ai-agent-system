#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import {
  isTradingViewPayloadForRequest,
} from '../mcp/luna-marketdata-mcp/src/tools/tradingview-ws.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runSmoke() {
  const movr = { symbol: 'BINANCE:MOVRUSDT', timeframe: '15', bar: { close: 2.61 } };
  const btc = { symbol: 'BINANCE:BTCUSDT', timeframe: '15', bar: { close: 35396.46 } };
  const nested = { bar: { symbol: 'BINANCE:MOVRUSDT', timeframe: '15', close: 2.61 } };

  assert.equal(isTradingViewPayloadForRequest(movr, 'MOVR/USDT', '15m'), true);
  assert.equal(isTradingViewPayloadForRequest(nested, 'BINANCE:MOVRUSDT', '15'), true);
  assert.equal(isTradingViewPayloadForRequest(btc, 'MOVR/USDT', '15m'), false);
  assert.equal(isTradingViewPayloadForRequest(movr, 'MOVR/USDT', '60'), false);

  return { ok: true, mismatchedPayloadIgnored: true };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('tradingview-mcp-symbol-filter-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'tradingview-mcp-symbol-filter-smoke failed:' });
}
