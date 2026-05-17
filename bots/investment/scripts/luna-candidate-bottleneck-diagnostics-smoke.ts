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
  assert.equal(rows.find((row) => row.symbol === 'NEG/USDT')?.recommendedAction, 'strategy_enhancement_shadow');
  assert.equal(rows.find((row) => row.symbol === 'ALPHA/USDT')?.recommendedAction, 'strategy_enhancement_shadow');
  assert.equal(rows.find((row) => row.symbol === 'MISS/USDT')?.recommendedAction, 'refresh_evidence');
  assert.equal(rows.every((row) => row.shadowOnly === true && row.liveMutation === false), true, 'shadow-only rows');
  assert.ok((rows.find((row) => row.symbol === 'NEG/USDT')?.candidateSelectionPenalty || 0) > 0.3);
  const neg = rows.find((row) => row.symbol === 'NEG/USDT');
  assert.equal(neg?.backtestFresh, true, 'trace includes backtestFresh');
  assert.equal(neg?.backtestGateStatus, 'would_block_unhealthy', 'trace includes backtestGateStatus');
  assert.equal(neg?.predictiveDecision, 'block_backtest_gate', 'trace includes predictiveDecision');
  assert.equal(neg?.communityEvidenceCount24h, 5, 'trace includes communityEvidenceCount24h');
  assert.equal(neg?.communitySourceCount24h, 5, 'trace includes communitySourceCount24h');
  assert.ok(neg?.primaryBlocker, 'trace includes primaryBlocker');
  assert.ok(String(neg?.recommendedRefreshCommand || '').includes('runtime:luna-phase4-strategy-enhancement-shadow'), 'trace includes strategy enhancement command');
  assert.ok(
    String(rows.find((row) => row.symbol === 'ALPHA/USDT')?.recommendedRefreshCommand || '').includes('runtime:luna-phase4-strategy-enhancement-shadow'),
    'strategy enhancement rows point to phase4 shadow command',
  );

  await expectRejectsApplyDryRun();
  const runtime = await runLunaCandidateBottleneckDiagnostics({ fixture: true, dryRun: true, json: true });
  assert.equal(runtime.summary.total, 4, 'runtime fixture count');
  assert.equal(runtime.summary.liveMutation, false, 'runtime no live mutation');
  assert.equal(runtime.summary.byAction.strategy_enhancement_shadow, 2, 'strategy action count');
  assert.ok(runtime.summary.topPrimaryBlockers.length > 0, 'runtime exposes top primary blockers');

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
