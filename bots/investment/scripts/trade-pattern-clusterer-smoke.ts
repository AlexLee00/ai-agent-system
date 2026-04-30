#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { clusterTradePatterns } from '../shared/trade-pattern-clusterer.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runSmoke() {
  const clusters = clusterTradePatterns([
    { market: 'binance', strategy: 'breakout', symbol: 'BTC/USDT', pnl: 1 },
    { market: 'binance', strategy: 'breakout', symbol: 'ETH/USDT', pnl: 2 },
    { market: 'kis', strategy: 'mean_reversion', symbol: '005930', pnl: -1 },
  ]);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].key, 'binance:breakout:win');
  assert.equal(clusters[0].count, 2);
  assert.ok(clusters[0].symbols.includes('BTC/USDT'));
  return { ok: true, clusters };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('✅ trade-pattern-clusterer-smoke');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ trade-pattern-clusterer-smoke 실패:' });
}
