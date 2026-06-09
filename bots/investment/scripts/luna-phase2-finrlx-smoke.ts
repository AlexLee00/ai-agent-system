#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildLunaPaperTradingPlan,
  buildLunaWeightVector,
  evaluateNoLookaheadContract,
} from '../shared/luna-weight-vector.ts';
import { runLunaWeightVectorShadow } from './runtime-luna-weight-vector-shadow.ts';
import { runLunaPaperTradingShadow } from './runtime-luna-paper-trading-shadow.ts';
import { runLunaPaperPromotionGateShadow } from './runtime-luna-paper-promotion-gate.ts';
import { evaluateLunaPaperPromotionHistory } from '../shared/luna-paper-promotion-gate.ts';

const now = new Date('2026-05-14T00:00:00.000Z').toISOString();
const future = new Date('2026-05-14T00:10:00.000Z').toISOString();

const pass = buildLunaWeightVector({
  asOf: now,
  candidate: { symbol: 'BTC/USDT', market: 'crypto', score: 0.9, discovered_at: now },
  backtest: { fresh: true, healthy: true, sharpe: 1.1, win_rate: 55, max_drawdown: 10, last_backtest_at: now },
  predictive: { decision: 'pass_prediction', score: 0.8, created_at: now },
  community: { avg_score: 0.4, source_count: 3, last_seen_at: now },
}, { riskBudgetUsdt: 50 });
assert.equal(pass.ok, true);
assert.equal(pass.noLookaheadOk, true);
assert.ok(['increase', 'watch'].includes(pass.signal));
assert.ok(pass.targetWeight > 0);
assert.equal(pass.shadowOnly, true);

const leak = buildLunaWeightVector({
  asOf: now,
  candidate: { symbol: 'LEAK/USDT', market: 'crypto', score: 0.9, discovered_at: future },
  backtest: { fresh: true, healthy: true, sharpe: 1, win_rate: 55, max_drawdown: 10, last_backtest_at: now },
  predictive: { decision: 'pass_prediction', score: 0.8, created_at: now },
}, { riskBudgetUsdt: 50 });
assert.equal(leak.noLookaheadOk, false);
assert.equal(leak.signal, 'hold');
assert.equal(leak.targetWeight, 0);
assert.equal(evaluateNoLookaheadContract({ asOf: now, sources: [{ source: 'future', observedAt: future }] }).ok, false);

const drawdownHold = buildLunaWeightVector({
  asOf: now,
  candidate: { symbol: 'DD/USDT', market: 'crypto', score: 0.9, discovered_at: now },
  backtest: { fresh: true, healthy: true, sharpe: 1.4, win_rate: 62, max_drawdown: 42, last_backtest_at: now },
  predictive: { decision: 'pass_prediction', score: 0.82, created_at: now },
  community: { avg_score: 0.48, source_count: 4, last_seen_at: now },
}, { riskBudgetUsdt: 50 });
assert.equal(drawdownHold.signal, 'hold');
assert.equal(drawdownHold.targetWeight, 0);
assert.ok(drawdownHold.evidence.hardReasons.includes('backtest_drawdown_high'));

const bottleneckHold = buildLunaWeightVector({
  asOf: now,
  candidate: { symbol: 'RISK/USDT', market: 'crypto', score: 0.92, discovered_at: now },
  backtest: { fresh: true, healthy: true, sharpe: 1.4, win_rate: 58, max_drawdown: 8, last_backtest_at: now },
  predictive: { decision: 'pass_prediction', score: 0.82, created_at: now },
  community: { avg_score: 0.48, source_count: 4, last_seen_at: now },
  bottleneck: {
    severity: 'blocker',
    recommended_action: 'quarantine_candidate_shadow',
    candidate_selection_penalty: 0.75,
    reasons: ['backtest_unhealthy_or_would_block'],
    observed_at: now,
  },
}, { riskBudgetUsdt: 50 });
assert.equal(bottleneckHold.signal, 'hold');
assert.equal(bottleneckHold.targetWeight, 0);
assert.equal(bottleneckHold.evidence.bottleneck.hardHold, true);
assert.ok(bottleneckHold.evidence.hardReasons.includes('candidate_bottleneck_quarantine'));
assert.equal(bottleneckHold.evidence.qualityActionPlan.primaryAction, 'candidate_bottleneck_remediation_required');
assert.equal(bottleneckHold.evidence.qualityActionPlan.priority, 'p0');
assert.ok(bottleneckHold.evidence.qualityActionPlan.blockedComponents.includes('candidate_bottleneck'));

