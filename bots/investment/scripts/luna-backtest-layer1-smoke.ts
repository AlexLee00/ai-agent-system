#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runLayer1Smoke() {
  const source = readFileSync(new URL('../elixir/lib/luna/v2/validation/backtest.ex', import.meta.url), 'utf8');
  assert.match(source, /run_layer1_backtest/);
  assert.match(source, /calc_sortino/);
  assert.match(source, /calc_max_drawdown/);
  assert.match(source, /market_breakdown/);
  assert.match(source, /strategy_breakdown/);
  return {
    ok: true,
    layer: 1,
    metrics: ['sharpe', 'sortino', 'hit_rate', 'max_dd', 'avg_pnl', 'volatility'],
    liveTradeCommandsExecuted: false,
  };
}

async function main() {
  const result = await runLayer1Smoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna-backtest-layer1-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ luna-backtest-layer1-smoke 실패:' });
}
