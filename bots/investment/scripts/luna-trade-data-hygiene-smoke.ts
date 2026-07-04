#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildOpenJournalReconcileCommand,
  buildTradeDataHygieneFindings,
  isExpectedPolicyBlockCode,
  resolveExpectedPolicyBlockStatus,
  resolveOpenJournalReconcileMarket,
  summarizeOpenJournalHygiene,
} from '../shared/trade-data-hygiene.ts';

const nowMs = new Date('2026-05-23T00:00:00Z').getTime();
const oldEntryTime = nowMs - 8 * 3600000;
const recentEntryTime = nowMs - 20 * 60000;

const openJournal = await summarizeOpenJournalHygiene({
  nowMs,
  openEntries: [
    {
      trade_id: 'old-orphan',
      market: 'crypto',
      exchange: 'binance',
      symbol: 'AI/USDT',
      is_paper: false,
      trade_mode: 'normal',
      entry_time: oldEntryTime,
      entry_size: 1,
      entry_value: 25,
    },
    {
      trade_id: 'fresh-buy',
      market: 'crypto',
      exchange: 'binance',
      symbol: 'BTC/USDT',
      is_paper: false,
      trade_mode: 'normal',
      entry_time: recentEntryTime,
      entry_size: 0.001,
      entry_value: 65,
    },
  ],
  getPositionForEntry: async (entry) => (
    entry.symbol === 'BTC/USDT' ? { amount: 0.001 } : null
  ),
});

assert.equal(openJournal.status, 'needs_attention');
assert.equal(openJournal.summary.affectedTradeCount, 1);
assert.equal(openJournal.summary.staleNoPositionScopes, 1);
assert.equal(openJournal.scopes[0].symbol, 'AI/USDT');

assert.equal(isExpectedPolicyBlockCode('capital_guard_rejected'), true);
assert.equal(isExpectedPolicyBlockCode('sec015_overseas_stale_approval'), true);
assert.equal(isExpectedPolicyBlockCode('sec004_stale_approval'), true);
assert.equal(isExpectedPolicyBlockCode('broker_execution_error'), false);
assert.equal(resolveExpectedPolicyBlockStatus('live_position_reentry_blocked', 'failed'), 'blocked');
assert.equal(resolveExpectedPolicyBlockStatus('sec004_stale_approval', 'failed'), 'blocked');
assert.equal(resolveExpectedPolicyBlockStatus('broker_execution_error', 'failed'), 'failed');

const findings = buildTradeDataHygieneFindings({
  openJournal,
  failedExpectedPolicySignals: {
    total: 2,
    items: [{ block_code: 'capital_guard_rejected', count: 2 }],
  },
  realizedPnlCoverage: { sellCount: 3, realizedCount: 1 },
  qualityCoverage: { closedJournalTrades: 4, evaluatedClosedJournalTrades: 3 },
});

assert.deepEqual(
  findings.map((finding) => finding.id),
  [
    'open_journal_reconcile_pending',
    'expected_policy_block_persisted_as_failed',
    'realized_pnl_backfill_pending',
    'posttrade_evaluation_backfill_pending',
  ],
);
assert.equal(findings.filter((finding) => finding.severity === 'P0').length, 2);
const openJournalFinding = findings.find((finding) => finding.id === 'open_journal_reconcile_pending');
assert.equal(openJournalFinding.approvalRequired, true);
assert.equal(openJournalFinding.writeCommand.includes('--write --confirm-live'), true);
assert.equal(openJournalFinding.command.includes('--market=crypto'), true);

const overseasOpenJournal = {
  summary: { affectedTradeCount: 1 },
  scopes: [{ market: 'overseas', openTradeIds: ['os-1'] }],
};
assert.equal(resolveOpenJournalReconcileMarket(overseasOpenJournal), 'overseas');
const overseasFinding = buildTradeDataHygieneFindings({ openJournal: overseasOpenJournal })
  .find((finding) => finding.id === 'open_journal_reconcile_pending');
assert.equal(overseasFinding.command.includes('--market=overseas'), true);
assert.equal(overseasFinding.writeCommand.includes('--market=overseas'), true);

const mixedOpenJournal = {
  summary: { affectedTradeCount: 2 },
  scopes: [
    { market: 'crypto', openTradeIds: ['c-1'] },
    { market: 'overseas', openTradeIds: ['o-1'] },
  ],
};
assert.equal(resolveOpenJournalReconcileMarket(mixedOpenJournal), 'all');
const mixedFinding = buildTradeDataHygieneFindings({ openJournal: mixedOpenJournal })
  .find((finding) => finding.id === 'open_journal_reconcile_pending');
assert.equal(mixedFinding.command.includes('--market=all'), true);
assert.equal(buildOpenJournalReconcileCommand('kis').includes('--market=domestic'), true);

const payload = {
  ok: true,
  openJournal: openJournal.summary,
  findings: findings.map((finding) => ({ id: finding.id, severity: finding.severity, count: finding.count })),
};

if (process.argv.includes('--json')) console.log(JSON.stringify(payload, null, 2));
else console.log('luna-trade-data-hygiene-smoke ok');
