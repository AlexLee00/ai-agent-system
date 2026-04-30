#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runSmoke() {
  const sql = readFileSync(new URL('../migrations/20260501_backtest_runs.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS investment\.backtest_runs/);
  assert.match(sql, /layer INTEGER NOT NULL/);
  assert.match(sql, /strategy_name TEXT NOT NULL/);
  return {
    ok: true,
    migration: '20260501_backtest_runs.sql',
    additive: true,
    liveTradeCommandsExecuted: false,
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('✅ chronos-backtest-runs-smoke');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ chronos-backtest-runs-smoke 실패:' });
}
