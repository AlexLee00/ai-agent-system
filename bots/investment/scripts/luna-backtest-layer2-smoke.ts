#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildStrategyGrid, classifyBacktestGuardrail, runChronosLayer2Backtest } from '../team/chronos.ts';

function fixtureRunner() {
  return [
    { label: 'tp2_sl1', status: 'ok', sharpe_ratio: 1.2, win_rate: 0.55, max_drawdown: 0.08, total_trades: 42, total_return: 12.5 },
    { label: 'bad', status: 'ok', sharpe_ratio: -0.2, win_rate: 0.31, max_drawdown: 0.25, total_trades: 30, total_return: -8.1 },
  ];
}

export async function runLayer2Smoke() {
  const grid = buildStrategyGrid();
  assert.ok(grid.length >= 30);
  assert.equal(classifyBacktestGuardrail({ hit_rate: 0.3, max_dd: 0.1 }).ok, false);
  assert.equal(classifyBacktestGuardrail({ hit_rate: 0.5, max_dd: 0.1 }).ok, true);
  const result = await runChronosLayer2Backtest({
    symbol: 'BTC/USDT',
    market: 'binance',
    days: 90,
    runner: fixtureRunner,
    dryRun: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.layer, 2);
  assert.ok(result.strategyGridSize >= 30);
  assert.equal(result.persisted.dryRun, true);
  assert.equal(result.best.label, 'tp2_sl1');
  return result;
}

async function main() {
  const result = await runLayer2Smoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna-backtest-layer2-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ luna-backtest-layer2-smoke 실패:' });
}
