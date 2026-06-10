#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildLunaSymbolExitTimingStrategyReport,
  resolveSymbolExitPolicy,
} from '../shared/luna-symbol-exit-timing-strategy.ts';
import { buildOptimalExitAnalysisReport } from '../shared/optimal-exit-analysis.ts';

function dayMs(index) {
  return Date.parse('2026-01-01T00:00:00Z') + index * 24 * 60 * 60 * 1000;
}

function buildPeakBars() {
  const closes = Array.from({ length: 30 }, (_, index) => 10 + index * 0.02)
    .concat([10, 12, 15, 20, 17, 14, 12, 11, 10.5]);
  return closes.map((close, index) => ({
    time: dayMs(index),
    open: close * 0.97,
    high: close * 1.08,
    low: close * 0.92,
    close,
    volume: index === 33 ? 9000 : 1000,
  }));
}

function buildRecoveryBars() {
  const closes = Array.from({ length: 30 }, (_, index) => 20 - index * 0.05)
    .concat([18, 17, 16, 17, 19, 22, 24, 26]);
  return closes.map((close, index) => ({
    time: dayMs(index),
    open: close * 0.98,
    high: close * 1.04,
    low: close * 0.94,
    close,
    volume: 1000 + index * 10,
  }));
}

export async function runSmoke() {
  const optimalExitReport = buildOptimalExitAnalysisReport({
    generatedAt: '2026-02-01T00:00:00.000Z',
    includeRecords: true,
    trades: [
      ...[1, 2, 3].map((index) => ({
        trade_id: `late-${index}`,
        market: 'crypto',
        exchange: 'binance',
        symbol: 'PEAK/USDT',
        status: 'closed',
        direction: 'long',
        entry_time: dayMs(30),
        exit_time: dayMs(37),
        entry_price: 10,
        exit_price: 11,
        pnl_percent: 10,
        quality_flag: 'trusted',
        exclude_from_learning: false,
        strategy_family: 'momentum_rotation',
      })),
      {
        trade_id: 'recovery-1',
        market: 'crypto',
        exchange: 'binance',
        symbol: 'RECOVER/USDT',
        status: 'closed',
        direction: 'long',
        entry_time: dayMs(30),
        exit_time: dayMs(32),
        entry_price: 18,
        exit_price: 16,
        pnl_percent: -11.1111,
        quality_flag: 'trusted',
        exclude_from_learning: false,
        strategy_family: 'mean_reversion',
      },
    ],
    barsBySymbol: {
      'crypto:PEAK/USDT': buildPeakBars(),
      'crypto:RECOVER/USDT': buildRecoveryBars(),
    },
  });

  const report = buildLunaSymbolExitTimingStrategyReport({
    optimalExitReport,
    generatedAt: '2026-02-01T00:00:00.000Z',
    source: 'smoke_fixture',
  });

  assert.equal(report.ok, true);
  assert.equal(report.readOnly, true);
  assert.equal(report.liveTradeImpact, false);
  assert.equal(report.scope.symbols, 2);
  assert.ok(report.allSymbols.includes('crypto:PEAK/USDT'));
  assert.ok(report.tradeRows.some((row) => row.currentFromExitPct != null));
  assert.ok(report.symbolList.some((row) => row.recommendedExitPolicy === 'peak_reversal_partial_trailing'));
  assert.equal(report.symbolExitPolicyMatrix.status, 'materialized');
  assert.equal(report.symbolExitPolicyMatrix.p0Symbols, 1);
  assert.equal(
    resolveSymbolExitPolicy(report, { market: 'crypto', symbol: 'PEAK/USDT' })?.policy,
    'peak_reversal_partial_trailing',
  );
  assert.ok(report.strategyActions.some((row) => row.id === 'current_close_post_exit_label'));

  return {
    ok: true,
    status: report.status,
    symbols: report.scope.symbols,
    allSymbols: report.allSymbols,
    strategyActions: report.strategyActions.map((item) => item.id),
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`luna-symbol-exit-timing-strategy-smoke status=${result.status}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'luna-symbol-exit-timing-strategy-smoke error:' });
}
