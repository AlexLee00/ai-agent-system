#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildOptimalExitAnalysisReport } from '../shared/optimal-exit-analysis.ts';
import { runOptimalExitAnalysis } from './runtime-luna-optimal-exit-analysis.ts';

function dayMs(index) {
  return Date.parse('2026-01-01T00:00:00Z') + index * 24 * 60 * 60 * 1000;
}

function buildBars() {
  const closes = Array.from({ length: 30 }, (_, index) => 9 + index * 0.03)
    .concat([10, 10.5, 11.5, 13, 16, 22, 17, 14, 12, 11, 10.5, 10.2]);
  return closes.map((close, index) => ({
    time: dayMs(index),
    open: close * 0.97,
    high: close * 1.08,
    low: close * 0.91,
    close,
    volume: index === 35 ? 8000 : 1000,
  }));
}

export async function runSmoke() {
  const entryTime = dayMs(30);
  const exitTime = dayMs(39);
  const report = buildOptimalExitAnalysisReport({
    generatedAt: '2026-02-01T00:00:00.000Z',
    trades: [
      {
        trade_id: 'late-peak',
        market: 'crypto',
        exchange: 'binance',
        symbol: 'PEAK/USDT',
        status: 'closed',
        direction: 'long',
        entry_time: entryTime,
        exit_time: exitTime,
        entry_price: 10,
        exit_price: 11,
        pnl_percent: 10,
        quality_flag: 'trusted',
        exclude_from_learning: false,
        strategy_family: 'momentum_rotation',
      },
    ],
    barsBySymbol: { 'crypto:PEAK/USDT': buildBars() },
  });

  assert.equal(report.ok, true);
  assert.equal(report.scope.analyzedTrades, 1);
  assert.equal(report.summary.timingCategories.late_exit_after_peak, 1);
  assert.equal(report.topMissedDuringHold[0].bestDuringHoldCloseDate, '2026-02-05');
  assert.equal(report.topMissedDuringHold[0].bestDuringHoldClosePnlPct, 120);
  assert.equal(report.topMissedDuringHold[0].exitLabels.status, 'materialized');
  assert.equal(report.topMissedDuringHold[0].exitLabels.forward['5d'].status, 'materialized');
  assert.equal(report.topMissedDuringHold[0].peakReversalRisk.status, 'materialized');
  assert.equal(report.summary.exitLabelCoverage.status, 'materialized');
  assert.equal(report.summary.peakReversalRisk.status, 'materialized');
  assert.ok(report.summary.optimalReasonTags.upper_bollinger_band >= 1);
  assert.ok(report.summary.optimalReasonTags.next5d_drawdown_over_5pct >= 1);
  assert.equal(report.recommendations.find((item) => item.id === 'peak_reversal_probability_head')?.priority, 'P1');
  assert.equal(report.recommendations.find((item) => item.id === 'dual_horizon_exit_labeling')?.priority, 'P1');

  const runtime = await runOptimalExitAnalysis({ smoke: true, noWrite: true, json: true, limit: 100, concurrency: 1 });
  assert.equal(runtime.ok, true);
  assert.equal(runtime.output, null);
  assert.ok(runtime.openPositions.length >= 1);
  assert.ok(runtime.recommendations.some((item) => item.id === 'dual_horizon_exit_labeling'));

  return {
    ok: true,
    status: report.status,
    analyzedTrades: report.scope.analyzedTrades,
    timingCategories: report.summary.timingCategories,
    runtimeAnalyzedTrades: runtime.scope.analyzedTrades,
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`luna-optimal-exit-analysis-smoke status=${result.status}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'luna-optimal-exit-analysis-smoke error:' });
}
