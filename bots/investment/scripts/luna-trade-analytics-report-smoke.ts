#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { safeJournalPnlPercent } from '../shared/trade-journal-db.ts';
import { buildTradeAnalyticsReport } from '../shared/trade-analytics-report.ts';
import { runTradeAnalyticsReport } from './runtime-luna-trade-analytics-report.ts';

function findAction(report, id) {
  return report.reinforcementActions.find((action) => action.id === id);
}

export async function runSmoke() {
  assert.equal(
    safeJournalPnlPercent({
      entryPrice: 0.0001,
      exitPrice: 100,
      entryValue: 100,
      exitValue: 102,
      pnlPercent: 999999999,
    }),
    2,
    'micro-price outlier must fall back to value-based pnl',
  );
  assert.equal(
    safeJournalPnlPercent({ entryPrice: 100, exitPrice: 95, direction: 'SHORT' }),
    5,
    'short pnl calculation must invert price delta',
  );

  const report = await runTradeAnalyticsReport({ smoke: true, noWrite: true, limit: 100, json: true });
  assert.equal(report.ok, true);
  assert.equal(report.summary.total, 3);
  assert.equal(report.summary.closed, 3);
  assert.equal(report.summary.rawPnlOutlierCount, 1);
  assert.equal(report.summary.potentiallyCorrectedPnlCount, 1);
  assert.equal(report.strategyFamily.unknownCount, 1);
  assert.equal(report.strategyFamily.shortTermCount, 2);
  assert.equal(report.tpSl.unset.closed, 1);
  assert.equal(report.earlyExit.total, 1);
  assert.equal(report.earlyExit.smallProfit, 0);
  assert.equal(findAction(report, 'pnl_percent_rebuild_and_outlier_guard')?.status, 'warning');
  assert.equal(findAction(report, 'strategy_family_required')?.status, 'warning');
  assert.equal(findAction(report, 'early_exit_cluster_review')?.status, 'watch');
  assert.ok(report.nextActions.some((action) => action.includes('rebuild-pnl-percent')));
  assert.ok(report.nextActions.some((action) => action.includes('autotune')));

  const immatureTrendReport = buildTradeAnalyticsReport([
    { status: 'closed', market: 'crypto', symbol: 'A/USDT', strategy_family: 'trend_following', pnl_percent: -1, tp_sl_set: true },
    { status: 'closed', market: 'crypto', symbol: 'B/USDT', strategy_family: 'trend_following', pnl_percent: -2, tp_sl_set: true },
    { status: 'closed', market: 'crypto', symbol: 'C/USDT', strategy_family: 'trend_following', pnl_percent: -3, tp_sl_set: true },
  ], { includeMarketSegments: false });
  assert.equal(findAction(immatureTrendReport, 'trend_following_quality_review')?.status, 'watch');
  assert.equal(immatureTrendReport.status, 'ready');

  const matureTrendRows = Array.from({ length: 10 }, (_, index) => ({
    status: 'closed',
    market: 'crypto',
    symbol: `T${index}/USDT`,
    strategy_family: 'trend_following',
    pnl_percent: -1,
    tp_sl_set: true,
  }));
  const matureTrendReport = buildTradeAnalyticsReport(matureTrendRows, { includeMarketSegments: false });
  assert.equal(findAction(matureTrendReport, 'trend_following_quality_review')?.status, 'warning');
  assert.equal(matureTrendReport.status, 'needs_attention');
  return {
    ok: true,
    status: report.status,
    summary: report.summary,
    reinforcementActions: report.reinforcementActions.length,
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`luna-trade-analytics-report-smoke status=${result.status}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ luna-trade-analytics-report-smoke 실패:' });
}
