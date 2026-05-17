#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { CONFIRM, __test as remediationTest, runLunaCandidateQualityRemediation } from './runtime-luna-candidate-quality-remediation.ts';

export async function runLunaCandidateQualityRemediationSmoke() {
  await assert.rejects(
    () => runLunaCandidateQualityRemediation({ fixture: true, apply: true, dryRun: true, confirm: CONFIRM, json: true }),
    /cannot combine --apply with --dry-run/,
  );
  await assert.rejects(
    () => runLunaCandidateQualityRemediation({ fixture: true, apply: true, json: true }),
    /requires --confirm=luna-candidate-quality-remediation-shadow/,
  );

  const planned = await runLunaCandidateQualityRemediation({
    fixture: true,
    dryRun: true,
    json: true,
    market: 'all',
    limit: 12,
  });

  assert.equal(planned.ok, true, 'planned remediation ok');
  assert.equal(planned.status, 'luna_candidate_quality_remediation_planned', 'plan-only status');
  assert.equal(planned.writeMode, 'plan-only', 'plan-only write mode');
  assert.equal(planned.summary.liveMutation, false, 'no live mutation');
  assert.deepEqual(planned.cooldownSummary, {
    total: 0,
    byAction: {},
    backtestStabilization: 0,
    candidateCooldown: 0,
    nextReleaseAt: null,
    nextReleaseSymbol: null,
    nextReleaseMarket: null,
  }, 'fixture exposes cooldown summary');
  assert.equal(planned.backtestCooldownBlockedCount, 0, 'fixture exposes cooldown-blocked count');
  assert.deepEqual(planned.backtestCooldownBlocked, [], 'fixture has no cooldown-blocked backtest targets');
  assert.equal(planned.coverage.ok, true, 'fixture coverage passes');
  assert.equal(planned.remediationPlan.discoveryRefresh, true, 'fixture plans replacement discovery refresh');
  assert.equal(planned.remediationPlan.backtestRefresh, true, 'fixture plans backtest refresh');
  assert.equal(planned.remediationPlan.predictiveRefresh, true, 'fixture plans predictive refresh');
  assert.equal(planned.remediationPlan.strategyEnhancementShadow, true, 'fixture plans strategy shadow');
  assert.equal(planned.remediationPlan.bottleneckShadowAudit, true, 'fixture plans bottleneck audit');
  assert.equal(planned.remediationPlan.candidateQualityGovernance, true, 'fixture plans quality governance shadow');
  assert.equal(planned.remediationPlan.weightVectorShadow, true, 'fixture plans weight vector refresh');
  assert.equal(planned.remediationPlan.paperTradingShadow, true, 'fixture plans paper trading shadow');
  assert.equal(planned.remediationPlan.paperPromotionGate, true, 'fixture plans paper promotion gate');
  assert.equal(planned.plannedCommands.length, 10, 'planned command count');
  assert.equal(planned.plannedCommands.some((cmd) => cmd.includes('runtime:luna-candidate-quality-governance')), true, 'planned commands include governance shadow');
  assert.deepEqual(planned.targetedBacktestSymbols, ['MISS/USDT', 'NEG/USDT', 'ALPHA/USDT'], 'backtest refresh is symbol targeted');
  assert.deepEqual(planned.targetedSymbols.predictiveSymbols, ['NEG/USDT', 'ALPHA/USDT', 'MISS/USDT'], 'predictive refresh is symbol targeted');
  assert.deepEqual(planned.targetedSymbols.strategySymbols, ['NEG/USDT', 'ALPHA/USDT'], 'strategy enhancement is symbol targeted');
  for (const expected of [
    'runtime:luna-candidate-backtest-refresh -- --json --force --market=all --limit=12 --symbols=MISS/USDT,NEG/USDT,ALPHA/USDT',
    'runtime:luna-predictive-evidence-refresh -- --json --market=all --limit=12 --symbols=NEG/USDT,ALPHA/USDT,MISS/USDT',
    'runtime:luna-phase4-strategy-enhancement-shadow -- --json --apply --confirm=luna-phase4-strategy-enhancement-shadow --market=all --limit=12 --symbols=NEG/USDT,ALPHA/USDT',
    'runtime:luna-candidate-bottleneck-diagnostics -- --json --apply --confirm=luna-candidate-bottleneck-shadow --market=all --limit=12 --symbols=BTC/USDT,NEG/USDT,ALPHA/USDT,MISS/USDT',
    'runtime:luna-candidate-quality-governance -- --json --apply --confirm=luna-candidate-quality-governance-shadow --market=all --limit=12 --symbols=BTC/USDT,NEG/USDT,ALPHA/USDT,MISS/USDT',
    'runtime:luna-weight-vector-shadow -- --json --apply --confirm=luna-weight-vector-shadow --market=all --limit=12 --symbols=BTC/USDT,NEG/USDT,ALPHA/USDT,MISS/USDT',
    'runtime:luna-paper-trading-shadow -- --json --apply --confirm=luna-paper-trading-shadow --market=all --limit=12 --symbols=BTC/USDT,NEG/USDT,ALPHA/USDT,MISS/USDT',
    'runtime:luna-paper-promotion-gate -- --json --apply --confirm=luna-paper-promotion-gate-shadow --market=all --limit=500 --symbols=BTC/USDT,NEG/USDT,ALPHA/USDT,MISS/USDT',
  ]) {
    assert.equal(planned.plannedCommands.some((cmd) => cmd.includes(expected)), true, `planned command includes targeted symbols: ${expected}`);
  }
  assert.equal(planned.plannedCommands.every((cmd) => !cmd.includes('launchctl') && !cmd.includes('live-fire')), true, 'planned commands avoid protected/live-fire operations');
  const stabilizationTargets = remediationTest.backtestTargetSymbols([
    {
      symbol: 'UNREAL/USDT',
      market: 'crypto',
      primaryBlocker: 'backtest_unstable_or_unrealistic',
      recommendedAction: 'stabilize_backtest_shadow',
      reasons: ['backtest_unstable_or_unrealistic'],
    },
  ], 12, new Map([['UNREAL/USDT|crypto', 'candidate_cooldown_shadow']]));
  assert.deepEqual(stabilizationTargets, ['UNREAL/USDT'], 'stabilization bypasses old cooldown for revalidation');
  const stabilizationCooldownTargets = remediationTest.backtestTargetSymbols([
    {
      symbol: 'UNREAL/USDT',
      market: 'crypto',
      primaryBlocker: 'backtest_unstable_or_unrealistic',
      recommendedAction: 'stabilize_backtest_shadow',
      reasons: ['backtest_unstable_or_unrealistic'],
    },
  ], 12, new Map([['UNREAL/USDT|crypto', 'backtest_stabilization_shadow']]));
  assert.deepEqual(stabilizationCooldownTargets, [], 'recent stabilization cooldown blocks repeated revalidation');
  assert.deepEqual(remediationTest.backtestCooldownBlockedRows([
    {
      symbol: 'UNREAL/USDT',
      market: 'crypto',
      primaryBlocker: 'backtest_unstable_or_unrealistic',
      recommendedAction: 'stabilize_backtest_shadow',
      reasons: ['backtest_unstable_or_unrealistic'],
    },
  ], [{
    key: 'UNREAL/USDT|crypto',
    symbol: 'UNREAL/USDT',
    market: 'crypto',
    governanceAction: 'backtest_stabilization_shadow',
    cooldownUntil: '2099-01-01T00:00:00.000Z',
  }]), [{
    symbol: 'UNREAL/USDT',
    market: 'crypto',
    primaryBlocker: 'backtest_unstable_or_unrealistic',
    recommendedAction: 'stabilize_backtest_shadow',
    cooldownAction: 'backtest_stabilization_shadow',
    cooldownUntil: '2099-01-01T00:00:00.000Z',
  }], 'cooldown-blocked backtest rows are visible');
  assert.equal(remediationTest.shouldUseStabilityBacktestPeriods([{
    symbol: 'UNREAL/USDT',
    market: 'crypto',
    primaryBlocker: 'backtest_unstable_or_unrealistic',
    recommendedAction: 'stabilize_backtest_shadow',
    reasons: ['backtest_unstable_or_unrealistic'],
  }]), true, 'stabilization expands walk-forward periods');

  const capped = await runLunaCandidateQualityRemediation({
    fixture: true,
    dryRun: true,
    json: true,
    market: 'all',
    limit: 12,
    maxPredictiveSymbols: 2,
    maxStrategySymbols: 1,
    maxShadowSymbols: 2,
  });
  assert.deepEqual(capped.targetedSymbols.predictiveSymbols, ['NEG/USDT', 'ALPHA/USDT'], 'predictive symbol cap is enforced');
  assert.deepEqual(capped.targetedSymbols.strategySymbols, ['NEG/USDT'], 'strategy symbol cap is enforced');
  assert.deepEqual(capped.targetedSymbols.bottleneckSymbols, ['BTC/USDT', 'NEG/USDT'], 'shadow feedback symbol cap is enforced');
  assert.equal(capped.plannedCommands.some((cmd) => cmd.includes('runtime:luna-weight-vector-shadow') && cmd.includes('--symbols=BTC/USDT,NEG/USDT')), true, 'shadow downstream commands use capped symbols');

  return {
    ok: true,
    smoke: 'luna-candidate-quality-remediation',
    checks: {
      planOnly: true,
      confirmGuard: true,
      applyDryRunRejected: true,
      plannedCommands: planned.plannedCommands.length,
      fullShadowLoop: true,
      qualityGovernance: true,
      symbolTargeted: true,
      stabilizationCooldownBypass: true,
      cooldownVisibility: true,
      symbolCaps: true,
      liveMutation: false,
    },
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: runLunaCandidateQualityRemediationSmoke,
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'luna-candidate-quality-remediation-smoke error:',
  });
}
