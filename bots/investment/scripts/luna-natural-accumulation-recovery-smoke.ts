#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildNaturalCheckpoint,
  collectNaturalCounts,
} from './runtime-luna-7day-natural-checkpoint.ts';
import {
  runActionAutoApplyIfEnabled,
  _testOnly as workerTestOnly,
} from './runtime-posttrade-feedback-worker.ts';
import { runPosttradeFeedbackDrill } from './runtime-posttrade-feedback-drill.ts';
import { fetchPendingPosttradeCandidates } from '../shared/trade-quality-evaluator.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const failedCounts = await collectNaturalCounts({
  queryFn: async () => {
    throw new Error('read-only query failed');
  },
});
assert.equal(failedCounts.reflexions, null);
assert.equal(failedCounts.queryErrors.length, 4);

const failedCheckpoint = buildNaturalCheckpoint({
  accumulation: {
    days: 14,
    ...failedCounts,
  },
});
assert.equal(failedCheckpoint.ok, false);
assert.equal(failedCheckpoint.status, 'query_error');
assert.equal(failedCheckpoint.progress.reflexions.current, null);
assert.equal(failedCheckpoint.pendingObservation[0], 'reflexions:query_error');
assert.equal(failedCheckpoint.diagnostics.operatingEpochImpact, null);

const actionAutoApply = await runActionAutoApplyIfEnabled({
  cfg: { parameter_feedback_map: { auto_apply: true } },
  dryRun: false,
  noAutoApply: true,
});
assert.equal(actionAutoApply.code, 'posttrade_action_auto_apply_suppressed');
assert.deepEqual(actionAutoApply.applied, []);

const parsed = workerTestOnly.parseArgs(['--once', '--no-auto-apply', '--market=all', '--limit=20']);
assert.equal(parsed.noAutoApply, true);
assert.equal(parsed.limit, 20);

const partialFailure = workerTestOnly.buildWorkerRunPayload({
  startedAt: '2026-07-20T00:00:00.000Z',
  completedAt: '2026-07-20T00:01:00.000Z',
  cfg: {
    mode: 'supervised_l4',
    skill_extraction: { enabled: true },
    dashboard: { enabled: true },
    parameter_feedback_map: { auto_apply: true },
  },
  args: { market: 'all', dryRun: false, noAutoApply: true, force: false },
  result: { processed: 2, errors: 1 },
  skillExtraction: { ok: false, code: 'posttrade_skill_extraction_failed' },
  dashboard: { ok: true },
  dashboardRecord: { ok: true },
  actionAutoApply: { ok: true, code: 'posttrade_action_auto_apply_suppressed' },
  learningDays: 14,
});
assert.equal(partialFailure.ok, false);
assert.deepEqual(partialFailure.failureCodes, [
  'posttrade_feedback_errors',
  'posttrade_skill_extraction_failed',
]);
assert.equal(workerTestOnly.resolveWorkerExitCode(partialFailure), 1);
const failedHeartbeatPath = path.join(__dirname, '..', 'output', 'test', 'posttrade-worker-partial-failure.json');
workerTestOnly.writeHeartbeat(failedHeartbeatPath, partialFailure);
assert.equal(JSON.parse(fs.readFileSync(failedHeartbeatPath, 'utf8')).ok, false);
fs.rmSync(failedHeartbeatPath, { force: true });

await assert.rejects(
  fetchPendingPosttradeCandidates({
    limit: 2,
    market: 'all',
    throwOnQueryError: true,
    queryFn: async () => {
      throw new Error('fixture_db_unavailable');
    },
  }),
  (error: any) => error?.code === 'posttrade_candidate_query_failed'
    && error?.source === 'knowledge'
    && /fixture_db_unavailable/.test(error?.message || ''),
);

const queryFailure = workerTestOnly.buildWorkerRunPayload({
  cfg: {},
  args: { market: 'all' },
  result: {
    ok: false,
    code: 'posttrade_candidate_query_failed',
    processed: 0,
    errors: 1,
  },
});
assert.equal(queryFailure.ok, false);
assert.deepEqual(queryFailure.failureCodes, [
  'posttrade_candidate_query_failed',
  'posttrade_feedback_errors',
]);
assert.equal(workerTestOnly.resolveWorkerExitCode(queryFailure), 1);

const drill = await runPosttradeFeedbackDrill({}, {
  fetchPendingCandidates: async () => [{ tradeId: 1, source: 'trade_journal_scan' }],
  fetchRecentClosedTrades: async () => [{ id: 1, symbol: 'BTCUSDT', market: 'crypto' }],
  countPendingCandidates: async () => 6,
  buildDashboard: async () => ({ ok: true, quality: { total: 0 } }),
});
assert.equal(drill.limit, 20);
assert.equal(drill.pendingTotal, 6);
assert.equal(drill.liveMutation, false);
assert.equal(drill.recentClosedTrades[0].market, 'crypto');

const plistPath = path.join(__dirname, '..', 'launchd', 'ai.luna.posttrade-feedback-15min.plist');
const plist = fs.readFileSync(plistPath, 'utf8');
assert.match(plist, /runtime-posttrade-feedback-worker\.ts/);
assert.match(plist, /<string>--once<\/string>/);
assert.match(plist, /<string>--market=all<\/string>/);
assert.match(plist, /<string>--limit=20<\/string>/);
assert.match(plist, /<string>--no-auto-apply<\/string>/);
assert.doesNotMatch(plist, /runtime-posttrade-feedback-drill\.ts/);

console.log(JSON.stringify({
  ok: true,
  queryErrorCount: failedCounts.queryErrors.length,
  autoApplyCode: actionAutoApply.code,
  partialFailureCodes: partialFailure.failureCodes,
  pendingTotal: drill.pendingTotal,
  liveMutation: drill.liveMutation,
}));
