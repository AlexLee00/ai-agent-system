#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildDefaultTradingViewWsUrl, resolveTradingViewWsUrl } from '../services/tradingview-ws/src/tradingview-url.js';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export function runTradingViewWsUrlSmoke() {
  const defaultUrl = buildDefaultTradingViewWsUrl();
  assert.equal(defaultUrl.startsWith('wss://data.tradingview.com/socket.io/websocket?'), true);
  assert.equal(defaultUrl.includes('from=chart%2F'), true);
  assert.equal(defaultUrl.includes('type=chart'), true);
  assert.equal(defaultUrl.includes('date=2024'), false);

  const override = 'wss://example.test/socket?from=chart%2F&type=chart';
  assert.equal(resolveTradingViewWsUrl({ TV_WS_URL: ` ${override} ` }), override);
  assert.equal(resolveTradingViewWsUrl({}).includes('date=2024'), false);

  return { ok: true, defaultUrl };
}

async function main() {
  const result = runTradingViewWsUrlSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('tradingview-ws-url smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'tradingview-ws-url smoke failed:' });
}
