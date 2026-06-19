#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export const LUNA_COMPONENT_REGISTRY_SEED = Object.freeze([
  { component: 'phase-a-prediction-15min', currentMode: 'shadow', targetMode: 'advisory_router_bias', criteria: { minSamples: 200, metrics: ['accuracy', 'brier_calibration'] }, notes: 'promotion-gate active; C12' },
  { component: 'hmm-regime', currentMode: 'shadow', targetMode: 'core_c2', criteria: { metrics: ['regime_strategy_delta', 'heuristic_outperformance'] }, notes: 'P1 core dependency' },
  { component: 'ml-price-predictor', currentMode: 'env_off', targetMode: 'shadow', criteria: { minIc: 0, lookaheadIntegrity: true }, notes: 'C12 unification target' },
  { component: 'fundamental-quant', currentMode: 'shadow', targetMode: 'llm_aux_score_input', criteria: { metrics: ['selection_ablation_contribution'] }, notes: 'C6 blend' },
  { component: 'earnings-surprise', currentMode: 'shadow', targetMode: 'event_trigger_input', criteria: { metrics: ['post_event_return_contribution'] }, notes: 'C11/M-6' },
  { component: 'disclosure-event', currentMode: 'shadow', targetMode: 'watchlist_alert', criteria: { metrics: ['disclosure_to_price_reaction_accuracy'] }, notes: 'M-6' },
  { component: 'korean-factor-model-shadow', currentMode: 'shadow', targetMode: 'c5_score_input', criteria: { metrics: ['factor_ic', 'point_in_time_integrity'] }, notes: 'LG-01/QuantaAlpha' },
  { component: 'rl-policy-shadow', currentMode: 'shadow', targetMode: 'supervised_l4', criteria: { minTrades: 30, virtualExpectancyDeltaPositive: true, maxDrawdownNonWorse: true }, notes: 'C13 deterministic overlay' },
  { component: 'stat-arb-shadow', currentMode: 'shadow', targetMode: 'supervised_l4', criteria: { expectedValuePositive: true, wfPermutationPMax: 0.05 }, notes: 'C3 candidate' },
  { component: 'strategy-router-phase-a-influence', currentMode: 'diagnostic', targetMode: 'shadow_bias', criteria: { metrics: ['routing_performance_delta'] }, notes: 'bias path 0.25 -> 0.5' },
  { component: 'intelligent-discovery', currentMode: 'shadow', targetMode: 'advisory_hard_gate', criteria: { metrics: ['discovery_candidate_accuracy'] }, notes: 'G3' },
  { component: 'dynamic-tpsl-shadow-judge', currentMode: 'shadow', targetMode: 'c3_exit_rule_assist', criteria: { metrics: ['dynamic_trail_delta'] }, notes: 'compare with dynamic-trail' },
  { component: 'entry-llm-shadow-judge', currentMode: 'shadow', targetMode: 'g6_reviewer_or_retire', criteria: { metrics: ['ablation_contribution'] }, notes: 'E-3' },
  { component: 'position-lifecycle', currentMode: 'shadow', targetMode: 'supervised_l4', criteria: { metrics: ['lifecycle_action_accuracy'] }, notes: 'standard path prototype' },
  { component: 'posttrade-feedback', currentMode: 'shadow', targetMode: 'supervised_l4', criteria: { metrics: ['post_feedback_expectancy_improvement'] }, notes: 'C8' },
  { component: 'signal-outcome-feedback', currentMode: 'shadow', targetMode: 'supervised_l4', criteria: { durationWeeks: 4, minSamplesPerFamilyRegime: 30, positiveExpectancyRequired: true, evidence: 'luna_strategy_signal_outcomes' }, notes: 'C8 strategy-family shadow signal outcome feedback by family and regime' },
  { component: 'signal-outcome-eval-runner', currentMode: 'advisory', targetMode: 'daily_shadow_feedback', criteria: { appendOnly: true, tradeJournalUnmodified: true, evidence: 'luna_strategy_signal_outcomes' }, notes: 'C8 daily evaluator for unfilled strategy signals; no live trading or parameter mutation' },
  { component: 'candidate-backtest-entry-gate', currentMode: 'advisory', targetMode: 'enforce', criteria: { dsrMin: 0.9, minTrades: 30 }, notes: 'C7 gate' },
  { component: 'dsr-pbo-gate', currentMode: 'advisory', targetMode: 'enforce', criteria: { blockedCounterfactualUnderperforms: true }, notes: 'C7' },
  { component: 'robust-backtest-selection', currentMode: 'off', targetMode: 'on', criteria: { metrics: ['oos_consensus_parameter_superiority'] }, notes: 'P0-2' },
  { component: 'llm-auto-routing-hub', currentMode: 'shadow_pending', targetMode: 'active', criteria: { metrics: ['task_model_performance_tracking'] }, notes: 'M-8 Week2' },
  { component: 'shadow-mode-symbol-decision-wrapper', currentMode: 'live_parallel_logging', targetMode: 'stage_a_foundation', criteria: { infrastructure: true }, notes: 'G0-G7 shadow scaffold' },
  { component: 'market-deployment-gate', currentMode: 'shadow', targetMode: 'supervised_l4', criteria: { durationWeeks: 4, compareAgainst: 'gate_off_virtual', metrics: ['halt_reduced_avoidance_delta'], placeholder: true }, notes: 'P1-2 C1 market deployment gate shadow history' },
  { component: 'regime-engine-hmm', currentMode: 'shadow', targetMode: 'core_c2', criteria: { durationWeeks: 4, metrics: ['brier_hmm_lt_fallback', 'transition_alert_precision'], placeholder: true }, notes: 'P1-3 C2 HMM regime engine shadow facade and calibration' },
  { component: 'strategy-family-turtle', currentMode: 'shadow', targetMode: 'supervised_l4', criteria: { durationWeeks: 4, minSignalsPerFamily: 30, virtualExpectancyDeltaPositive: true, evidence: 'luna_strategy_signals' }, notes: 'P1-4 C3 turtle breakout deterministic shadow rule' },
  { component: 'strategy-family-testah', currentMode: 'shadow', targetMode: 'supervised_l4', criteria: { durationWeeks: 4, minSignalsPerFamily: 30, virtualExpectancyDeltaPositive: true, evidence: 'luna_strategy_signals' }, notes: 'P1-4 C3 Testah pullback deterministic shadow rule' },
  { component: 'regime-expansion-shadow-sim', currentMode: 'shadow', targetMode: 'advisory', criteria: { durationWeeks: 4, bearExcluded: true, matchedUnchanged: true, evidence: 'luna_strategy_signals.details.regimeExpansionGain' }, notes: 'C2/C3 regime allow-list expansion would-have simulation; observes sideways/volatile relief without changing actual matched' },
  { component: 'entry-trigger-shadow-link', currentMode: 'shadow', targetMode: 'advisory', criteria: { durationWeeks: 4, firedAlwaysZero: true, liveFireEnabledForcedFalse: true, evidence: 'entry_triggers' }, notes: 'ET-A strategy-family to entry-trigger shadow adapter; observe whole engine before ET-B extraction' },
  { component: 'entry-preflight-gate', currentMode: 'shadow', targetMode: 'supervised_l4', criteria: { durationWeeks: 4, blockedSignalsUnderperformPassedSignals: true, evidence: 'luna_entry_preflight_log' }, notes: 'P1-5 C4 R:R/expectancy/sideways/liquidity preflight shadow gate' },
  { component: 'loss-circuit', currentMode: 'shadow', targetMode: 'supervised_l4', criteria: { durationWeeks: 4, lockedSignalsUnderperformUnlockedSignals: true, evidence: 'luna_circuit_locks' }, notes: 'P1-5 C4 StoplossGuard/cooldown/low-profit shadow circuit' },
  { component: 'backtest-nextbar-execution', currentMode: 'shadow', targetMode: 'advisory', criteria: { durationWeeks: 4, compareAgainst: 'same_bar_close', metrics: ['nextbar_return_delta', 'nextbar_trade_count_delta'], placeholder: true }, notes: 'P1-6 C7 next-bar execution shadow comparison' },
  { component: 'meeting-room-orchestrator', currentMode: 'shadow', targetMode: 'advisory', criteria: { durationWeeks: 4, completedMeetings: 10, grillCoverage: true, decisionTracking: true, placeholder: true }, notes: 'MR-A CLI meeting-room orchestrator advisory/shadow backend' },
  { component: 'broker-abstraction', currentMode: 'shadow', targetMode: 'advisory_router', criteria: { durationWeeks: 4, readOnly: true, executionDisabled: true, metrics: ['route_decision_coverage'] }, notes: 'TOSS-B BrokerAdapter abstraction with Toss/KIS read-only adapters' },
  { component: 'toss-data-source', currentMode: 'shadow', targetMode: 'primary_data_source_candidate', criteria: { durationWeeks: 4, readOnly: true, metrics: ['availability', 'latency', 'fallback_rate'] }, notes: 'TOSS-B Toss Open API data source candidate for mid/long horizon stocks' },
  { component: 'securities-warning-gate', currentMode: 'shadow', targetMode: 'advisory_gate', criteria: { durationWeeks: 4, readOnly: true, blockedSignalsUnderperformPassedSignals: true, evidence: 'luna_entry_preflight_log.gates' }, notes: 'TOSS-C C14 Toss securities-warning shadow gate' },
  { component: 'preflight-cross-check', currentMode: 'shadow', targetMode: 'advisory_preflight_evidence', criteria: { durationWeeks: 4, readOnly: true, metrics: ['cross_check_attempt_rate', 'mismatch_rate'], evidence: 'luna_entry_preflight_log.gates' }, notes: 'TOSS-C C4 Toss buying-power/sellable/commission read-only cross-check' },
  { component: 'promotion-stage', currentMode: 'shadow', targetMode: 'paper_mirror_then_master_review', criteria: { durationWeeks: 4, readOnly: true, s2RequiresMasterApproval: true, evidence: 'luna_toss_paper_mirror_log' }, notes: 'TOSS-D S0/S1/S2/S3 promotion stage guard; S2+ forced back to S0 without live+approval' },
  { component: 'toss-paper-mirror', currentMode: 'shadow', targetMode: 's1_paper_mirror', criteria: { durationWeeks: 4, minSamples: 30, placedAlwaysFalseBeforeTossE: true, evidence: 'luna_toss_paper_mirror_log' }, notes: 'TOSS-D S1 paper-mirror read-only preflight verification and balance shadow comparison' },
  { component: 'alpha-factor-discovery', currentMode: 'shadow', targetMode: 'c12_alpha_research_input', criteria: { durationWeeks: 4, minIc: 0.03, minRankIr: 0.5, minSampleDays: 60, permutationPMax: 0.01, pointInTimeIntegrity: true, evidence: 'luna_alpha_factors' }, notes: 'WS-R C12 QuantaAlpha-style alpha factor discovery shadow loop' },
  { component: 'universe-snapshot-accumulator', currentMode: 'shadow', targetMode: 'point_in_time_backtest_input', criteria: { durationWeeks: 4, appendOnly: true, pointInTimeIntegrity: true, evidence: 'universe_snapshot' }, notes: 'C7-1 daily candidate_universe point-in-time snapshot accumulator; backtest as-of wiring is future scope' },
  { component: 'vault-shadow-eval-adjustments', currentMode: 'shadow', targetMode: 'parameter_store_input', criteria: { metrics: ['adjustment_post_validation_pass_rate'] }, notes: 'Sigma vault' },
  { component: 'meta-neural-reflexion', currentMode: 'shadow', targetMode: 'c8_learning_layer', criteria: { metrics: ['accepted_reflexion_outcome'] }, notes: 'small sample discipline' },
  { component: 'mapek', currentMode: 'env', targetMode: 'autonomous_loop_frame', criteria: { placeholder: true }, notes: '0-b loop fit review' },
]);

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function normalizeSeedRow(row: any) {
  return {
    component: row.component,
    currentMode: row.currentMode,
    targetMode: row.targetMode,
    promotionCriteria: row.criteria || { placeholder: true },
    notes: row.notes || '',
  };
}

export async function seedLunaComponentRegistry(options: any = {}, deps: any = {}) {
  const dryRun = options.dryRun === true;
  const rows = LUNA_COMPONENT_REGISTRY_SEED.map(normalizeSeedRow);
  if (!dryRun) {
    const runFn = deps.runFn || db.run;
    for (const row of rows) {
      await runFn(
        `INSERT INTO luna_component_registry
           (component, current_mode, target_mode, promotion_criteria, status, notes)
         VALUES ($1, $2, $3, $4::jsonb, 'active', $5)
         ON CONFLICT (component) DO UPDATE SET
           current_mode = EXCLUDED.current_mode,
           target_mode = EXCLUDED.target_mode,
           promotion_criteria = EXCLUDED.promotion_criteria,
           notes = EXCLUDED.notes`,
        [
          row.component,
          row.currentMode,
          row.targetMode,
          JSON.stringify(row.promotionCriteria),
          row.notes,
        ]
      );
    }
  }
  return {
    ok: true,
    dryRun,
    seeded: rows.length,
    components: rows.map((row) => row.component),
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => seedLunaComponentRegistry({ dryRun: hasFlag('dry-run') }),
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: '❌ luna-registry-seed 실패:',
  });
}
