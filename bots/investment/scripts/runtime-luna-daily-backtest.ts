#!/usr/bin/env node
// @ts-nocheck
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runChronosLayer2Backtest } from '../team/chronos.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    symbols: ['BTC/USDT', 'ETH/USDT'],
    market: 'binance',
    days: 90,
    dryRun: true,
    smoke: false,
    confirm: '',
    json: false,
  };
  for (const arg of argv) {
    if (arg === '--json') args.json = true;
    else if (arg === '--smoke') args.smoke = true;
    else if (arg === '--apply') args.dryRun = false;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg.startsWith('--confirm=')) args.confirm = arg.split('=').slice(1).join('=');
    else if (arg.startsWith('--symbols=')) args.symbols = arg.split('=').slice(1).join('=').split(',').map((item) => item.trim()).filter(Boolean);
    else if (arg.startsWith('--market=')) args.market = arg.split('=').slice(1).join('=') || args.market;
    else if (arg.startsWith('--days=')) args.days = Math.max(1, Number(arg.split('=').slice(1).join('=') || args.days));
  }
  return args;
}

export async function runDailyBacktest(args = parseArgs()) {
  const applyAllowed = args.dryRun || args.confirm === 'luna-daily-backtest-apply';
  if (!applyAllowed) {
    return {
      ok: false,
      status: 'confirm_required',
      dryRun: args.dryRun,
      requiredConfirm: 'luna-daily-backtest-apply',
      liveTradeCommandsExecuted: false,
      results: [],
    };
  }
  const results = [];
  const fixtureRunner = () => [
    { label: 'smoke_tp2_sl1', status: 'ok', sharpe_ratio: 0.8, win_rate: 0.52, max_drawdown: 0.08, total_trades: 12, total_return: 4.2 },
  ];
  for (const symbol of args.symbols) {
    results.push(await runChronosLayer2Backtest({
      symbol,
      market: args.market,
      days: args.days,
      dryRun: args.dryRun,
      runner: args.smoke ? fixtureRunner : undefined,
    }).catch((error) => ({
      ok: false,
      symbol,
      error: error?.message || String(error),
      dryRun: args.dryRun,
    })));
  }
  return {
    ok: results.every((item) => item.ok),
    status: args.dryRun ? 'daily_backtest_dry_run' : 'daily_backtest_applied',
    dryRun: args.dryRun,
    symbols: args.symbols,
    market: args.market,
    days: args.days,
    liveTradeCommandsExecuted: false,
    smoke: args.smoke,
    results,
  };
}

async function main() {
  const args = parseArgs();
  const result = await runDailyBacktest(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`runtime-luna-daily-backtest ${result.status}`);
  if (!result.ok) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ runtime-luna-daily-backtest 실패:' });
}
