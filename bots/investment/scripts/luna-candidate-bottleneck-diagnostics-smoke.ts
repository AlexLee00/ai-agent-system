#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildLunaCandidateBottleneckRows,
  fixtureCandidateBottleneckInputs,
} from '../shared/luna-candidate-bottleneck-diagnostics.ts';
import { runLunaCandidateBottleneckDiagnostics } from './runtime-luna-candidate-bottleneck-diagnostics.ts';

async function expectRejectsApplyDryRun() {
  await assert.rejects(
    () => runLunaCandidateBottleneckDiagnostics({
      fixture: true,
      apply: true,
      dryRun: true,
      confirm: 'luna-candidate-bottleneck-shadow',
      json: true,
    }),
    /cannot combine --apply with --dry-run/,
  );
}

export async function runLunaCandidateBottleneckDiagnosticsSmoke() {
  const rows = buildLunaCandidateBottleneckRows(fixtureCandidateBottleneckInputs());
  assert.equal(rows.length, 4, 'fixture row count');
  assert.equal(rows.find((row) => row.symbol === 'BTC/USDT')?.recommendedAction, 'monitor_pass_candidate');
  assert.equal(rows.find((row) => row.symbol === 'NEG/USDT')?.recommendedAction, 'quarantine_candidate_shadow');
  assert.equal(rows.find((row) => row.symbol === 'ALPHA/USDT')?.recommendedAction, 'strategy_enhancement_shadow');
  assert.equal(rows.find((row) => row.symbol === 'MISS/USDT')?.recommendedAction, 'refresh_evidence');
  assert.equal(rows.every((row) => row.shadowOnly === true && row.liveMutation === false), true, 'shadow-only rows');
  assert.ok((rows.find((row) => row.symbol === 'NEG/USDT')?.candidateSelectionPenalty || 0) > 0.3);

  await expectRejectsApplyDryRun();
  const runtime = await runLunaCandidateBottleneckDiagnostics({ fixture: true, dryRun: true, json: true });
  assert.equal(runtime.summary.total, 4, 'runtime fixture count');
  assert.equal(runtime.summary.liveMutation, false, 'runtime no live mutation');
  assert.equal(runtime.summary.byAction.strategy_enhancement_shadow, 1, 'strategy action count');

  return {
    ok: true,
    smoke: 'luna-candidate-bottleneck-diagnostics',
    checks: {
      rows: rows.length,
      actions: runtime.summary.byAction,
      averagePenalty: runtime.summary.averagePenalty,
      liveMutation: false,
      applyDryRunRejected: true,
    },
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: runLunaCandidateBottleneckDiagnosticsSmoke,
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'luna-candidate-bottleneck-diagnostics-smoke error:',
  });
}
