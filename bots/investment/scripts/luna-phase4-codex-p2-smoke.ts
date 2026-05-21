#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildLunaPhase4LiveForwardRows,
  buildLunaPhase4StrategyEnhancementRows,
  fixturePhase4Inputs,
} from '../shared/luna-phase4-live-forward.ts';
import { runLunaLiveForwardValidationShadow } from './runtime-luna-live-forward-validation-shadow.ts';
import { runLunaPhase4StrategyEnhancementShadow } from './runtime-luna-phase4-strategy-enhancement-shadow.ts';

function fixtureOhlcv(inputs) {
  return Object.fromEntries((inputs || []).map((input) => {
    const candidate = input.candidate || input;
    return [`${String(candidate.symbol || '').toUpperCase()}|${String(candidate.market || 'crypto').toLowerCase()}`, input.ohlcv || []];
  }));
}

async function expectRejectsApplyDryRun() {
  await assert.rejects(
    () => runLunaLiveForwardValidationShadow({ fixture: true, apply: true, dryRun: true, confirm: 'luna-phase4-live-forward-shadow', json: true }),
    /cannot combine --apply with --dry-run/,
  );
  await assert.rejects(
    () => runLunaPhase4StrategyEnhancementShadow({ fixture: true, apply: true, dryRun: true, confirm: 'luna-phase4-strategy-enhancement-shadow', json: true }),
    /cannot combine --apply with --dry-run/,
  );
}

