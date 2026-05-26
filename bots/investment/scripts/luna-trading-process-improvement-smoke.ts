#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { summarizeLunaTradingProcessImprovement } from '../shared/luna-trading-process-improvement.ts';
import { runTradingProcessImprovementReport } from './runtime-luna-trading-process-improvement-report.ts';

function findRoadmap(report, id) {
  return (report.roadmap || []).find((item) => item.id === id);
}

export async function runSmoke() {
  const report = await runTradingProcessImprovementReport({ smoke: true, noWrite: true, json: true });
  assert.equal(report.ok, true);
  assert.equal(report.status, 'process_improvement_required');
  assert.equal(report.readOnly, true);
  assert.equal(report.liveTradeImpact, false);
  assert.ok(findRoadmap(report, 'exit_dual_horizon_labels'));
  assert.ok(findRoadmap(report, 'exit_peak_reversal_probability'));
  assert.ok(findRoadmap(report, 'exit_early_loss_recheck_gate'));
  assert.ok(findRoadmap(report, 'symbol_exit_policy_matrix_materialize'));
  assert.ok(findRoadmap(report, 'deterministic_exit_policy_before_llm_override'));
  assert.ok(findRoadmap(report, 'strategy_bias_promotion_ready_shadow'));
  assert.ok(findRoadmap(report, 'prefilter_capital_guard_rejected'));
  assert.equal(findRoadmap(report, 'exit_dual_horizon_labels')?.priority, 'P0');
  assert.equal(findRoadmap(report, 'symbol_exit_policy_matrix_materialize')?.priority, 'P0');
  assert.equal(findRoadmap(report, 'strategy_bias_promotion_ready_shadow')?.liveMutation, false);
  assert.equal(report.summary.symbolExitPolicyStatus, 'priority');
  assert.equal(report.summary.agenticOperatingModelStatus, 'priority');
  assert.ok(report.executionLoop.some((item) => item.stage === 'simulate'));
  assert.ok(report.nextCommands.some((item) => item.includes('runtime:luna-optimal-exit-analysis')));
  assert.ok(report.nextCommands.some((item) => item.includes('runtime:luna-symbol-exit-timing-strategy-report')));
  assert.ok(report.nextCommands.some((item) => item.includes('smoke:luna-trading-process-improvement')));

  const summary = summarizeLunaTradingProcessImprovement(report);
  assert.ok(summary.p0.includes('exit_dual_horizon_labels'));
  assert.ok(summary.p0.includes('deterministic_exit_policy_before_llm_override'));
  assert.ok(summary.p1.includes('strategy_bias_promotion_ready_shadow'));
  return {
    ok: true,
    status: report.status,
    summary: report.summary,
    p0: summary.p0,
    p1: summary.p1,
    roadmapCount: report.roadmap.length,
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`luna-trading-process-improvement-smoke status=${result.status}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'luna-trading-process-improvement-smoke error:' });
}