const strategyQualityHold = buildLunaWeightVector({
  asOf: now,
  candidate: { symbol: 'SQ/USDT', market: 'crypto', score: 0.94, discovered_at: now },
  backtest: { fresh: true, healthy: true, sharpe: 1.5, win_rate: 64, max_drawdown: 9, last_backtest_at: now },
  predictive: { decision: 'pass_prediction', score: 0.84, created_at: now },
  community: { avg_score: 0.52, source_count: 4, last_seen_at: now },
  strategyQuality: {
    enhancement_status: 'shadow_review',
    hyperopt_status: 'planned',
    max_drawdown_guard: 'block_live_forward',
    indicator_score: 0.18,
    reasons: ['max_drawdown_gt_20pct'],
    observed_at: now,
  },
}, { riskBudgetUsdt: 50 });
assert.equal(strategyQualityHold.signal, 'hold');
assert.equal(strategyQualityHold.targetWeight, 0);
assert.equal(strategyQualityHold.evidence.strategyQuality.hardHold, true);
assert.equal(strategyQualityHold.evidence.strategyQuality.operatingState, 'hard_hold');
assert.ok(strategyQualityHold.evidence.hardReasons.includes('strategy_quality_block_live_forward'));
assert.equal(strategyQualityHold.evidence.qualityActionPlan.primaryAction, 'strategy_reformulation_shadow_required');
assert.equal(strategyQualityHold.evidence.qualityActionPlan.priority, 'p0');
assert.ok(strategyQualityHold.evidence.qualityActionPlan.blockedComponents.includes('strategy_quality'));
assert.ok(strategyQualityHold.evidence.qualityActionPlan.nextShadowCommands.some((command) => command.includes('runtime:luna-phase4-strategy-enhancement-shadow')));

const strategyNotReadyHold = buildLunaWeightVector({
  asOf: now,
  candidate: { symbol: 'SNR/USDT', market: 'crypto', score: 0.94, discovered_at: now },
  backtest: { fresh: true, healthy: true, sharpe: 1.5, win_rate: 64, max_drawdown: 9, last_backtest_at: now },
  predictive: { decision: 'pass_prediction', score: 0.84, created_at: now },
  community: { avg_score: 0.52, source_count: 4, last_seen_at: now },
  strategyQuality: {
    enhancement_status: 'shadow_review',
    hyperopt_status: 'shadow_evaluated_blocked',
    max_drawdown_guard: 'tighten_risk',
    indicator_score: 0.33,
    reasons: ['indicator_score_weak'],
    observed_at: now,
  },
}, { riskBudgetUsdt: 50 });
assert.equal(strategyNotReadyHold.signal, 'hold');
assert.equal(strategyNotReadyHold.targetWeight, 0);
assert.equal(strategyNotReadyHold.evidence.strategyQuality.hardHold, true);
assert.equal(strategyNotReadyHold.evidence.strategyQuality.hardHoldReason, 'strategy_quality_not_shadow_ready');
assert.ok(strategyNotReadyHold.evidence.hardReasons.includes('strategy_quality_not_shadow_ready'));

const strategyProbationWatch = buildLunaWeightVector({
  asOf: now,
  candidate: { symbol: 'SPROB/USDT', market: 'crypto', score: 0.94, discovered_at: now },
  backtest: { fresh: true, healthy: true, sharpe: 1.5, win_rate: 64, max_drawdown: 9, last_backtest_at: now },
  predictive: { decision: 'pass_prediction', score: 0.84, created_at: now },
  community: { avg_score: 0.52, source_count: 4, last_seen_at: now },
  strategyQuality: {
    enhancement_status: 'shadow_probation_with_risk_tightening',
    hyperopt_status: 'shadow_probation_evaluated',
    max_drawdown_guard: 'tighten_risk',
    indicator_score: 0.33,
    reasons: ['indicator_near_miss_paper_only_probation'],
    observed_at: now,
  },
}, { riskBudgetUsdt: 50 });
assert.equal(strategyProbationWatch.evidence.strategyQuality.hardHold, false);
assert.equal(strategyProbationWatch.evidence.strategyQuality.hardHoldReason, null);
assert.equal(strategyProbationWatch.evidence.strategyQuality.operatingState, 'paper_probation');
assert.equal(strategyProbationWatch.evidence.strategyQuality.penalty >= 0.35, true);
assert.equal(strategyProbationWatch.evidence.qualityActionPlan.primaryAction, 'paper_probation_shadow_required');
assert.equal(strategyProbationWatch.evidence.qualityActionPlan.priority, 'p2');
assert.ok(['watch', 'increase'].includes(strategyProbationWatch.signal));
assert.ok(strategyProbationWatch.targetWeight > 0);

