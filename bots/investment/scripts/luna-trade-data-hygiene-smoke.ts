#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildTradeDataHygieneFindings,
  isExpectedPolicyBlockCode,
  resolveExpectedPolicyBlockStatus,
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

const payload = {
  ok: true,
  openJournal: openJournal.summary,
  findings: findings.map((finding) => ({ id: finding.id, severity: finding.severity, count: finding.count })),
};

if (process.argv.includes('--json')) console.log(JSON.stringify(payload, null, 2));
else console.log('luna-trade-data-hygiene-smoke ok');
