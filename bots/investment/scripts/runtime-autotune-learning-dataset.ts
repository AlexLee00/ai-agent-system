#!/usr/bin/env node
// @ts-nocheck
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildAutotuneLearningDataset } from '../shared/autotune-learning-dataset.ts';
import { LUNA_AUTONOMY_PHASES } from '../shared/autonomy-phase.ts';

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    smoke: argv.includes('--smoke'),
    limit: Number(argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || '5000'),
  };
}

function buildSmokeRows() {
  return [
    {
      trade_id: 'pre-1',
      symbol: 'BTC/USDT',
      market: 'crypto',
      exchange: 'binance',
      status: 'closed',
      entry_price: 100,
      exit_price: 105,
      pnl_percent: 5,
      autonomy_phase: LUNA_AUTONOMY_PHASES.L4_PRE_AUTOTUNE,
      strategy_family: 'micro_swing',
      market_regime: 'ranging',
    },
    {
      trade_id: 'post-1',
      symbol: 'ETH/USDT',
      market: 'crypto',
      exchange: 'binance',
      status: 'closed',
      entry_price: 100,
      exit_price: 98,
      pnl_percent: -2,
      autonomy_phase: LUNA_AUTONOMY_PHASES.L4_POST_AUTOTUNE,
      strategy_family: 'momentum_rotation',
      market_regime: 'trending_bull',
    },
  ];
}

async function loadRows({ limit }) {
  return db.query(
    `SELECT
       trade_id, symbol, market, exchange, status, direction,
       entry_price, exit_price, entry_value, exit_value,
       pnl_percent, autonomy_phase, strategy_family, market_regime, exit_time
     FROM investment.trade_journal
     WHERE status = 'closed' OR exit_time IS NOT NULL
     ORDER BY COALESCE(exit_time, entry_time, 0) DESC
     LIMIT $1`,
    [limit],
  );
}

export async function runAutotuneLearningDataset(args = parseArgs()) {
  const rows = args.smoke ? buildSmokeRows() : await loadRows({ limit: args.limit });
  const report = buildAutotuneLearningDataset(rows);
  return {
    ...report,
    status: report.preAutotuneIncluded > 0 ? 'pre_autotune_integrated' : 'pre_autotune_missing',
    sample: report.dataset.slice(0, 10),
    dataset: undefined,
  };
}

async function main() {
  const args = parseArgs();
  const result = await runAutotuneLearningDataset(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`runtime-autotune-learning-dataset status=${result.status} rows=${result.learningRows}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ runtime-autotune-learning-dataset 실패:' });
}