const strategyRiskMonitor = buildLunaWeightVector({
  asOf: now,
  candidate: { symbol: 'SRM/USDT', market: 'crypto', score: 0.94, discovered_at: now },
  backtest: { fresh: true, healthy: true, sharpe: 1.5, win_rate: 64, max_drawdown: 9, last_backtest_at: now },
  predictive: { decision: 'pass_prediction', score: 0.84, created_at: now },
  community: { avg_score: 0.52, source_count: 4, last_seen_at: now },
  strategyQuality: {
    enhancement_status: 'shadow_ready_with_risk_tightening',
    hyperopt_status: 'shadow_evaluated',
    max_drawdown_guard: 'tighten_risk',
    indicator_score: 0.62,
    reasons: ['macd_watch'],
    observed_at: now,
  },
}, { riskBudgetUsdt: 50 });
assert.equal(strategyRiskMonitor.evidence.strategyQuality.operatingState, 'risk_tightened_monitor');
assert.equal(strategyRiskMonitor.evidence.qualityActionPlan.primaryAction, 'risk_tightened_shadow_monitor');
assert.ok(strategyRiskMonitor.evidence.qualityActionPlan.monitorComponents.includes('strategy_quality_monitor'));

const resolvedPredictiveBottleneck = buildLunaWeightVector({
  asOf: now,
  candidate: { symbol: 'RPB/USDT', market: 'crypto', score: 0.86, discovered_at: now },
  backtest: { fresh: true, healthy: true, sharpe: 1.2, win_rate: 58, max_drawdown: 10, last_backtest_at: now },
  predictive: { decision: 'fire', score: 0.74, component_coverage: 1, created_at: now },
  community: { avg_score: 0.44, source_count: 3, last_seen_at: now },
  bottleneck: {
    severity: 'review',
    recommended_action: 'predictive_refresh',
    candidate_selection_penalty: 0.22,
    reasons: ['predictive_coverage_low'],
    observed_at: now,
  },
}, { riskBudgetUsdt: 50 });
assert.equal(resolvedPredictiveBottleneck.evidence.bottleneck.resolvedByCurrentEvidence, true);
assert.ok(resolvedPredictiveBottleneck.evidence.bottleneck.resolvedReasons.includes('predictive_coverage_low'));
assert.equal(resolvedPredictiveBottleneck.evidence.bottleneck.penalty, 0);
assert.equal(resolvedPredictiveBottleneck.evidence.hardReasons.includes('candidate_bottleneck_predictive_coverage_low'), false);
assert.equal(resolvedPredictiveBottleneck.gateStatus, 'shadow_pass');

const stalePredictiveAt = new Date(Date.parse(now) - 10 * 24 * 3600_000).toISOString();
const unresolvedStalePredictiveBottleneck = buildLunaWeightVector({
  asOf: now,
  candidate: { symbol: 'SPB/USDT', market: 'crypto', score: 0.86, discovered_at: now },
  backtest: { fresh: true, healthy: true, sharpe: 1.2, win_rate: 58, max_drawdown: 10, last_backtest_at: now },
  predictive: { decision: 'fire', score: 0.74, component_coverage: 1, created_at: stalePredictiveAt },
  community: { avg_score: 0.44, source_count: 3, last_seen_at: now },
  bottleneck: {
    severity: 'review',
    recommended_action: 'predictive_refresh',
    candidate_selection_penalty: 0.22,
    reasons: ['predictive_missing_or_stale'],
    observed_at: now,
  },
}, { riskBudgetUsdt: 50, stalePredictiveHours: 24 * 7 });
assert.equal(unresolvedStalePredictiveBottleneck.evidence.bottleneck.resolvedByCurrentEvidence, false);
assert.ok(unresolvedStalePredictiveBottleneck.evidence.bottleneck.reasons.includes('predictive_missing_or_stale'));
assert.equal(unresolvedStalePredictiveBottleneck.evidence.bottleneck.penalty, 0.22);
assert.ok(unresolvedStalePredictiveBottleneck.evidence.hardReasons.includes('candidate_bottleneck_predictive_missing_or_stale'));