export async function runLunaPhase4CodexP2Smoke() {
  const inputs = fixturePhase4Inputs();
  const liveRows = buildLunaPhase4LiveForwardRows(inputs);
  const strategyRows = buildLunaPhase4StrategyEnhancementRows(inputs, fixtureOhlcv(inputs));
  const nearMissProbationInput = {
    candidate: { symbol: 'PROB/USDT', market: 'crypto', score: 0.76, source: 'fixture', discovered_at: '2026-05-15T00:00:00.000Z' },
    backtest: { fresh: true, healthy: true, sharpe: 1.25, max_drawdown: 13.4, win_rate: 54, would_block: false },
    predictive: { decision: 'pass_prediction', score: 0.76, component_coverage: 0.82 },
    community: { avg_score: 0.18, source_count: 3, bot_noise_score: 0.08, hype_spike: false },
    ohlcv: [
      100, 100.242, 100.574, 100.348, 101.128, 100.972, 100.919, 100.755, 101.796, 101.013,
      99.741, 99.632, 100.57, 101.628, 100.113, 101.124, 101.036, 100.837, 101.248, 101.181,
      100.8, 100.834, 101.16, 101.656, 100.4, 101.731, 101.689, 101.48, 100.574, 102.054,
      103.358, 102.702, 101.943, 100.68, 102.065, 100.058, 100.185, 99.637, 99.314, 97.283,
      97.844, 97.653, 96.516, 95.104, 95.72, 95.19, 94.749, 93.303, 94.453, 92.925,
      92.163, 92.103, 92.442, 89.679, 90.3, 89.519, 88.333, 89.986, 90.969, 91.511,
    ].map((close) => ({ close, open: close, high: close * 1.002, low: close * 0.998, volume: 100 })),
  };
  const nearMissProbation = buildLunaPhase4StrategyEnhancementRows(
    [nearMissProbationInput],
    fixtureOhlcv([nearMissProbationInput]),
  )[0];

  assert.equal(liveRows.length, 4, 'live-forward fixture row count');
  assert.equal(strategyRows.length, 4, 'strategy fixture row count');
  assert.equal(liveRows.some((row) => row.liveForwardStatus === 'shadow_pass'), true, 'one fixture should pass shadow review');
  assert.equal(liveRows.some((row) => row.liveForwardStatus === 'shadow_hold'), true, 'one fixture should remain hold');
  assert.equal(liveRows.find((row) => row.symbol === 'BNB/USDT')?.liveForwardStatus, 'shadow_pass', 'non-community crypto pre-market evidence should not be blocked by community diversity');
  assert.equal(liveRows.find((row) => row.symbol === 'NVDA')?.liveForwardStatus, 'shadow_pass', 'non-community overseas evidence should not be blocked by crypto community diversity');
  assert.equal(liveRows.find((row) => row.symbol === 'DOGE/USDT')?.reasons.includes('community_source_diversity_low'), true, 'crypto hype fixture still requires community diversity');
  assert.equal(liveRows.every((row) => row.shadowOnly === true && row.liveMutation === false), true, 'live-forward rows are shadow-only');
  assert.equal(liveRows.every((row) => row.evidence?.llmGateway?.directProviderCall === false), true, 'Hub LLM route metadata forbids direct provider');
  assert.equal(strategyRows.some((row) => row.hyperoptStatus === 'shadow_evaluated_blocked'), true, 'weak fixture should evaluate and block unsafe hyperopt');
  assert.equal(strategyRows.some((row) => row.maxDrawdownGuard === 'block_live_forward'), true, 'high drawdown fixture should block live-forward');
  assert.equal(strategyRows.every((row) => row.bestParams?.paperOnlyDays === 7), true, 'strategy params stay paper-first');
  assert.equal(strategyRows.every((row) => row.strategyRemediation?.liveMutation === false), true, 'strategy remediation is shadow-only');
  assert.equal(
    strategyRows.find((row) => row.symbol === 'DOGE/USDT')?.strategyRemediation?.status,
    'remediation_required',
    'blocked strategy should expose remediation status',
  );
  assert.equal(
    strategyRows.find((row) => row.symbol === 'DOGE/USDT')?.strategyRemediation?.blockers.includes('strategy_drawdown_gt_20pct'),
    true,
    'drawdown blocker should be visible in strategy remediation',
  );
  assert.equal(
    strategyRows.find((row) => row.symbol === 'DOGE/USDT')?.strategyRemediation?.watchSignals.includes('macd_histogram_negative'),
    true,
    'indicator watch signals should be separated from hard blockers',
  );
  assert.equal(
    strategyRows.find((row) => row.symbol === 'DOGE/USDT')?.strategyRemediation?.recommendedActions.includes('exclude_from_live_forward_until_strategy_drawdown_below_20pct'),
    true,
    'strategy remediation should expose a concrete next action',
  );
  const blockedFormulationPlan = strategyRows.find((row) => row.symbol === 'DOGE/USDT')?.strategyRemediation?.strategyFormulationPlan;
  assert.equal(blockedFormulationPlan?.mode, 'hard_block_reformulation', 'blocked strategy should expose reformulation mode');
  assert.equal(blockedFormulationPlan?.blockedExperiments.includes('live_forward'), true, 'blocked strategy should keep live-forward forbidden');
  assert.equal(blockedFormulationPlan?.allowedExperiments.length > 0, true, 'blocked strategy should expose next shadow experiments');
  assert.equal(blockedFormulationPlan?.nextShadowCommands.every((cmd) => cmd.includes('--dry-run') && !cmd.includes('--apply')), true, 'strategy formulation commands must stay dry-run');
  assert.equal(nearMissProbation.enhancementStatus, 'shadow_probation_with_risk_tightening', 'near-miss indicator should enter paper-only probation');
  assert.equal(nearMissProbation.hyperoptStatus, 'shadow_probation_evaluated', 'near-miss indicator should not be hard-blocked');
  assert.equal(nearMissProbation.strategyRemediation.status, 'paper_only_probation', 'near-miss remediation should be paper-only probation');
  assert.equal(nearMissProbation.strategyRemediation.blockers.includes('indicator_score_below_unblock_floor'), false, 'near-miss probation removes unblock hard blocker');
  assert.equal(nearMissProbation.strategyRemediation.watchSignals.includes('indicator_score_near_unblock_floor_probation'), true, 'near-miss probation remains observable');
  assert.equal(nearMissProbation.strategyRemediation.strategyFormulationPlan.mode, 'paper_probation_monitor', 'near-miss should expose paper probation formulation mode');
  assert.equal(nearMissProbation.strategyRemediation.strategyFormulationPlan.blockedExperiments.includes('promotion_without_master_approval'), true, 'probation must not allow auto-promotion');
  assert.equal(strategyRows.every((row) => row.shadowOnly === true && row.liveMutation === false), true, 'strategy rows are shadow-only');

  await expectRejectsApplyDryRun();
  const liveRuntime = await runLunaLiveForwardValidationShadow({ fixture: true, dryRun: true, json: true });
  const strategyRuntime = await runLunaPhase4StrategyEnhancementShadow({ fixture: true, dryRun: true, json: true });
  assert.equal(liveRuntime.summary.total, 4, 'live runtime fixture count');
  assert.equal(strategyRuntime.summary.total, 4, 'strategy runtime fixture count');
  assert.equal(liveRuntime.summary.liveMutation, false, 'live runtime no mutation');
  assert.equal(strategyRuntime.summary.liveMutation, false, 'strategy runtime no mutation');
  assert.equal(strategyRuntime.summary.remediationRequired >= 1, true, 'strategy runtime reports remediation-required rows');
  assert.equal(Object.keys(strategyRuntime.summary.remediationTopWatchSignals || {}).length >= 1, true, 'strategy runtime reports watch signals separately');
  assert.equal(strategyRuntime.summary.strategyFormulationModes.hard_block_reformulation >= 1, true, 'strategy runtime reports formulation modes');
  assert.equal(Object.keys(strategyRuntime.summary.strategyFormulationAllowedFamilies || {}).length >= 1, true, 'strategy runtime reports allowed experiment families');
  assert.equal(strategyRuntime.summary.shadowHardReview, strategyRuntime.summary.remediationRequired, 'hard review count should match remediation-required rows');
  assert.equal(strategyRuntime.summary.shadowProbation, strategyRuntime.summary.paperOnlyProbation, 'probation count should be separated from hard review');
  assert.equal(strategyRuntime.summary.shadowMonitor, strategyRuntime.summary.riskTightenedMonitor + strategyRuntime.summary.readyMonitor, 'monitor count should cover non-blocked monitor states');
  assert.equal(strategyRuntime.summary.strategyOperatingStates.remediation_required >= 1, true, 'strategy runtime reports operating states');

  return {
    ok: true,
    smoke: 'luna-phase4-codex-p2',
    checks: {
      liveForwardRows: liveRows.length,
      strategyRows: strategyRows.length,
      shadowPass: liveRows.filter((row) => row.liveForwardStatus === 'shadow_pass').length,
      hyperoptPlanned: strategyRows.filter((row) => row.hyperoptStatus === 'planned').length,
      hyperoptShadowBlocked: strategyRows.filter((row) => row.hyperoptStatus === 'shadow_evaluated_blocked').length,
      maxDrawdownBlocks: strategyRows.filter((row) => row.maxDrawdownGuard === 'block_live_forward').length,
      remediationRequired: strategyRows.filter((row) => row.strategyRemediation?.status === 'remediation_required').length,
      applyDryRunRejected: true,
      liveMutation: false,
    },
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: runLunaPhase4CodexP2Smoke,
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'luna-phase4-codex-p2-smoke error:',
  });
}
