#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { pathToFileURL } from 'url';
import {
  buildTradeReviewRepairCloseout,
  summarizeTradeReviewFindings,
} from './validate-trade-review.ts';

export function runValidateTradeReviewSmoke() {
  const summary = summarizeTradeReviewFindings([
    { tradeId: 'a', symbol: 'PHA/USDT', exchange: 'binance', isPaper: false, issues: ['pnl_percent_mismatch'] },
    { tradeId: 'b', symbol: 'PHA/USDT', exchange: 'binance', isPaper: true, issues: ['missing_review', 'missing_max_favorable'] },
    { tradeId: 'c', symbol: 'TAO/USDT', exchange: 'binance', isPaper: false, issues: ['pnl_percent_mismatch'] },
  ]);

  assert.equal(summary.issueCounts.pnl_percent_mismatch, 2);
  assert.equal(summary.issueCounts.missing_review, 1);
  assert.equal(summary.topIssue.key, 'pnl_percent_mismatch');
  assert.equal(summary.topExchange.key, 'binance');
  assert.equal(summary.topSymbol.key, 'PHA/USDT');
  assert.equal(summary.liveFindings, 2);
  assert.equal(summary.paperFindings, 1);
  assert.equal(summary.paperOnly, false);
  assert.match(summary.repairCommand, /validate-review:repair/);
  assert.match(summary.fixCommand, /validate-review:fix/);
  assert.match(summary.repairHint, /pnl_percent/);

  const paperOnly = summarizeTradeReviewFindings([
    { tradeId: 'p1', symbol: 'ANKR/USDT', exchange: 'binance', isPaper: true, issues: ['missing_review'] },
  ]);
  assert.equal(paperOnly.liveFindings, 0);
  assert.equal(paperOnly.paperFindings, 1);
  assert.equal(paperOnly.paperOnly, true);
  assert.match(paperOnly.repairCommand, /repair:paper/);
  assert.match(paperOnly.fixCommand, /fix:paper/);
  assert.match(paperOnly.recheckCommand, /validate-review/);

  const empty = summarizeTradeReviewFindings([]);
  assert.deepEqual(empty.issueCounts, {});
  assert.equal(empty.topIssue, null);
  assert.doesNotMatch(empty.repairCommand, /--paper-only/);

  const dryRunCloseout = buildTradeReviewRepairCloseout({
    before: { findings: 2, scope: 'paper', closedTrades: 2, scopedLiveClosedTrades: 0, scopedPaperClosedTrades: 2, summary: paperOnly },
    after: { findings: 2, scope: 'paper', closedTrades: 2, scopedLiveClosedTrades: 0, scopedPaperClosedTrades: 2, summary: paperOnly },
    fix: false,
  });
  assert.equal(dryRunCloseout.status, 'trade_review_repair_dry_run');
  assert.equal(dryRunCloseout.dryRun, true);
  assert.equal(dryRunCloseout.liveSafe, true);
  assert.equal(dryRunCloseout.beforePaperClosedTrades, 2);
  assert.match(dryRunCloseout.actionItems[0], /repair:paper/);

  const closedCloseout = buildTradeReviewRepairCloseout({
    before: { findings: 2, scope: 'paper', closedTrades: 2, scopedLiveClosedTrades: 0, scopedPaperClosedTrades: 2, summary: paperOnly },
    repair: { fixed: 2, fixedLive: 0, fixedPaper: 2, scope: 'paper', closedTrades: 2, scopedLiveClosedTrades: 0, scopedPaperClosedTrades: 2 },
    after: { findings: 0, scope: 'paper', closedTrades: 2, scopedLiveClosedTrades: 0, scopedPaperClosedTrades: 2, summary: empty },
    fix: true,
  });
  assert.equal(closedCloseout.status, 'trade_review_repair_closed');
  assert.equal(closedCloseout.fixedPaper, 2);
  assert.equal(closedCloseout.fixedLive, 0);
  assert.equal(closedCloseout.liveSafe, true);

  return { ok: true, summary, paperOnly, empty, dryRunCloseout, closedCloseout };
}

async function main() {
  const result = runValidateTradeReviewSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('validate trade review smoke ok');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('❌ validate trade review smoke 실패:', err?.message || String(err));
    process.exit(1);
  });
}