const paper = buildLunaPaperTradingPlan(pass, {
  position: { amount: 0, avg_price: 65000 },
  equityUsdt: 1000,
  maxOrderUsdt: 50,
  minNotionalUsdt: 5,
});
assert.equal(paper.shadowOnly, true);
assert.equal(paper.paperSide, 'BUY');
assert.ok(paper.paperNotionalUsdt <= 50);

const unvalidatedBacktest = {
  fresh: true,
  healthy: false,
  sharpe: 1.2,
  win_rate: 58,
  max_drawdown: 12,
  last_backtest_at: now,
  gate_status: 'would_block_no_oos',
  would_block: true,
  block_reasons: ['backtest_no_oos_validation', 'backtest_low_trade_sample(trades=3)'],
};
const shadowPassthroughOff = buildLunaWeightVector({
  asOf: now,
  candidate: { symbol: 'UNOOS/USDT', market: 'crypto', score: 0.93, discovered_at: now },
  backtest: unvalidatedBacktest,
  predictive: { decision: 'pass_prediction', score: 0.84, created_at: now },
  community: { avg_score: 0.52, source_count: 4, last_seen_at: now },
}, { riskBudgetUsdt: 50, env: { LUNA_SHADOW_BACKTEST_UNVALIDATED_PASSTHROUGH: 'false' } });
assert.equal(shadowPassthroughOff.signal, 'hold');
assert.equal(shadowPassthroughOff.shadowUnvalidated, false);

const shadowPassthroughOn = buildLunaWeightVector({
  asOf: now,
  candidate: { symbol: 'UNOOS/USDT', market: 'crypto', score: 0.93, discovered_at: now },
  backtest: unvalidatedBacktest,
  predictive: { decision: 'pass_prediction', score: 0.84, created_at: now },
  community: { avg_score: 0.52, source_count: 4, last_seen_at: now },
}, { riskBudgetUsdt: 50, env: { LUNA_SHADOW_BACKTEST_UNVALIDATED_PASSTHROUGH: 'true' } });
assert.ok(['increase', 'watch'].includes(shadowPassthroughOn.signal));
assert.ok(shadowPassthroughOn.targetWeight > 0);
assert.equal(shadowPassthroughOn.eligible, false);
assert.equal(shadowPassthroughOn.shadowEligible, true);
assert.equal(shadowPassthroughOn.shadowUnvalidated, true);
assert.equal(shadowPassthroughOn.gateStatus, 'shadow_unvalidated');
assert.equal(shadowPassthroughOn.evidence.components.backtest.pass, false);
assert.equal(shadowPassthroughOn.evidence.components.backtest.passForShadow, true);
assert.equal(shadowPassthroughOn.evidence.components.backtest.dataIncomplete, true);

const shadowPaper = buildLunaPaperTradingPlan(shadowPassthroughOn, {
  position: { amount: 0, avg_price: 100 },
  equityUsdt: 1000,
  maxOrderUsdt: 50,
  minNotionalUsdt: 5,
});
assert.equal(shadowPaper.paperSide, 'BUY');
assert.equal(shadowPaper.status, 'planned');
assert.equal(shadowPaper.shadowUnvalidated, true);
assert.equal(shadowPaper.evidence.shadow_unvalidated_passthrough, true);

