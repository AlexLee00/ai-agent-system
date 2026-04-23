#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildExecutionAttachBackfillDecision,
  summarizeExecutionAttachBackfillRows,
} from './runtime-execution-attach-backfill.ts';

export function runExecutionAttachBackfillSmoke() {
  const drySummary = summarizeExecutionAttachBackfillRows([
    { status: 'would_create_profile', attached: false, signalId: 'signal-1', metaPersisted: false },
    { status: 'skipped_no_open_position', attached: false, signalId: 'signal-2', metaPersisted: false },
    { status: 'existing_complete', attached: false, signalId: null, metaPersisted: false },
  ], { dryRun: true });

  assert.equal(drySummary.total, 3);
  assert.equal(drySummary.wouldAttach, 1);
  assert.equal(drySummary.attachCandidates, 1);
  assert.equal(drySummary.writeEligible, 1);
  assert.equal(drySummary.missingSignalId, 1);
  assert.equal(drySummary.openPositionBlocked, 1);

  const dryDecision = buildExecutionAttachBackfillDecision(drySummary, {
    dryRun: true,
    days: 7,
    limit: 25,
    exchange: 'binance',
  });
  assert.equal(dryDecision.status, 'execution_attach_backfill_candidates');
  assert.equal(dryDecision.safeToWrite, true);
  assert.match(dryDecision.actionItems.join('\n'), /signal_id 없는 거래 1건/);

  const writeSummary = summarizeExecutionAttachBackfillRows([
    { status: 'created_profile', attached: true, signalId: 'signal-1', metaPersisted: true },
  ], { dryRun: false });
  const writeDecision = buildExecutionAttachBackfillDecision(writeSummary, { dryRun: false });
  assert.equal(writeSummary.metaPersisted, 1);
  assert.equal(writeDecision.status, 'execution_attach_backfill_applied');

  const blockedSummary = summarizeExecutionAttachBackfillRows([
    { status: 'skipped_no_open_position', attached: false, signalId: 'signal-3', metaPersisted: false },
  ], { dryRun: true });
  assert.equal(
    buildExecutionAttachBackfillDecision(blockedSummary, { dryRun: true }).status,
    'execution_attach_backfill_no_open_position',
  );

  return {
    ok: true,
    dryStatus: dryDecision.status,
    writeStatus: writeDecision.status,
    blocked: blockedSummary.openPositionBlocked,
  };
}

async function main() {
  const result = runExecutionAttachBackfillSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('runtime execution attach backfill smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime execution attach backfill smoke 실패:',
  });
}
