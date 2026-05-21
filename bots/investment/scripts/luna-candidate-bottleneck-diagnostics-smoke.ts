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
  assert.equal(neg?.predictiveScore, 0.32, 'trace includes predictiveScore');
  assert.equal(neg?.predictiveCoverage, 1, 'trace includes predictiveCoverage');
  assert.equal(neg?.predictiveBlockedReason, 'backtest_unhealthy', 'trace includes predictiveBlockedReason');
  assert.equal(neg?.communityEvidenceCount24h, 5, 'trace includes communityEvidenceCount24h');
  assert.equal(neg?.communitySourceCount24h, 5, 'trace includes communitySourceCount24h');
  assert.equal(neg?.candidateQualityAdjustedScore, 0.79, 'trace includes quality-adjusted candidate score fallback');
  assert.equal(neg?.backtestPeriodSummary?.length, 2, 'trace includes backtest period summary');
  assert.ok(neg?.backtestStrategyFamilies?.includes('ema_trend_pullback'), 'trace includes strategy family breakdown');
  assert.ok(neg?.evidence?.trace?.backtestFailingPeriods?.includes(90), 'trace marks failing walk-forward periods');
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

  const officialOhlcvRows = buildLunaCandidateBottleneckRows([{
    candidate: { symbol: '477850', market: 'domestic', score: 0.6, source: 'fixture', discovered_at: new Date().toISOString() },
    backtest: {
      fresh: true,
      healthy: false,
      would_block: true,
      gate_status: 'would_block_no_data',
      block_reasons: ['backtest_insufficient_official_ohlcv'],
      last_backtest_at: new Date().toISOString(),
    },
    predictive: { decision: 'block_backtest_gate', score: 0, component_coverage: 0.75, blocked_reason: 'backtest_unhealthy', created_at: new Date().toISOString() },
    community: { avg_score: 0.42, event_count: 8, source_count: 3, market_event_count: 8, market_source_count: 3, last_seen_at: new Date().toISOString() },
  }]);
  const officialOhlcv = officialOhlcvRows[0];
  assert.equal(officialOhlcv?.primaryBlocker, 'official_ohlcv_missing', 'official OHLCV gaps become a distinct primary blocker');
  assert.equal(officialOhlcv?.recommendedAction, 'official_ohlcv_reference_refresh', 'official OHLCV gaps route to official reference refresh');
  assert.ok(String(officialOhlcv?.recommendedRefreshCommand || '').includes('runtime:luna-domestic-official-reference'), 'official OHLCV gaps point to domestic official reference check');
  assert.equal(officialOhlcv?.evidence?.trace?.backtestOfficialOhlcvGap, true, 'trace marks official OHLCV gap');

  await expectRejectsApplyDryRun();
  const runtime = await runLunaCandidateBottleneckDiagnostics({ fixture: true, dryRun: true, json: true });
  assert.equal(runtime.summary.total, 4, 'runtime fixture count');
  assert.equal(runtime.summary.liveMutation, false, 'runtime no live mutation');
  assert.equal(runtime.summary.byAction.strategy_enhancement_shadow, 2, 'strategy action count');
  assert.equal(runtime.summary.selectionPolicy, 'quality_adjusted_score_desc_with_prior_bottleneck_penalty', 'runtime exposes selection policy');
  assert.ok(runtime.summary.topPrimaryBlockers.length > 0, 'runtime exposes top primary blockers');
  assert.equal(runtime.summary.backtestQualityTarget.mode, 'shadow_actionable_quality_slo', 'runtime exposes backtest quality target mode');
  assert.equal(runtime.summary.backtestQualityTarget.targetTotal, 4, 'runtime target defaults to all rows without active cooldown');
  assert.equal(runtime.summary.backtestQualityTarget.achieved, false, 'fixture target should remain unmet until remediation runs');
  assert.ok(runtime.summary.backtestQualityTarget.gaps.length > 0, 'runtime exposes target gaps');
  assert.ok(runtime.summary.backtestQualityTarget.recommendedLoop[0].includes('runtime:luna-candidate-backtest-refresh'), 'runtime exposes remediation loop command');
  assert.equal(runtime.summary.predictiveQualityTarget.mode, 'shadow_predictive_quality_slo', 'runtime exposes predictive quality target mode');
  assert.equal(runtime.summary.predictiveQualityTarget.achieved, false, 'fixture predictive target should remain unmet until refresh runs');
  assert.equal(runtime.summary.predictiveQualityTarget.backtestGateSuppressed, 1, 'backtest-gate predictive blocks are excluded from predictive refresh SLO');
  assert.ok(runtime.summary.predictiveQualityTarget.backtestGateSuppressedSymbols.includes('NEG/USDT'), 'suppressed backtest-gate symbols are exposed');
  assert.ok(runtime.summary.predictiveQualityTarget.gaps.length > 0, 'runtime exposes predictive target gaps');
  assert.equal(runtime.summary.predictiveQualityTarget.refreshSymbols.includes('NEG/USDT'), false, 'backtest-gate blocks should not be routed to predictive refresh');
  assert.ok(runtime.summary.predictiveQualityTarget.refreshSymbols.includes('MISS/USDT'), 'true predictive missing/stale rows remain refresh targets');
  assert.ok(runtime.summary.predictiveQualityTarget.recommendedLoop[0].includes('runtime:luna-predictive-evidence-refresh'), 'runtime exposes predictive refresh loop command');

  return {
    ok: true,
    smoke: 'luna-candidate-bottleneck-diagnostics',
    checks: {
      rows: rows.length,
      actions: runtime.summary.byAction,
      averagePenalty: runtime.summary.averagePenalty,
      backtestQualityTarget: runtime.summary.backtestQualityTarget,
      predictiveQualityTarget: runtime.summary.predictiveQualityTarget,
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