const genuineBacktestFail = buildLunaWeightVector({
  asOf: now,
  candidate: { symbol: 'GFAIL/USDT', market: 'crypto', score: 0.93, discovered_at: now },
  backtest: {
    ...unvalidatedBacktest,
    block_reasons: ['sharpe_below_promotion_floor'],
    gate_status: 'would_block_unstable_backtest',
  },
  predictive: { decision: 'pass_prediction', score: 0.84, created_at: now },
}, { riskBudgetUsdt: 50, env: { LUNA_SHADOW_BACKTEST_UNVALIDATED_PASSTHROUGH: 'true' } });
assert.equal(genuineBacktestFail.signal, 'hold');
assert.equal(genuineBacktestFail.shadowUnvalidated, false);
assert.equal(genuineBacktestFail.evidence.components.backtest.genuineFail, true);

const promotionRows = Array.from({ length: 3 }, (_, index) => ({
  symbol: 'UNOOS/USDT',
  market: 'crypto',
  exchange: 'binance',
  paper_side: 'BUY',
  paper_notional_usdt: 25,
  confidence: 0.82,
  status: 'planned',
  shadow_only: true,
  shadow_unvalidated: true,
  observed_at: new Date(Date.parse(now) - index * 60_000).toISOString(),
  evidence: {
    shadowUnvalidated: true,
    promotionBacktestQuality: {
      fresh: true,
      healthy: false,
      gateStatus: 'would_block_no_oos',
      wouldBlock: true,
      blockReasons: ['backtest_no_oos_validation', 'backtest_low_trade_sample(trades=3)'],
      fallbackUsed: false,
      vectorbtEnabled: true,
      sharpe: 1.2,
      maxDrawdown: 12,
      winRate: 58,
    },
  },
}));
const promotionShadow = evaluateLunaPaperPromotionHistory(promotionRows, {
  env: { LUNA_SHADOW_BACKTEST_UNVALIDATED_PASSTHROUGH: 'true' },
  minCycles: 3,
  minConsecutivePasses: 3,
  minAvgConfidence: 0.6,
  maxOrderUsdt: 50,
});
assert.equal(promotionShadow.passCount, 3);
assert.equal(promotionShadow.promotionCandidate, false);
assert.equal(promotionShadow.decision, 'shadow_promotion_unvalidated_candidate');
assert.equal(promotionShadow.promotionBlockerClass, 'shadow_unvalidated');
assert.ok(promotionShadow.blockReasons.includes('promotion_requires_validated_backtest'));
assert.equal(promotionShadow.evidence.shadowUnvalidatedPassCount, 3);
assert.equal(promotionShadow.evidence.validatedPassCount, 0);

const weightInserts = [];
const weightRuntime = await runLunaWeightVectorShadow({
  json: true,
  fixture: true,
  dryRun: true,
  apply: false,
  limit: 5,
}, {
  insertWeight: async (row) => weightInserts.push(row),
});
assert.equal(weightRuntime.ok, true);
assert.equal(weightRuntime.writeMode, 'plan-only');
assert.equal(weightRuntime.summary.liveMutation, false);
assert.equal(weightInserts.length, 0);
assert.ok(weightRuntime.summary.total >= 2);
assert.ok(weightRuntime.summary.bottleneckHardHold >= 1);
assert.ok(weightRuntime.summary.strategyQualityHardHold >= 1);
assert.ok(weightRuntime.summary.strategyQualityOperatingStates.hard_hold >= 1);
assert.ok(weightRuntime.summary.strategyQualityOperatingStates.missing >= 1);
assert.ok(weightRuntime.summary.strategyQualityHardHoldSymbols.includes('NEG/USDT'));
assert.ok(weightRuntime.summary.strategyQualityPrimaryFamilies.volatility_adjusted_defensive_retest >= 1);
assert.ok(weightRuntime.summary.strategyQualityRemediationBlockers.strategy_drawdown_gt_20pct >= 1);
assert.ok(weightRuntime.summary.strategyQualityRecommendedActions.exclude_from_live_forward_until_strategy_drawdown_below_20pct >= 1);
assert.ok(weightRuntime.summary.strategyQualityExitCriteria.strategy_drawdown_gt_20pct >= 1);
assert.ok(weightRuntime.summary.strategyQualityExitGaps.some((item) => (
  item.symbol === 'NEG/USDT'
  && item.requiredAction === 'volatility_adjusted_defensive_retest'
)));
assert.ok(weightRuntime.summary.qualityActionPriorities.p0 >= 1);
assert.ok(weightRuntime.summary.qualityActionPrimaryActions.strategy_reformulation_shadow_required >= 1);
assert.ok(weightRuntime.summary.qualityActionBlockedComponents.strategy_quality >= 1);
assert.ok(weightRuntime.summary.qualityActionStrategyReformulationSymbols.includes('NEG/USDT'));
assert.equal(weightRuntime.summary.qualityActionPredictiveRefreshSymbols.includes('NEG/USDT'), false);

