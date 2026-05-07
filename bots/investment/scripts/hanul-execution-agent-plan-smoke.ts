#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildHanulExecutionAgentPlan } from '../team/hanul/execution-agent-plan.ts';
import { ACTIONS } from '../shared/signal.ts';
import { applyHanulResponsibilityExecutionSizing } from '../team/hanul.ts';

export async function runHanulExecutionAgentPlanSmoke({ json = false } = {}) {
  const defaults = buildHanulExecutionAgentPlan({ market: 'domestic' });
  assert.equal(defaults.responsibilityExecutionSizingEnabled, true);
  assert.equal(defaults.features.pre_trade_check, true);
  assert.equal(defaults.features.risk_check, true);
  assert.equal(defaults.features.fill_verification, true);
  assert.equal(defaults.features.same_day_reentry_block, true);

  const immutable = buildHanulExecutionAgentPlan({
    market: 'overseas',
    agentPlan: {
      hanul: {
        disabledFeatures: ['pre_trade_check', 'fill_verification', 'same_day_reentry_block'],
      },
    },
  });
  assert.equal(immutable.features.pre_trade_check, true);
  assert.equal(immutable.features.fill_verification, true);
  assert.equal(immutable.features.same_day_reentry_block, true);
  assert.equal(immutable.warnings.includes('immutable_hanul_execution_feature:pre_trade_check'), true);
  assert.equal(immutable.warnings.includes('immutable_hanul_execution_feature:fill_verification'), true);
  assert.equal(immutable.warnings.includes('immutable_hanul_execution_feature:same_day_reentry_block'), true);

  const reducedPlan = buildHanulExecutionAgentPlan({
    market: 'domestic',
    agentPlan: {
      execution: {
        domestic: {
          entrySizingMultiplier: 0.5,
        },
      },
    },
  });
  assert.equal(reducedPlan.entrySizingMultiplier, 0.5);
  const reducedSizing = applyHanulResponsibilityExecutionSizing(100_000, {
    action: ACTIONS.BUY,
    confidence: 0.8,
    responsibilityPlan: { ownerMode: 'opportunity_capture' },
    executionAgentPlan: reducedPlan,
  });
  assert.equal(reducedSizing.amount, 51_000);
  assert.match(reducedSizing.reason, /agentPlan entry x0.5/u);

  const disabledPlan = buildHanulExecutionAgentPlan({
    agentPlan: {
      hanul: {
        disabledFeatures: ['responsibility_execution_sizing'],
      },
    },
  });
  assert.equal(disabledPlan.responsibilityExecutionSizingEnabled, false);
  const disabledSizing = applyHanulResponsibilityExecutionSizing(100_000, {
    action: ACTIONS.BUY,
    confidence: 0.8,
    responsibilityPlan: { ownerMode: 'opportunity_capture', riskMission: 'strict_risk_gate' },
    executionPlan: { entrySizingMultiplier: 0.5 },
    executionAgentPlan: disabledPlan,
  });
  assert.deepEqual(disabledSizing, { amount: 100_000, multiplier: 1, reason: null });

  const clamped = buildHanulExecutionAgentPlan({
    agentPlan: {
      kis: {
        entrySizingMultiplier: 1.7,
      },
    },
  });
  assert.equal(clamped.entrySizingMultiplier, 1);
  assert.equal(clamped.warnings.includes('hanul_entry_sizing_multiplier_clamped_to_1'), true);

  const oldEnv = process.env.LUNA_HANUL_EXECUTION_AGENT_PLAN_JSON;
  process.env.LUNA_HANUL_EXECUTION_AGENT_PLAN_JSON = JSON.stringify({
    overseas: {
      disabledFeatures: ['responsibility_execution_sizing'],
    },
  });
  try {
    const envPlan = buildHanulExecutionAgentPlan({ market: 'overseas' });
    assert.equal(envPlan.responsibilityExecutionSizingEnabled, false);
  } finally {
    if (oldEnv === undefined) delete process.env.LUNA_HANUL_EXECUTION_AGENT_PLAN_JSON;
    else process.env.LUNA_HANUL_EXECUTION_AGENT_PLAN_JSON = oldEnv;
  }

  const summary = {
    ok: true,
    checked: 6,
    optionalFeatures: ['responsibility_execution_sizing'],
    immutableFeatures: [
      'nemesis_approval',
      'pre_trade_check',
      'risk_check',
      'sizing_floor',
      'fill_verification',
      'pending_reconcile',
      'position_mode_conflict',
      'same_day_reentry_block',
    ],
  };
  if (json) return summary;
  return { ...summary, text: 'hanul execution agent plan smoke ok' };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runHanulExecutionAgentPlanSmoke({ json: process.argv.includes('--json') }),
    onSuccess: async (result) => {
      if (result?.text) console.log(result.text);
      else console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '[hanul-execution-agent-plan-smoke]',
  });
}
