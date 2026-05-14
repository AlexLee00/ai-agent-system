#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { get } from '../shared/db/core.ts';
import { runCandidateBacktestRefresh } from './runtime-luna-candidate-backtest-refresh.ts';

async function safeCount(tableName: string) {
  const row = await get(`SELECT count(*)::int AS count FROM ${tableName}`).catch(() => null);
  return row?.count ?? null;
}

const beforeStatus = await safeCount('candidate_backtest_status');
const beforeAudit = await safeCount('predictive_validation_log');

const result = await runCandidateBacktestRefresh({
  json: true,
  dryRun: true,
  fixture: true,
  periods: '30,90',
  limit: 10,
});

const afterStatus = await safeCount('candidate_backtest_status');
const afterAudit = await safeCount('predictive_validation_log');

assert.equal(result.ok, true);
assert.equal(result.dryRun, true);
assert.equal(result.fixture, true);
assert.equal(result.writeMode, 'dry-run');
assert.equal(result.total, 2);
assert.ok(result.passed >= 1, 'fixture must include at least one passing candidate');
assert.ok(result.wouldBlocked >= 1, 'fixture must include at least one would-block candidate');
if (beforeStatus != null && afterStatus != null) assert.equal(afterStatus, beforeStatus, 'dry-run must not write candidate status rows');
if (beforeAudit != null && afterAudit != null) assert.equal(afterAudit, beforeAudit, 'dry-run must not write predictive audit rows');

const negative = result.results.find((item) => item.symbol === 'NEG/USDT');
assert.ok(negative?.wouldBlock, 'negative fixture should be a would-block result');
assert.ok(negative?.reasons?.length > 0, 'would-block fixture should explain reasons');

const payload = {
  ok: true,
  smoke: 'luna-phase1-candidate-backtest',
  dryRunRowsUnchanged: {
    candidateBacktestStatus: beforeStatus == null || afterStatus == null ? 'table_missing_or_unchecked' : beforeStatus === afterStatus,
    predictiveValidationLog: beforeAudit == null || afterAudit == null ? 'table_missing_or_unchecked' : beforeAudit === afterAudit,
  },
  passed: result.passed,
  wouldBlocked: result.wouldBlocked,
  negativeReasons: negative?.reasons || [],
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('luna-phase1-candidate-backtest-smoke ok');
}