const paperInserts = [];
const paperRuntime = await runLunaPaperTradingShadow({
  json: true,
  fixture: true,
  dryRun: true,
  apply: false,
  limit: 5,
}, {
  insertPaper: async (row) => paperInserts.push(row),
});
assert.equal(paperRuntime.ok, true);
assert.equal(paperRuntime.writeMode, 'plan-only');
assert.equal(paperRuntime.summary.liveMutation, false);
assert.equal(paperInserts.length, 0);
assert.ok(paperRuntime.summary.bottleneckHardHold >= 1);
assert.ok(paperRuntime.rows.some((row) => row.evidence?.bottleneckAvoidance?.hardHold === true));

const promotionGateInserts = [];
const promotionGateRuntime = await runLunaPaperPromotionGateShadow({
  json: true,
  fixture: true,
  dryRun: true,
  apply: false,
}, {
  insertGate: async (row) => promotionGateInserts.push(row),
});
assert.equal(promotionGateRuntime.ok, true);
assert.equal(promotionGateRuntime.writeMode, 'plan-only');
assert.equal(promotionGateRuntime.promotionReady, false);
assert.equal(promotionGateInserts.length, 0);
assert.ok(promotionGateRuntime.summary.promotionCandidates >= 1);

const root = path.resolve(import.meta.dirname, '..');
const bootstrap = fs.readFileSync(path.join(root, 'shared/db/schema/tables/bootstrap.ts'), 'utf8');
assert.match(bootstrap, /luna_weight_vector_shadow/);
assert.match(bootstrap, /luna_paper_trading_shadow/);
assert.match(bootstrap, /luna_paper_promotion_gate_shadow/);

const deploy = path.join(root, 'deploy.sh');
const bashCheck = spawnSync('bash', ['-n', deploy], { encoding: 'utf8' });
assert.equal(bashCheck.status, 0, bashCheck.stderr);
const deployBody = fs.readFileSync(deploy, 'utf8');
assert.match(deployBody, /--mode backtest\|paper\|live/);
assert.match(deployBody, /LUNA_PHASE2_LIVE_DEPLOY_ENABLED/);
assert.match(deployBody, /luna-weight-vector-shadow/);

const payload = {
  ok: true,
  smoke: 'luna-phase2-finrlx',
  pass: {
    symbol: pass.symbol,
    signal: pass.signal,
    targetWeight: pass.targetWeight,
    confidence: pass.confidence,
  },
  noLookahead: {
    leakBlocked: leak.signal === 'hold' && leak.noLookaheadOk === false,
    violations: leak.evidence.noLookahead.violations,
  },
  bottleneck: {
    hardHold: bottleneckHold.evidence.bottleneck.hardHold,
    signal: bottleneckHold.signal,
    penalty: bottleneckHold.evidence.bottleneck.penalty,
  },
  strategyQuality: {
    hardHold: strategyQualityHold.evidence.strategyQuality.hardHold,
    signal: strategyQualityHold.signal,
    penalty: strategyQualityHold.evidence.strategyQuality.penalty,
  },
  paper: {
    side: paper.paperSide,
    notional: paper.paperNotionalUsdt,
  },
  runtime: {
    weightWriteMode: weightRuntime.writeMode,
    paperWriteMode: paperRuntime.writeMode,
    promotionGateWriteMode: promotionGateRuntime.writeMode,
    promotionCandidates: promotionGateRuntime.summary.promotionCandidates,
    paperBottleneckHardHold: paperRuntime.summary.bottleneckHardHold,
    paperBottleneckPreventedOrder: paperRuntime.summary.bottleneckPreventedOrder,
    strategyQualityHardHold: weightRuntime.summary.strategyQualityHardHold,
    strategyQualityOperatingStates: weightRuntime.summary.strategyQualityOperatingStates,
  },
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('luna-phase2-finrlx-smoke ok');
}
