#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildOpsSchedulerPlan,
  classifyOpsSchedulerOutcome,
  getProcessStartMarker,
  getOpsSchedulerJobs,
  resolveAgentPlanArg,
  resolveOnlyJobArg,
  runOpsScheduler,
  seedOpsSchedulerState,
} from './runtime-luna-ops-scheduler.ts';
import { shouldSkipPreScreen } from './pre-market-screen.ts';

export async function runLunaOpsSchedulerSmoke() {
  const jobs = getOpsSchedulerJobs();
  const launchdPlist = fs.readFileSync(new URL('../launchd/ai.luna.ops-scheduler.plist', import.meta.url), 'utf8');
  assert.match(launchdPlist, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
  assert.equal(jobs.length, 59);
  const majorDrift = jobs.find((job) => job.name === 'binance_major20_market_cap_drift');
  assert.equal(majorDrift?.category, 'report');
  assert.deepEqual(majorDrift?.cadence, { type: 'weekly', day: 1, hour: 9, minute: 20 });
  assert.equal(majorDrift?.args?.includes('--json'), true);
  assert.equal(majorDrift?.args?.includes('--apply'), false);
  assert.equal(majorDrift?.args?.includes('--confirm'), false);
  assert.equal(jobs.some((job) => job.name === 'market_regime_llm_shadow'), true);
  assert.equal(jobs.find((job) => job.name === 'market_regime_llm_shadow')?.category, 'market_state');
  assert.equal(jobs.find((job) => job.name === 'market_regime_llm_shadow')?.cadence?.seconds, 3600);
  assert.equal(jobs.find((job) => job.name === 'market_regime_llm_shadow')?.args?.includes('--confirm=luna-regime-llm-shadow'), true);
  assert.equal(jobs.some((job) => job.name === 'dynamic_policy_operator'), true);
  assert.equal(jobs.find((job) => job.name === 'dynamic_policy_operator')?.args?.includes('--confirm=luna-dynamic-policy-autotune'), true);
  assert.equal(jobs.some((job) => job.name === 'discovery_candidate_refresh'), true);
  assert.equal(jobs.find((job) => job.name === 'discovery_candidate_refresh')?.market, 'crypto');
  assert.equal(jobs.find((job) => job.name === 'discovery_candidate_refresh')?.args?.includes('--markets=crypto'), true);
  assert.equal(jobs.find((job) => job.name === 'discovery_candidate_refresh')?.args?.includes('--limit=30'), true);
  assert.equal(jobs.find((job) => job.name === 'discovery_candidate_refresh')?.args?.includes('--ttl-hours=6'), true);
  assert.equal(jobs.some((job) => job.name === 'pre_market_screen_domestic'), true);
  assert.equal(jobs.some((job) => job.name === 'pre_market_screen_overseas'), true);
  assert.equal(jobs.some((job) => job.name === 'pre_market_analysis_refresh_domestic'), true);
  assert.equal(jobs.some((job) => job.name === 'pre_market_analysis_refresh_overseas'), true);
  assert.equal(jobs.find((job) => job.name === 'pre_market_screen_domestic')?.cadence?.type, 'daily');
  assert.equal(jobs.find((job) => job.name === 'pre_market_screen_overseas')?.cadence?.type, 'daily');
  assert.equal(jobs.find((job) => job.name === 'pre_market_analysis_refresh_domestic')?.requiresMarketOpen, undefined);
  assert.equal(jobs.find((job) => job.name === 'pre_market_analysis_refresh_domestic')?.args?.includes('--max-symbols=5'), true);
  assert.equal(jobs.find((job) => job.name === 'pre_market_analysis_refresh_domestic')?.args?.includes('--max-enrichment-symbols=2'), true);
  assert.equal(jobs.find((job) => job.name === 'pre_market_analysis_refresh_overseas')?.requiresMarketOpen, undefined);
  assert.equal(jobs.find((job) => job.name === 'pre_market_analysis_refresh_overseas')?.args?.includes('--max-symbols=5'), true);
  assert.equal(jobs.find((job) => job.name === 'pre_market_analysis_refresh_overseas')?.args?.includes('--max-enrichment-symbols=2'), true);
  assert.equal(shouldSkipPreScreen({ isOpen: true }), true);
  assert.equal(shouldSkipPreScreen({ isOpen: false, isWeekend: false, holiday: { isHoliday: false } }), false);
  const weeklyJob = [{
    name: 'weekly_fixture',
    cadence: { type: 'weekly', day: 1, hour: 9, minute: 20 },
    command: process.execPath,
    args: [],
  }];
  assert.equal(buildOpsSchedulerPlan({
    now: new Date('2026-07-20T09:19:00+09:00'),
    state: { jobs: {} },
    jobs: weeklyJob,
  }).due, 0);
  assert.equal(buildOpsSchedulerPlan({
    now: new Date('2026-07-20T09:20:00+09:00'),
    state: { jobs: {} },
    jobs: weeklyJob,
  }).due, 1);
  assert.equal(buildOpsSchedulerPlan({
    now: new Date('2026-07-20T12:00:00+09:00'),
    state: { jobs: { weekly_fixture: { lastRunAt: '2026-07-20T09:20:00+09:00' } } },
    jobs: weeklyJob,
  }).due, 0);
  assert.equal(buildOpsSchedulerPlan({
    now: new Date('2026-07-27T09:20:00+09:00'),
    state: { jobs: { weekly_fixture: { lastRunAt: '2026-07-20T09:20:00+09:00' } } },
    jobs: weeklyJob,
  }).due, 1);
  assert.equal(jobs.some((job) => job.name === 'market_cycle_crypto'), true);
  assert.equal(jobs.find((job) => job.name === 'market_cycle_crypto')?.timeoutMs, 600_000);
  assert.equal(jobs.find((job) => job.name === 'candidate_quality_remediation_shadow_loop')?.timeoutMs, 900_000);
  assert.ok(
    jobs.findIndex((job) => job.name === 'approved_signal_executor_crypto')
      < jobs.findIndex((job) => job.name === 'candidate_quality_remediation_shadow_loop'),
    'live approved-signal execution must not wait behind long shadow batches',
  );
  assert.equal(jobs.some((job) => job.name === 'active_entry_trigger_evaluator_crypto'), true);
  assert.equal(jobs.find((job) => job.name === 'active_entry_trigger_evaluator_crypto')?.cadence?.seconds, 60);
  assert.equal(jobs.find((job) => job.name === 'active_entry_trigger_evaluator_crypto')?.args?.includes('--derive-market-events'), true);
  assert.equal(jobs.some((job) => job.name === 'active_entry_trigger_evaluator_domestic'), true);
  assert.equal(jobs.find((job) => job.name === 'active_entry_trigger_evaluator_domestic')?.requiresMarketOpen, true);
  assert.equal(jobs.find((job) => job.name === 'active_entry_trigger_evaluator_domestic')?.cadence?.seconds, 60);
  assert.equal(jobs.find((job) => job.name === 'active_entry_trigger_evaluator_domestic')?.args?.includes('--exchange=kis'), true);
  assert.equal(jobs.find((job) => job.name === 'active_entry_trigger_evaluator_domestic')?.args?.includes('--derive-market-events'), true);
  assert.equal(jobs.some((job) => job.name === 'active_entry_trigger_evaluator_overseas'), true);
  assert.equal(jobs.find((job) => job.name === 'active_entry_trigger_evaluator_overseas')?.requiresMarketOpen, true);
  assert.equal(jobs.find((job) => job.name === 'active_entry_trigger_evaluator_overseas')?.cadence?.seconds, 60);
  assert.equal(jobs.find((job) => job.name === 'active_entry_trigger_evaluator_overseas')?.args?.includes('--exchange=kis_overseas'), true);
  assert.equal(jobs.find((job) => job.name === 'active_entry_trigger_evaluator_overseas')?.args?.includes('--derive-market-events'), true);
  assert.equal(jobs.some((job) => job.name === 'entry_llm_shadow'), true);
  assert.equal(jobs.find((job) => job.name === 'entry_llm_shadow')?.category, 'decision_shadow');
  assert.equal(jobs.find((job) => job.name === 'entry_llm_shadow')?.cadence?.seconds, 600);
  assert.equal(jobs.find((job) => job.name === 'entry_llm_shadow')?.args?.includes('--confirm=luna-entry-llm-shadow'), true);
  assert.equal(jobs.find((job) => job.name === 'entry_llm_shadow')?.args?.includes('--max-llm-calls=3'), true);
  assert.equal(jobs.find((job) => job.name === 'entry_llm_shadow')?.args?.includes('--exchanges=binance,kis,kis_overseas'), true);
  assert.equal(jobs.some((job) => job.name === 'predictive_evidence_refresh_all'), true);
  assert.equal(jobs.find((job) => job.name === 'predictive_evidence_refresh_all')?.category, 'evidence_shadow');
  assert.equal(jobs.find((job) => job.name === 'predictive_evidence_refresh_all')?.args?.includes('--confirm=luna-predictive-evidence-refresh'), true);
  assert.equal(jobs.some((job) => job.name === 'candidate_bottleneck_diagnostics_shadow'), true);
  assert.equal(jobs.find((job) => job.name === 'candidate_bottleneck_diagnostics_shadow')?.args?.includes('--confirm=luna-candidate-bottleneck-shadow'), true);
  assert.equal(jobs.some((job) => job.name === 'weight_vector_shadow_refresh'), true);
  assert.equal(jobs.find((job) => job.name === 'weight_vector_shadow_refresh')?.category, 'decision_shadow');
  assert.equal(jobs.find((job) => job.name === 'weight_vector_shadow_refresh')?.args?.includes('--confirm=luna-weight-vector-shadow'), true);
  assert.equal(jobs.some((job) => job.name === 'paper_trading_shadow_refresh'), true);
  assert.equal(jobs.find((job) => job.name === 'paper_trading_shadow_refresh')?.category, 'paper_shadow');
  assert.equal(jobs.find((job) => job.name === 'paper_trading_shadow_refresh')?.args?.includes('--confirm=luna-paper-trading-shadow'), true);
  assert.equal(jobs.some((job) => job.name === 'paper_promotion_gate_shadow_refresh'), true);
  assert.equal(jobs.find((job) => job.name === 'paper_promotion_gate_shadow_refresh')?.category, 'promotion_shadow');
  assert.equal(jobs.find((job) => job.name === 'paper_promotion_gate_shadow_refresh')?.args?.includes('--confirm=luna-paper-promotion-gate-shadow'), true);
  assert.equal(jobs.find((job) => job.name === 'paper_promotion_gate_shadow_refresh')?.args?.includes('--hours=168'), true);
  assert.equal(jobs.some((job) => job.name === 'promotion_entry_trigger_coverage_all'), true);
  assert.equal(jobs.find((job) => job.name === 'promotion_entry_trigger_coverage_all')?.category, 'promotion_shadow_readonly');
  assert.equal(jobs.find((job) => job.name === 'promotion_entry_trigger_coverage_all')?.cadence?.seconds, 600);
  assert.equal(jobs.find((job) => job.name === 'promotion_entry_trigger_coverage_all')?.args?.includes('--market=all'), true);
  assert.equal(jobs.find((job) => job.name === 'promotion_entry_trigger_coverage_all')?.args?.includes('--exchange=all'), true);
  assert.equal(jobs.some((job) => job.name === 'promotion_entry_trigger_bridge_shadow'), true);
  assert.equal(jobs.find((job) => job.name === 'promotion_entry_trigger_bridge_shadow')?.category, 'promotion_shadow');
  assert.equal(jobs.find((job) => job.name === 'promotion_entry_trigger_bridge_shadow')?.cadence?.seconds, 600);
  assert.equal(jobs.find((job) => job.name === 'promotion_entry_trigger_bridge_shadow')?.args?.includes('--confirm=luna-promotion-entry-trigger-bridge-shadow'), true);
  assert.equal(jobs.find((job) => job.name === 'promotion_entry_trigger_bridge_shadow')?.args?.includes('--market=all'), true);
  assert.equal(jobs.find((job) => job.name === 'promotion_entry_trigger_bridge_shadow')?.args?.includes('--exchange=all'), true);
  assert.equal(jobs.some((job) => job.name === 'promotion_entry_trigger_materialize_shadow'), true);
  assert.equal(jobs.find((job) => job.name === 'promotion_entry_trigger_materialize_shadow')?.category, 'promotion_shadow');
  assert.equal(jobs.find((job) => job.name === 'promotion_entry_trigger_materialize_shadow')?.cadence?.seconds, 600);
  assert.equal(jobs.find((job) => job.name === 'promotion_entry_trigger_materialize_shadow')?.args?.includes('--apply'), true);
  assert.equal(jobs.find((job) => job.name === 'promotion_entry_trigger_materialize_shadow')?.args?.includes('--confirm=luna-promotion-entry-trigger-materialize-active'), true);
  assert.equal(jobs.find((job) => job.name === 'promotion_entry_trigger_materialize_shadow')?.args?.includes('--market=all'), true);
  assert.equal(jobs.find((job) => job.name === 'promotion_entry_trigger_materialize_shadow')?.args?.includes('--exchange=all'), true);
  assert.equal(jobs.some((job) => job.name === 'promotion_readiness_assist_shadow'), true);
  assert.equal(jobs.find((job) => job.name === 'promotion_readiness_assist_shadow')?.category, 'promotion_shadow');
  assert.equal(jobs.find((job) => job.name === 'promotion_readiness_assist_shadow')?.cadence?.seconds, 3600);
  assert.equal(jobs.find((job) => job.name === 'promotion_readiness_assist_shadow')?.args?.includes('--confirm=luna-promotion-readiness-assist-shadow'), true);
  assert.equal(jobs.find((job) => job.name === 'promotion_readiness_assist_shadow')?.args?.includes('--max-targets=8'), true);
  assert.equal(jobs.some((job) => job.name === 'candidate_quality_remediation_shadow_loop'), true);
  assert.equal(jobs.find((job) => job.name === 'candidate_quality_remediation_shadow_loop')?.category, 'quality_remediation_shadow');
  assert.equal(jobs.find((job) => job.name === 'candidate_quality_remediation_shadow_loop')?.cadence?.seconds, 3600);
  assert.equal(jobs.find((job) => job.name === 'candidate_quality_remediation_shadow_loop')?.args?.includes('--confirm=luna-candidate-quality-remediation-shadow'), true);
  assert.equal(jobs.find((job) => job.name === 'candidate_quality_remediation_shadow_loop')?.args?.includes('--market=all'), true);
  assert.equal(jobs.find((job) => job.name === 'candidate_quality_remediation_shadow_loop')?.args?.includes('--max-backtest-symbols=8'), true);
  assert.equal(jobs.some((job) => job.name === 'dynamic_tpsl_shadow_refresh'), true);
  assert.equal(jobs.find((job) => job.name === 'dynamic_tpsl_shadow_refresh')?.category, 'risk_shadow');
  assert.equal(jobs.find((job) => job.name === 'dynamic_tpsl_shadow_refresh')?.args?.includes('--confirm=luna-dynamic-tpsl-shadow'), true);
  assert.equal(jobs.find((job) => job.name === 'dynamic_tpsl_shadow_refresh')?.args?.includes('--max-llm-calls=0'), true);
  assert.equal(jobs.some((job) => job.name === 'factor_model_shadow_refresh'), true);
  assert.equal(jobs.find((job) => job.name === 'factor_model_shadow_refresh')?.category, 'strategy_shadow');
  assert.equal(jobs.find((job) => job.name === 'factor_model_shadow_refresh')?.args?.includes('--confirm=luna-factor-model-shadow'), true);
  assert.equal(jobs.some((job) => job.name === 'stat_arb_shadow_refresh'), true);
  assert.equal(jobs.find((job) => job.name === 'stat_arb_shadow_refresh')?.args?.includes('--confirm=luna-stat-arb-shadow'), true);
  assert.equal(jobs.find((job) => job.name === 'stat_arb_shadow_refresh')?.args?.includes('--strategy=all'), true);
  assert.equal(jobs.some((job) => job.name === 'rl_policy_shadow_refresh'), true);
  assert.equal(jobs.find((job) => job.name === 'rl_policy_shadow_refresh')?.category, 'neural_shadow');
  assert.equal(jobs.find((job) => job.name === 'rl_policy_shadow_refresh')?.args?.includes('--max-inference-calls=0'), true);
  assert.equal(jobs.some((job) => job.name === 'meta_reflexion_shadow_refresh'), true);
  assert.equal(jobs.find((job) => job.name === 'meta_reflexion_shadow_refresh')?.category, 'neural_shadow');
  assert.equal(jobs.find((job) => job.name === 'meta_reflexion_shadow_refresh')?.args?.includes('--confirm=luna-meta-reflexion-shadow'), true);
  assert.equal(jobs.find((job) => job.name === 'meta_reflexion_shadow_refresh')?.args?.includes('--max-llm-calls=0'), true);
  assert.equal(jobs.some((job) => job.name === 'risk_simulation_shadow_refresh'), true);
  assert.equal(jobs.find((job) => job.name === 'risk_simulation_shadow_refresh')?.args?.includes('--simulations=500'), true);
  assert.equal(jobs.some((job) => job.name === 'posttrade_mutation_shadow_refresh'), true);
  assert.equal(jobs.find((job) => job.name === 'posttrade_mutation_shadow_refresh')?.args?.includes('--confirm=luna-phase3-posttrade-mutation'), true);
  assert.equal(jobs.some((job) => job.name === 'deployment_consistency_shadow_refresh'), true);
  assert.equal(jobs.find((job) => job.name === 'deployment_consistency_shadow_refresh')?.args?.includes('--confirm=luna-deployment-consistency-shadow'), true);
  assert.equal(jobs.some((job) => job.name === 'live_forward_validation_shadow_refresh'), true);
  assert.equal(jobs.find((job) => job.name === 'live_forward_validation_shadow_refresh')?.args?.includes('--confirm=luna-phase4-live-forward-shadow'), true);
  assert.equal(jobs.find((job) => job.name === 'live_forward_validation_shadow_refresh')?.args?.includes('--max-llm-calls=0'), true);
  assert.equal(jobs.some((job) => job.name === 'strategy_enhancement_shadow_refresh'), true);
  assert.equal(jobs.find((job) => job.name === 'strategy_enhancement_shadow_refresh')?.args?.includes('--confirm=luna-phase4-strategy-enhancement-shadow'), true);
  assert.equal(jobs.some((job) => job.name === 'phase5_codex_p3_shadow_refresh'), true);
  assert.equal(jobs.find((job) => job.name === 'phase5_codex_p3_shadow_refresh')?.args?.includes('--confirm=luna-phase5-codex-p3-shadow'), true);
  assert.equal(jobs.find((job) => job.name === 'phase5_codex_p3_shadow_refresh')?.args?.includes('--task=all'), true);
  assert.equal(jobs.some((job) => job.name === 'tradingview_open_position_subscription_sync'), true);
  assert.equal(jobs.find((job) => job.name === 'tradingview_open_position_subscription_sync')?.category, 'position_monitor');
  assert.equal(jobs.find((job) => job.name === 'tradingview_open_position_subscription_sync')?.cadence?.seconds, 300);
  assert.equal(jobs.find((job) => job.name === 'tradingview_open_position_subscription_sync')?.args?.includes('--confirm=luna-tradingview-position-subscription-sync'), true);
  assert.equal(jobs.find((job) => job.name === 'tradingview_open_position_subscription_sync')?.args?.includes('--timeframes=60,240,D'), true);
  assert.equal(jobs.some((job) => job.name === 'approved_signal_executor_crypto'), true);
  assert.equal(jobs.find((job) => job.name === 'approved_signal_executor_crypto')?.category, 'execution');
  assert.equal(jobs.find((job) => job.name === 'approved_signal_executor_crypto')?.cadence?.seconds, 60);
  assert.equal(jobs.find((job) => job.name === 'approved_signal_executor_crypto')?.env?.PAPER_MODE, 'false');
  assert.equal(jobs.find((job) => job.name === 'approved_signal_executor_crypto')?.env?.INVESTMENT_TRADE_MODE, 'normal');
  assert.equal(jobs.some((job) => job.name === 'market_cycle_domestic'), true);
  assert.equal(jobs.some((job) => job.name === 'market_cycle_domestic_open_catchup'), true);
  assert.equal(jobs.some((job) => job.name === 'market_cycle_overseas'), true);
  assert.equal(jobs.find((job) => job.name === 'market_cycle_domestic')?.requiresMarketOpen, true);
  assert.equal(jobs.find((job) => job.name === 'market_cycle_domestic_open_catchup')?.requiresMarketOpen, true);
  assert.equal(jobs.find((job) => job.name === 'market_cycle_overseas')?.requiresMarketOpen, true);
  const jaenongRouteShadow = jobs.find((job) => job.name === 'jaenong_route_shadow_overseas');
  assert.equal(jaenongRouteShadow?.category, 'decision_shadow');
  assert.equal(jaenongRouteShadow?.market, 'overseas');
  assert.equal(jaenongRouteShadow?.requiresMarketOpen, true);
  assert.equal(jaenongRouteShadow?.cadence?.seconds, 1800);
  assert.equal(jaenongRouteShadow?.args?.includes('--write'), true);
  assert.equal(jaenongRouteShadow?.args?.includes('--confirm=jaenong-route-shadow'), true);
  assert.equal(jaenongRouteShadow?.args?.includes('--fixture'), false);
  assert.equal(jobs.some((job) => job.name === 'discovery_funnel_report'), true);
  assert.equal(jobs.some((job) => job.name === 'active_candidate_analysis_refresh_crypto'), true);
  assert.equal(jobs.some((job) => job.name === 'active_candidate_analysis_refresh_domestic'), true);
  assert.equal(jobs.some((job) => job.name === 'active_candidate_analysis_refresh_overseas'), true);
  assert.equal(jobs.find((job) => job.name === 'active_candidate_analysis_refresh_crypto')?.cadence?.seconds, 1800);
  assert.equal(jobs.find((job) => job.name === 'active_candidate_analysis_refresh_crypto')?.args?.includes('--max-symbols=2'), true);
  assert.equal(jobs.find((job) => job.name === 'active_candidate_analysis_refresh_domestic')?.requiresMarketOpen, true);
  assert.equal(jobs.find((job) => job.name === 'active_candidate_analysis_refresh_domestic')?.allowPreMarketRefresh, true);
  assert.equal(jobs.find((job) => job.name === 'active_candidate_analysis_refresh_domestic')?.preMarketWindowMinutes, 240);
  assert.equal(jobs.find((job) => job.name === 'active_candidate_analysis_refresh_overseas')?.requiresMarketOpen, true);
  assert.equal(jobs.find((job) => job.name === 'active_candidate_analysis_refresh_overseas')?.allowPreMarketRefresh, true);
  assert.equal(jobs.find((job) => job.name === 'active_candidate_analysis_refresh_overseas')?.preMarketWindowMinutes, 1080);
  assert.equal(jobs.some((job) => job.name === 'near_miss_watchlist_crypto'), true);
  assert.equal(jobs.some((job) => job.name === 'near_miss_watchlist_domestic'), true);
  assert.equal(jobs.some((job) => job.name === 'near_miss_watchlist_overseas'), true);
  assert.equal(jobs.find((job) => job.name === 'near_miss_watchlist_crypto')?.cadence?.seconds, 1800);
  assert.equal(jobs.some((job) => job.name === 'relaxed_probe_l13_crypto'), true);
  assert.equal(jobs.find((job) => job.name === 'relaxed_probe_l13_crypto')?.cadence?.seconds, 900);
  assert.equal(jobs.find((job) => job.name === 'relaxed_probe_l13_crypto')?.args?.includes('--confirm=luna-relaxed-probe-runner'), true);
  assert.equal(jobs.find((job) => job.name === 'relaxed_probe_l13_crypto')?.args?.includes('--max-symbols=1'), true);
  assert.equal(jobs.some((job) => job.name === 'relaxed_probe_l13_domestic'), true);
  assert.equal(jobs.find((job) => job.name === 'relaxed_probe_l13_domestic')?.requiresMarketOpen, true);
  assert.equal(jobs.find((job) => job.name === 'relaxed_probe_l13_domestic')?.cadence?.seconds, 900);
  assert.equal(jobs.find((job) => job.name === 'relaxed_probe_l13_domestic')?.args?.includes('--market=domestic'), true);
  assert.equal(jobs.some((job) => job.name === 'relaxed_probe_l13_overseas'), true);
  assert.equal(jobs.find((job) => job.name === 'relaxed_probe_l13_overseas')?.requiresMarketOpen, true);
  assert.equal(jobs.find((job) => job.name === 'relaxed_probe_l13_overseas')?.cadence?.seconds, 900);
  assert.equal(jobs.find((job) => job.name === 'relaxed_probe_l13_overseas')?.args?.includes('--market=overseas'), true);
  assert.equal(jobs.find((job) => job.name === 'near_miss_watchlist_domestic')?.requiresMarketOpen, true);
  assert.equal(jobs.find((job) => job.name === 'near_miss_watchlist_overseas')?.requiresMarketOpen, true);
  assert.equal(jobs.find((job) => job.name === 'market_cycle_domestic')?.env?.LUNA_LIVE_DOMESTIC, 'true');
  assert.equal(jobs.find((job) => job.name === 'market_cycle_domestic_open_catchup')?.env?.LUNA_LIVE_DOMESTIC, 'true');
  assert.equal(jobs.find((job) => job.name === 'market_cycle_overseas')?.env?.LUNA_LIVE_OVERSEAS, 'true');
  assert.equal(jobs.some((job) => job.name === 'external_evidence_gap_queue_worker'), true);
  assert.equal(jobs.find((job) => job.name === 'external_evidence_gap_queue_worker')?.args?.includes('--confirm=evidence-gap-queue'), true);
  assert.equal(jobs.find((job) => job.name === 'external_evidence_gap_queue_worker')?.cadence?.seconds, 300);
  assert.equal(jobs.some((job) => job.name === 'external_evidence_gap_backtest_worker'), true);
  assert.equal(jobs.find((job) => job.name === 'external_evidence_gap_backtest_worker')?.args?.includes('--include-backtest'), true);
  assert.equal(jobs.find((job) => job.name === 'external_evidence_gap_backtest_worker')?.cadence?.seconds, 3600);

  const now = new Date('2026-05-04T02:00:00+09:00');
  const emptyPlan = buildOpsSchedulerPlan({ now, state: { jobs: {} }, jobs });
  assert.equal(emptyPlan.due, 42);
  assert.equal(emptyPlan.jobs.find((job) => job.name === 'market_cycle_domestic')?.due, false);
  assert.equal(emptyPlan.jobs.find((job) => job.name === 'market_cycle_domestic')?.marketSession?.isOpen, false);
  assert.equal(emptyPlan.jobs.find((job) => job.name === 'market_cycle_domestic_open_catchup')?.due, false);
  assert.equal(emptyPlan.jobs.find((job) => job.name === 'market_cycle_overseas')?.due, false);
  assert.equal(emptyPlan.jobs.find((job) => job.name === 'active_candidate_analysis_refresh_domestic')?.due, false);
  assert.equal(emptyPlan.jobs.find((job) => job.name === 'active_candidate_analysis_refresh_domestic')?.marketSession?.isOpen, false);

  const domesticPreOpenPlan = buildOpsSchedulerPlan({
    now: new Date('2026-05-04T06:30:00+09:00'),
    state: { jobs: {} },
    jobs,
    onlyJob: 'active_candidate_analysis_refresh_domestic',
  });
  assert.equal(domesticPreOpenPlan.due, 1);
  assert.equal(domesticPreOpenPlan.jobs[0]?.marketSession?.isOpen, false);
  assert.equal(domesticPreOpenPlan.jobs[0]?.preMarketWindow?.active, true);
  assert.equal(domesticPreOpenPlan.jobs[0]?.preMarketWindow?.reasonCode, 'pre_market_refresh_window');

  const overseasPreOpenPlan = buildOpsSchedulerPlan({
    now: new Date('2026-05-04T12:00:00+09:00'),
    state: { jobs: {} },
    jobs,
    onlyJob: 'active_candidate_analysis_refresh_overseas',
  });
  assert.equal(overseasPreOpenPlan.due, 1);
  assert.equal(overseasPreOpenPlan.jobs[0]?.marketSession?.isOpen, false);
  assert.equal(overseasPreOpenPlan.jobs[0]?.preMarketWindow?.active, true);

  const overseasCyclePreOpenPlan = buildOpsSchedulerPlan({
    now: new Date('2026-05-04T12:00:00+09:00'),
    state: { jobs: {} },
    jobs,
    onlyJob: 'market_cycle_overseas',
  });
  assert.equal(overseasCyclePreOpenPlan.due, 0);

  const routeAtDailyBrief = buildOpsSchedulerPlan({
    now: new Date('2026-07-16T21:00:00+09:00'),
    state: { jobs: {} },
    jobs,
    onlyJob: 'jaenong_route_shadow_overseas',
  });
  assert.equal(routeAtDailyBrief.due, 0, 'the 21:00 daily brief must not race the overseas route shadow');

  const routeBeforeDstOpen = buildOpsSchedulerPlan({
    now: new Date('2026-07-16T22:29:00+09:00'),
    state: { jobs: {} },
    jobs,
    onlyJob: 'jaenong_route_shadow_overseas',
  });
  const routeAtDstOpen = buildOpsSchedulerPlan({
    now: new Date('2026-07-16T22:30:00+09:00'),
    state: { jobs: {} },
    jobs,
    onlyJob: 'jaenong_route_shadow_overseas',
  });
  assert.equal(routeBeforeDstOpen.due, 0);
  assert.equal(routeAtDstOpen.due, 1, 'DST open must be recognized at 22:30 KST');

  const routeBeforeStandardOpen = buildOpsSchedulerPlan({
    now: new Date('2026-01-05T23:29:00+09:00'),
    state: { jobs: {} },
    jobs,
    onlyJob: 'jaenong_route_shadow_overseas',
  });
  const routeAtStandardOpen = buildOpsSchedulerPlan({
    now: new Date('2026-01-05T23:30:00+09:00'),
    state: { jobs: {} },
    jobs,
    onlyJob: 'jaenong_route_shadow_overseas',
  });
  assert.equal(routeBeforeStandardOpen.due, 0);
  assert.equal(routeAtStandardOpen.due, 1, 'standard-time open must be recognized at 23:30 KST');

  const recentState = {
    jobs: Object.fromEntries(jobs.map((job) => [job.name, { lastRunAt: now.toISOString() }])),
  };
  const recentPlan = buildOpsSchedulerPlan({ now, state: recentState, jobs });
  assert.equal(recentPlan.due, 0);

  const forced = buildOpsSchedulerPlan({ now, state: recentState, jobs, onlyJob: 'guardrails_hourly', force: true });
  assert.equal(forced.total, 1);
  assert.equal(forced.due, 1);
  assert.equal(resolveOnlyJobArg(['--only-job=market_cycle_crypto']), 'market_cycle_crypto');
  assert.equal(resolveOnlyJobArg(['--job=market_cycle_domestic']), 'market_cycle_domestic');
  assert.deepEqual(resolveAgentPlanArg(['--agent-plan-json={"disabledCategories":["report"]}']), { disabledCategories: ['report'] });

  const agentControlledPlan = buildOpsSchedulerPlan({
    now,
    state: { jobs: {} },
    jobs,
    agentPlan: {
      disabledCategories: ['report', 'learning'],
      disabledMarkets: ['domestic'],
      disabledJobs: ['market_cycle_crypto'],
      cadenceOverrides: {
        market_cycle_crypto: 10,
        active_candidate_analysis_refresh_crypto: 120,
      },
    },
  });
  const agentJobNames = agentControlledPlan.jobs.map((job) => job.name);
  assert.equal(agentJobNames.includes('market_cycle_crypto'), true);
  assert.equal(agentJobNames.includes('market_cycle_domestic'), true);
  assert.equal(agentJobNames.includes('active_candidate_analysis_refresh_domestic'), false);
  assert.equal(agentJobNames.includes('near_miss_watchlist_domestic'), false);
  assert.equal(agentJobNames.includes('active_candidate_analysis_refresh_overseas'), true);
  assert.equal(agentJobNames.includes('near_miss_watchlist_overseas'), true);
  assert.equal(agentJobNames.includes('discovery_funnel_report'), false);
  assert.equal(agentJobNames.includes('voyager_skill_acceleration'), false);
  assert.equal(agentControlledPlan.agentPlan.warnings.includes('immutable_scheduler_job:market_cycle_crypto'), true);
  assert.equal(agentControlledPlan.agentPlan.warnings.includes('immutable_scheduler_job:market_cycle_domestic'), true);
  assert.equal(agentControlledPlan.agentPlan.warnings.includes('cadence_override_clamped:market_cycle_crypto'), true);
  assert.equal(agentControlledPlan.jobs.find((job) => job.name === 'market_cycle_crypto')?.cadence?.seconds, 60);
  assert.equal(agentControlledPlan.jobs.find((job) => job.name === 'active_candidate_analysis_refresh_crypto')?.cadence?.seconds, 120);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-ops-scheduler-'));
  const statePath = path.join(tmp, 'state.json');
  const lockPath = path.join(tmp, 'lock.json');
  const calls = [];
  const envByJob = {};
  const executed = await runOpsScheduler({
    now,
    statePath,
    lockPath,
    jobs,
    runner: (job) => {
      calls.push(job.name);
      envByJob[job.name] = job.env || {};
      if (job.name === 'market_cycle_domestic') {
        return { ok: true, status: 0, stdoutTail: '⏭️ 장외 시간 (KST 08:50) — 연구 모드 전환', stderrTail: '' };
      }
      return { ok: true, status: 0, stdoutTail: 'ok', stderrTail: '' };
    },
  });
  assert.equal(executed.ok, true);
  assert.equal(calls.length, 42);
  assert.equal(calls.includes('promotion_entry_trigger_coverage_all'), true);
  assert.equal(calls.includes('promotion_entry_trigger_bridge_shadow'), true);
  assert.equal(calls.includes('promotion_entry_trigger_materialize_shadow'), true);
  assert.equal(calls.includes('market_cycle_domestic'), false);
  assert.equal(calls.includes('market_cycle_domestic_open_catchup'), false);
  assert.equal(calls.includes('market_cycle_overseas'), false);
  assert.equal(calls.includes('active_entry_trigger_evaluator_domestic'), false);
  assert.equal(calls.includes('active_entry_trigger_evaluator_overseas'), false);
  const executedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(Object.keys(executedState.jobs).length, 42);

  assert.deepEqual(
    classifyOpsSchedulerOutcome(
      { name: 'market_cycle_domestic' },
      { ok: true, stdoutTail: '최종 결과: 0개 신호 승인', stderrTail: '' },
    ),
    { outcome: 'no_signals', summary: 'approved_signals=0', approvedSignals: 0 },
  );
  assert.deepEqual(
    classifyOpsSchedulerOutcome(
      { name: 'active_entry_trigger_evaluator_crypto' },
      {
        ok: true,
        stdoutTail: JSON.stringify({
          ok: true,
          result: { checked: 2, fired: 0, readyBlocked: 0, allowLiveFire: true },
        }),
      },
    ),
    {
      outcome: 'entry_trigger_checked',
      summary: 'checked=2 fired=0 readyBlocked=0 allowLiveFire=true',
      approvedSignals: null,
    },
  );
  assert.deepEqual(
    classifyOpsSchedulerOutcome(
      { name: 'approved_signal_executor_crypto' },
      {
        ok: true,
        stdoutTail: '[헤파이스토스] 실행대상 복구 1건 (pending=0, approved=1, trade_mode=normal)',
      },
    ),
    {
      outcome: 'approved_signal_execution_attempted',
      summary: 'approved_signal_candidates=1',
      approvedSignals: 1,
    },
  );
  assert.equal(
    classifyOpsSchedulerOutcome(
      { name: 'market_cycle_domestic_open_catchup' },
      { ok: true, stdoutTail: '⏭️ 국내장 open-catchup: 장외 시간 (KST 08:55) — live cycle 대기', stderrTail: '' },
    ).outcome,
    'market_closed_catchup_wait',
  );

  assert.equal(
    classifyOpsSchedulerOutcome(
      { name: 'discovery_candidate_refresh' },
      { ok: true, stdoutTail: '[discovery-orchestrator] 완료 — 성공 2/3, 총 2개 신호', stderrTail: '' },
    ).outcome,
    'discovery_refreshed',
  );

  const seedPath = path.join(tmp, 'seeded-state.json');
  const seeded = seedOpsSchedulerState({ now, statePath: seedPath, jobs });
  assert.equal(seeded.ok, true);
  const seededPlan = buildOpsSchedulerPlan({
    now,
    jobs,
    state: JSON.parse(fs.readFileSync(seedPath, 'utf8')),
  });
  assert.equal(seededPlan.due, 0);

  fs.writeFileSync(lockPath, JSON.stringify({ lockedAt: now.toISOString(), pid: process.pid }));
  const locked = await runOpsScheduler({ now, statePath, lockPath, jobs });
  assert.equal(locked.ok, false);
  assert.equal(locked.status, 'locked');
  fs.rmSync(lockPath, { force: true });

  fs.writeFileSync(lockPath, JSON.stringify({
    lockedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    pid: process.pid,
    token: 'old-but-live-owner',
    processStartMarker: getProcessStartMarker(process.pid),
  }));
  const oldLiveLocked = await runOpsScheduler({ now, statePath, lockPath, jobs: [] });
  assert.equal(oldLiveLocked.ok, false, 'a live owner must keep the lock regardless of lock age');
  assert.equal(oldLiveLocked.status, 'locked');
  fs.rmSync(lockPath, { force: true });

  fs.writeFileSync(lockPath, JSON.stringify({
    lockedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    pid: process.pid,
    token: 'legacy-stale-live-pid',
  }));
  const legacyStaleRecovered = await runOpsScheduler({ now, statePath, lockPath, jobs: [], runner: () => ({ ok: true }) });
  assert.equal(legacyStaleRecovered.ok, true, 'an old markerless lock must not deadlock after PID reuse');
  fs.rmSync(lockPath, { force: true });

  fs.writeFileSync(lockPath, JSON.stringify({
    lockedAt: now.toISOString(),
    pid: process.pid,
    token: 'pid-reuse-fixture',
    processStartMarker: 'not-the-current-process-start',
  }));
  const reusedPidRecovered = await runOpsScheduler({ now, statePath, lockPath, jobs: [], runner: () => ({ ok: true }) });
  assert.equal(reusedPidRecovered.ok, true, 'a reused PID must not keep a stale scheduler lock forever');
  fs.rmSync(lockPath, { force: true });

  fs.writeFileSync(lockPath, JSON.stringify({ lockedAt: now.toISOString(), pid: 999999 }));
  const staleRecovered = await runOpsScheduler({ now, statePath, lockPath, jobs: [], runner: () => ({ ok: true }) });
  assert.equal(staleRecovered.ok, true);
  assert.equal(staleRecovered.status, 'executed');
  fs.rmSync(lockPath, { force: true });

  const concurrentLockPath = path.join(tmp, 'concurrent-lock.json');
  const concurrentStatePath = path.join(tmp, 'concurrent-state.json');
  let signalFirstStarted;
  let releaseFirstRunner;
  const firstStarted = new Promise((resolve) => { signalFirstStarted = resolve; });
  const firstExecutionPromise = runOpsScheduler({
    now,
    force: true,
    statePath: concurrentStatePath,
    lockPath: concurrentLockPath,
    jobs: [{
      name: 'concurrent_lease_fixture',
      cadence: { type: 'interval', seconds: 1 },
      command: process.execPath,
      args: [],
    }],
    runner: async () => {
      signalFirstStarted();
      await new Promise((resolve) => { releaseFirstRunner = resolve; });
      return { ok: true, status: 0 };
    },
  });
  await firstStarted;
  const concurrentBlocked = await runOpsScheduler({
    now,
    statePath: concurrentStatePath,
    lockPath: concurrentLockPath,
    jobs: [],
    runner: () => ({ ok: true }),
  });
  assert.equal(concurrentBlocked.ok, false, 'kernel lease must reject a concurrent scheduler');
  assert.equal(concurrentBlocked.status, 'lock_contention');
  releaseFirstRunner();
  const firstExecution = await firstExecutionPromise;
  assert.equal(firstExecution.ok, true);
  fs.rmSync(concurrentLockPath, { force: true });

  const envEchoScript = path.join(tmp, 'echo-env.js');
  fs.writeFileSync(
    envEchoScript,
    `console.log(JSON.stringify({ overseas: process.env.LUNA_LIVE_OVERSEAS || null }));\n`,
    'utf8',
  );
  const envStatePath = path.join(tmp, 'env-state.json');
  const envLockPath = path.join(tmp, 'env-lock.json');
  const envExecution = await runOpsScheduler({
    now,
    statePath: envStatePath,
    lockPath: envLockPath,
    jobs: [{
      name: 'market_cycle_overseas',
      cadence: { type: 'interval', seconds: 1 },
      command: process.execPath,
      args: [envEchoScript],
      env: { LUNA_LIVE_OVERSEAS: 'true' },
    }],
  });
  assert.equal(envExecution.ok, true);
  assert.match(envExecution.executed[0]?.stdoutTail || '', /"overseas":"true"/);

  const failedStatePath = path.join(tmp, 'failed-state.json');
  const failedLockPath = path.join(tmp, 'failed-lock.json');
  const failedExecution = await runOpsScheduler({
    now,
    statePath: failedStatePath,
    lockPath: failedLockPath,
    jobs: [{
      name: 'bounded_failure_job',
      cadence: { type: 'interval', seconds: 300 },
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
    }],
    runner: () => ({ ok: false, status: 1, error: 'fixture_failure' }),
  });
  assert.equal(failedExecution.ok, false);
  const failedState = JSON.parse(fs.readFileSync(failedStatePath, 'utf8'));
  assert.equal(failedState.jobs.bounded_failure_job.lastStatus, 'failed');
  assert.equal(failedState.jobs.bounded_failure_job.lastOutcome, 'command_failed');
  assert.equal(failedState.jobs.bounded_failure_job.totalRuns, 1);
  assert.equal(failedState.jobs.bounded_failure_job.totalFailures, 1);
  assert.equal(failedState.jobs.bounded_failure_job.consecutiveFailures, 1);
  assert.ok(failedState.jobs.bounded_failure_job.lastFailureAt);
  assert.equal(
    buildOpsSchedulerPlan({
      now: new Date(now.getTime() + 60_000),
      state: failedState,
      jobs: [{
        name: 'bounded_failure_job',
        cadence: { type: 'interval', seconds: 300 },
        command: process.execPath,
        args: ['-e', 'process.exit(1)'],
      }],
    }).due,
    0,
  );

  const closedStatePath = path.join(tmp, 'closed-market-state.json');
  const closedLockPath = path.join(tmp, 'closed-market-lock.json');
  const previousOpenRunAt = '2026-07-01T01:00:00.000Z';
  fs.writeFileSync(closedStatePath, JSON.stringify({
    jobs: {
      market_cycle_domestic: {
        lastRunAt: previousOpenRunAt,
        lastOpenRunAt: previousOpenRunAt,
        lastOutcome: 'no_signals',
      },
    },
  }));
  await runOpsScheduler({
    now,
    force: true,
    statePath: closedStatePath,
    lockPath: closedLockPath,
    jobs: [{
      name: 'market_cycle_domestic',
      category: 'market_cycle',
      market: 'domestic',
      cadence: { type: 'interval', seconds: 1 },
      command: process.execPath,
      args: [],
    }],
    runner: () => ({ ok: true, status: 0, outcome: 'market_closed_skip' }),
  });
  const closedState = JSON.parse(fs.readFileSync(closedStatePath, 'utf8'));
  assert.equal(closedState.jobs.market_cycle_domestic.lastOpenRunAt, previousOpenRunAt);
  assert.notEqual(closedState.jobs.market_cycle_domestic.lastRunAt, previousOpenRunAt);
  await runOpsScheduler({
    now,
    force: true,
    statePath: closedStatePath,
    lockPath: closedLockPath,
    jobs: [{
      name: 'market_cycle_domestic',
      category: 'market_cycle',
      market: 'domestic',
      cadence: { type: 'interval', seconds: 1 },
      command: process.execPath,
      args: [],
    }],
    runner: () => ({ ok: true, status: 0, outcome: 'no_signals' }),
  });
  const reopenedState = JSON.parse(fs.readFileSync(closedStatePath, 'utf8'));
  assert.notEqual(reopenedState.jobs.market_cycle_domestic.lastOpenRunAt, previousOpenRunAt);
  assert.equal(
    reopenedState.jobs.market_cycle_domestic.lastOpenRunAt,
    reopenedState.jobs.market_cycle_domestic.lastRunAt,
  );

  assert.equal(
    classifyOpsSchedulerOutcome(
      { name: 'market_cycle_overseas' },
      { ok: true, stdoutTail: '[overseas] LIVE OFF — 사이클 스킵 (LUNA_LIVE_OVERSEAS 미설정)', stderrTail: '' },
    ).outcome,
    'kill_switch_off',
  );
  assert.equal(
    classifyOpsSchedulerOutcome(
      { name: 'slow_job' },
      { ok: false, error: 'spawnSync ETIMEDOUT', signal: 'SIGTERM', stderrTail: '' },
    ).outcome,
    'command_timeout',
  );

  const timeoutFinalizerCalls = [];
  const timeoutStatePath = path.join(tmp, 'timeout-state.json');
  const timeoutLockPath = path.join(tmp, 'timeout-lock.json');
  const timeoutExecution = await runOpsScheduler({
    now,
    statePath: timeoutStatePath,
    lockPath: timeoutLockPath,
    jobs: [{
      name: 'timeout_fixture',
      cadence: { type: 'interval', seconds: 1 },
      command: process.execPath,
      args: [],
    }],
    runner: (job) => ({
      ok: false,
      status: null,
      signal: 'SIGTERM',
      error: 'spawnSync ETIMEDOUT',
      schedulerRunToken: job.env?.LUNA_SCHEDULER_RUN_TOKEN,
    }),
    timeoutFinalizer: async (token, context) => {
      timeoutFinalizerCalls.push({ token, context });
      return { pipelineRuns: 1, nodeRuns: 2 };
    },
  });
  assert.equal(timeoutExecution.ok, false);
  assert.equal(timeoutFinalizerCalls.length, 1, 'timeout must terminalize only the correlated pipeline run');
  assert.ok(timeoutFinalizerCalls[0].token, 'scheduler must propagate a unique run token');
  assert.equal(timeoutFinalizerCalls[0].context.jobName, 'timeout_fixture');

  const fencedLockPath = path.join(tmp, 'fenced-lock.json');
  const fencedStatePath = path.join(tmp, 'fenced-state.json');
  const fencedExecution = await runOpsScheduler({
    now,
    statePath: fencedStatePath,
    lockPath: fencedLockPath,
    jobs: [{
      name: 'fenced_release_fixture',
      cadence: { type: 'interval', seconds: 1 },
      command: process.execPath,
      args: [],
    }],
    runner: () => {
      fs.writeFileSync(fencedLockPath, JSON.stringify({
        pid: process.pid,
        token: 'replacement-owner',
        lockedAt: now.toISOString(),
      }));
      return { ok: true, status: 0 };
    },
  });
  assert.equal(fencedExecution.ok, true);
  assert.equal(fs.existsSync(fencedLockPath), true, 'an old owner must not release a replacement owner lock');
  assert.equal(JSON.parse(fs.readFileSync(fencedLockPath, 'utf8')).token, 'replacement-owner');
  fs.rmSync(fencedLockPath, { force: true });

  return {
    ok: true,
    jobs: jobs.map((job) => job.name),
    emptyDue: emptyPlan.due,
    forcedDue: forced.due,
    executed: calls.length,
    seededDue: seededPlan.due,
    locked: locked.status,
    oldLiveLocked: oldLiveLocked.status,
    legacyStaleRecovered: legacyStaleRecovered.ok,
    reusedPidRecovered: reusedPidRecovered.ok,
    staleRecovered: staleRecovered.ok,
  };
}

async function main() {
  const result = await runLunaOpsSchedulerSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`luna-ops-scheduler-smoke ok jobs=${result.jobs.length}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ luna-ops-scheduler-smoke 실패:' });
}
