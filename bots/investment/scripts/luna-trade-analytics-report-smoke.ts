#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { safeJournalPnlPercent } from '../shared/trade-journal-db.ts';
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
  assert.equal(findAction(report, 'pnl_percent_rebuild_and_outlier_guard')?.status, 'warning');
  assert.equal(findAction(report, 'strategy_family_required')?.status, 'warning');
  assert.ok(report.nextActions.some((action) => action.includes('rebuild-pnl-percent')));
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
