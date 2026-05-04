#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildTradeAnalyticsReport } from '../shared/trade-analytics-report.ts';

const DEFAULT_OUTPUT = path.resolve('output/reports/luna-trade-analytics-report.json');

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    smoke: argv.includes('--smoke'),
    noWrite: argv.includes('--no-write'),
    output: argv.find((arg) => arg.startsWith('--output='))?.split('=')[1] || DEFAULT_OUTPUT,
    limit: Number(argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || '5000'),
  };
}

function buildSmokeRows() {
  return [
    {
      trade_id: 'smoke-btc-win',
      market: 'crypto',
      exchange: 'binance',
      symbol: 'BTC/USDT',
      status: 'closed',
      entry_price: 100,
      exit_price: 104,
      entry_value: 100,
      exit_value: 104,
      pnl_percent: 4,
      tp_sl_set: true,
      market_regime: 'trending_bull',
      strategy_family: 'micro_swing',
    },
    {
      trade_id: 'smoke-lunc-outlier',
      market: 'crypto',
      exchange: 'binance',
      symbol: 'LUNC/USDT',
      status: 'closed',
      entry_price: 0.0001,
      exit_price: 0.000102,
      entry_value: 100,
      exit_value: 102,
      pnl_percent: 51753432497.59,
      tp_sl_set: false,
      market_regime: 'trending_bull',
      strategy_family: null,
    },
    {
      trade_id: 'smoke-domestic-bear',
      market: 'domestic',
      exchange: 'kis',
      symbol: '005930',
      status: 'closed',
      entry_price: 70000,
      exit_price: 69300,
      entry_value: 70000,
      exit_value: 69300,
      pnl_percent: -1,
      tp_sl_set: true,
      market_regime: 'trending_bear',
      strategy_family: 'short_term_scalping',
    },
  ];
}

async function loadRows({ limit }) {
  return db.query(
    `SELECT
       trade_id, market, exchange, symbol, status, direction,
       entry_time, exit_time, entry_price, exit_price, entry_value, exit_value,
       pnl_percent, tp_sl_set, market_regime, strategy_family, hold_duration
     FROM investment.trade_journal
     ORDER BY COALESCE(exit_time, entry_time, 0) DESC
     LIMIT $1`,
    [limit],
  );
}

export async function runTradeAnalyticsReport(args = parseArgs()) {
  const rows = args.smoke ? buildSmokeRows() : await loadRows({ limit: args.limit });
  const report = buildTradeAnalyticsReport(rows);
  if (!args.noWrite) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, JSON.stringify(report, null, 2));
  }
  return { ...report, output: args.noWrite ? null : args.output, source: args.smoke ? 'smoke_fixture' : 'db' };
}

async function main() {
  const args = parseArgs();
  const result = await runTradeAnalyticsReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`runtime-luna-trade-analytics-report status=${result.status} rows=${result.summary.total}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ runtime-luna-trade-analytics-report 실패:' });
}
