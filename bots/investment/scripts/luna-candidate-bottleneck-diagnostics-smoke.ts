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
  const unstableRows = buildLunaCandidateBottleneckRows([{
    candidate: { symbol: 'UNREAL/USDT', market: 'crypto', score: 0.81, source: 'fixture', discovered_at: new Date().toISOString() },
    backtest: {
      fresh: true,
      healthy: false,
      would_block: true,
      sharpe: 8,
      max_drawdown: 4,
      win_rate: 75,
      gate_status: 'would_block_unstable_backtest',
      block_reasons: ['unrealistic_sharpe(25.00)', 'backtest_unstable_sample(total_trades=4,min_period_trades=4)'],
      last_backtest_at: new Date().toISOString(),
    },
    predictive: { decision: 'fire', score: 0.71, component_coverage: 1, created_at: new Date().toISOString() },
    community: { avg_score: 0.39, event_count: 3, source_count: 3, market_event_count: 8, market_source_count: 6, last_seen_at: new Date().toISOString() },
  }]);
  const unstable = unstableRows[0];
  assert.equal(unstable?.primaryBlocker, 'backtest_unstable_or_unrealistic', 'unrealistic sharpe becomes a distinct primary blocker');
  assert.equal(unstable?.recommendedAction, 'stabilize_backtest_shadow', 'unrealistic sharpe routes to backtest stabilization');
  assert.ok(String(unstable?.recommendedRefreshCommand || '').includes('--periods=30,90,180,365'), 'stabilization command expands walk-forward periods');
  assert.equal(unstable?.evidence?.trace?.backtestUnstableOrUnrealistic, true, 'trace marks unstable backtest');

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
