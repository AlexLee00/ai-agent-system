#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildPosttradeFeedbackAgentPlan,
  shouldRunPosttradePhase,
} from '../shared/posttrade-feedback-agent-plan.ts';

function enabled(overrides = {}) {
  return {
    trade_quality: true,
    stage_attribution: true,
    reflexion: true,
    curriculum: true,
    ...overrides,
  };
}

export async function runPosttradeFeedbackAgentPlanSmoke({ json = false } = {}) {
  const defaults = buildPosttradeFeedbackAgentPlan({ enabled: enabled() });
  assert.equal(defaults.source, 'default_posttrade_feedback_plan');
  assert.equal(shouldRunPosttradePhase(defaults, 'trade_quality'), true);
  assert.equal(shouldRunPosttradePhase(defaults, 'stage_attribution'), true);
  assert.equal(shouldRunPosttradePhase(defaults, 'reflexion'), true);
  assert.equal(shouldRunPosttradePhase(defaults, 'curriculum'), true);

  const optionalReduced = buildPosttradeFeedbackAgentPlan({
    agentPlan: {
      posttradeFeedback: {
        disabledPhases: ['stage_attribution', 'reflexion', 'curriculum'],
      },
    },
    enabled: enabled(),
  });
  assert.equal(optionalReduced.source, 'override');
  assert.equal(shouldRunPosttradePhase(optionalReduced, 'trade_quality'), true);
  assert.equal(shouldRunPosttradePhase(optionalReduced, 'stage_attribution'), false);
  assert.equal(shouldRunPosttradePhase(optionalReduced, 'reflexion'), false);
  assert.equal(shouldRunPosttradePhase(optionalReduced, 'curriculum'), false);

  const immutableQuality = buildPosttradeFeedbackAgentPlan({
    agentPlan: {
      posttrade_feedback: {
        disabled_phases: ['quality'],
      },
    },
    enabled: enabled(),
  });
  assert.equal(shouldRunPosttradePhase(immutableQuality, 'trade_quality'), true);
  assert.equal(immutableQuality.warnings.includes('immutable_posttrade_phase:trade_quality'), true);

  const runtimeDisabled = buildPosttradeFeedbackAgentPlan({
    agentPlan: {
      posttrade: {
        enabledPhases: ['stage', 'reflection'],
      },
    },
    enabled: enabled({ stage_attribution: false, reflexion: false }),
  });
  assert.equal(shouldRunPosttradePhase(runtimeDisabled, 'stage_attribution'), false);
  assert.equal(shouldRunPosttradePhase(runtimeDisabled, 'reflexion'), false);
  assert.equal(runtimeDisabled.warnings.includes('runtime_disabled_phase_not_enabled:stage_attribution'), true);
  assert.equal(runtimeDisabled.warnings.includes('runtime_disabled_phase_not_enabled:reflexion'), true);

  const oldEnv = process.env.LUNA_POSTTRADE_AGENT_PLAN_JSON;
  process.env.LUNA_POSTTRADE_AGENT_PLAN_JSON = JSON.stringify({
    posttrade: {
      enabled_phases: ['trade_quality', 'curriculum'],
      disabled_phases: ['unknown_phase'],
    },
  });
  try {
    const envPlan = buildPosttradeFeedbackAgentPlan({ enabled: enabled() });
    assert.equal(envPlan.source, 'override');
    assert.equal(shouldRunPosttradePhase(envPlan, 'trade_quality'), true);
    assert.equal(shouldRunPosttradePhase(envPlan, 'stage_attribution'), false);
    assert.equal(shouldRunPosttradePhase(envPlan, 'reflexion'), false);
    assert.equal(shouldRunPosttradePhase(envPlan, 'curriculum'), true);
    assert.equal(envPlan.warnings.includes('unknown_posttrade_phase:unknown_phase'), true);
  } finally {
    if (oldEnv === undefined) delete process.env.LUNA_POSTTRADE_AGENT_PLAN_JSON;
    else process.env.LUNA_POSTTRADE_AGENT_PLAN_JSON = oldEnv;
  }

  const summary = {
    ok: true,
    checked: 5,
    immutablePhase: 'trade_quality',
    optionalPhases: ['stage_attribution', 'reflexion', 'curriculum'],
  };
  if (json) return summary;
  return { ...summary, text: 'posttrade feedback agent plan smoke ok' };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runPosttradeFeedbackAgentPlanSmoke({ json: process.argv.includes('--json') }),
    onSuccess: async (result) => {
      if (result?.text) console.log(result.text);
      else console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '[posttrade-feedback-agent-plan-smoke]',
  });
}
