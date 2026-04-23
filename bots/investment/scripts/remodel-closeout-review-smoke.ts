#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildDecision as buildCloseoutDecision } from './remodel-closeout-report.ts';
import { buildBlockers, buildDecision as buildBlockerDecision } from './remodel-blockers-report.ts';
import { buildTradeReviewRepairCloseout, summarizeTradeReviewFindings } from './validate-trade-review.ts';

function baseInput(summary) {
  const tradeReview = {
    findings: Number(summary.liveFindings || 0) + Number(summary.paperFindings || 0),
    closedTrades: 10,
    scopedLiveClosedTrades: 4,
    scopedPaperClosedTrades: 6,
    summary,
  };
  return {
    health: { serviceHealth: { okCount: 13, warnCount: 0 } },
    plannerCoverage: { decision: { status: 'planner_coverage_ready' } },
    autotune: { decision: { status: 'autotune_ready' } },
    relief: { decision: { status: 'relief_ready' } },
    escalate: { decision: { status: 'escalate_ready' } },
    backtest: { decision: { status: 'backtest_ok' } },
    tradeReview,
    reviewRepairCloseout: buildTradeReviewRepairCloseout({ before: tradeReview, after: tradeReview, fix: false }),
  };
}

export function runRemodelCloseoutReviewSmoke() {
  const paperOnlySummary = summarizeTradeReviewFindings([
    { tradeId: 'paper-1', symbol: 'PHA/USDT', exchange: 'binance', isPaper: true, issues: ['missing_review'] },
  ]);
  const paperOnlyInput = baseInput(paperOnlySummary);
  const paperOnlyDecision = buildCloseoutDecision(paperOnlyInput);
  assert.equal(paperOnlyDecision.status, 'remodel_ready_to_close');
  assert.equal(paperOnlyDecision.metrics.tradeReviewLiveOk, true);
  assert.equal(paperOnlyDecision.metrics.tradeReviewPaperRepair, true);
  assert.match(paperOnlyDecision.actionItems.join('\n'), /paper-only trade_review/);

  const paperOnlyBlockers = buildBlockers({ ...paperOnlyInput, decision: paperOnlyDecision });
  assert.equal(paperOnlyBlockers.some((blocker) => blocker.category === 'trade_review'), false);

  const liveSummary = summarizeTradeReviewFindings([
    { tradeId: 'live-1', symbol: 'TAO/USDT', exchange: 'binance', isPaper: false, issues: ['pnl_percent_mismatch'] },
    { tradeId: 'paper-2', symbol: 'PHA/USDT', exchange: 'binance', isPaper: true, issues: ['missing_review'] },
  ]);
  const liveInput = baseInput(liveSummary);
  const liveDecision = buildCloseoutDecision(liveInput);
  assert.equal(liveDecision.status, 'remodel_data_integrity_needed');
  assert.equal(liveDecision.metrics.tradeReviewLiveOk, false);

  const liveBlockers = buildBlockers({ ...liveInput, decision: liveDecision });
  assert.equal(liveBlockers.some((blocker) => blocker.category === 'trade_review'), true);
  assert.equal(buildBlockerDecision(liveBlockers).status, 'data_integrity_blockers_present');

  return {
    ok: true,
    paperOnlyStatus: paperOnlyDecision.status,
    liveStatus: liveDecision.status,
    liveBlockerStatus: buildBlockerDecision(liveBlockers).status,
  };
}

async function main() {
  const result = runRemodelCloseoutReviewSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('remodel closeout review smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ remodel closeout review smoke 실패:',
  });
}
