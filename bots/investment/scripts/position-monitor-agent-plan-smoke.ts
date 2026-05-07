#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { assertSmokePass } from '../shared/smoke-assert.ts';
import {
  buildDisabledDynamicPositionSizingSnapshot,
  buildDisabledDynamicTrailSnapshot,
  buildPositionMonitorAgentPlan,
} from '../shared/position-monitor-agent-plan.ts';

function lifecycleFlags(overrides = {}) {
  const flags = {
    signalRefresh: true,
    reflexive: true,
    dynamicTrail: true,
    shouldExecuteSignalRefresh() {
      return this.signalRefresh;
    },
    shouldApplyReflexiveMonitoring() {
      return this.reflexive;
    },
    shouldApplyDynamicTrail() {
      return this.dynamicTrail;
    },
    ...overrides,
  };
  return flags;
}

export async function runPositionMonitorAgentPlanSmoke({ json = false, strict = true } = {}) {
  const defaultPlan = buildPositionMonitorAgentPlan({
    lifecycleFlags: lifecycleFlags(),
    liveIndicators: true,
  });
  const overridePlan = buildPositionMonitorAgentPlan({
    lifecycleFlags: lifecycleFlags({ dynamicTrail: false, reflexive: false }),
    eventPayload: {
      agentPlan: {
        monitor: {
          liveIndicatorsEnabled: false,
          signalRefreshEnabled: false,
          externalEvidenceEnabled: false,
          strategyMutationEnabled: false,
          dynamicSizingEnabled: false,
          dynamicTrailEnabled: false,
          reflexivePortfolioEnabled: false,
        },
      },
    },
  });
  const immutablePlan = buildPositionMonitorAgentPlan({
    lifecycleFlags: lifecycleFlags({ dynamicTrail: true, reflexive: true }),
    agentPlan: {
      monitor: {
        dynamicTrailEnabled: false,
        reflexivePortfolioEnabled: false,
      },
    },
  });
  const stringPayloadPlan = buildPositionMonitorAgentPlan({
    lifecycleFlags: lifecycleFlags({ signalRefresh: false, dynamicTrail: false, reflexive: false }),
    eventPayload: JSON.stringify({
      monitorAgentPlan: {
        liveIndicators: 'off',
        externalEvidence: 'no',
      },
    }),
  });
  const disabledSizing = buildDisabledDynamicPositionSizingSnapshot();
  const disabledTrail = buildDisabledDynamicTrailSnapshot();

  const cases = [
    {
      name: 'default_preserves_runtime_enabled_monitoring',
      pass: defaultPlan.liveIndicatorsEnabled === true
        && defaultPlan.signalRefreshEnabled === true
        && defaultPlan.externalEvidenceEnabled === true
        && defaultPlan.strategyMutationEnabled === true
        && defaultPlan.reflexivePortfolioEnabled === true
        && defaultPlan.dynamicSizingEvaluationEnabled === true
        && defaultPlan.dynamicTrailEvaluationEnabled === true,
      output: defaultPlan,
    },
    {
      name: 'override_can_reduce_optional_monitoring_nodes',
      pass: overridePlan.liveIndicatorsEnabled === false
        && overridePlan.signalRefreshEnabled === false
        && overridePlan.externalEvidenceEnabled === false
        && overridePlan.strategyMutationEnabled === false
        && overridePlan.dynamicSizingEvaluationEnabled === false
        && overridePlan.dynamicTrailEvaluationEnabled === false
        && overridePlan.reflexivePortfolioEnabled === false,
      output: overridePlan,
    },
    {
      name: 'safety_monitoring_gates_are_immutable_when_runtime_enabled',
      pass: immutablePlan.dynamicTrailEvaluationEnabled === true
        && immutablePlan.reflexivePortfolioEnabled === true
        && immutablePlan.warnings.includes('immutable_monitor_safety_gate:dynamic_trail')
        && immutablePlan.warnings.includes('immutable_monitor_safety_gate:reflexive_portfolio'),
      output: immutablePlan,
    },
    {
      name: 'string_payload_override_is_supported',
      pass: stringPayloadPlan.liveIndicatorsEnabled === false
        && stringPayloadPlan.externalEvidenceEnabled === false
        && stringPayloadPlan.signalRefreshEnabled === false,
      output: stringPayloadPlan,
    },
    {
      name: 'disabled_snapshots_are_hold_safe',
      pass: disabledSizing.mode === 'disabled_by_agent_plan'
        && disabledSizing.executionAction === 'HOLD'
        && disabledTrail.method === 'disabled_by_agent_plan'
        && disabledTrail.breached === false,
      output: { disabledSizing, disabledTrail },
    },
  ];

  const passed = cases.filter((item) => item.pass).length;
  const total = cases.length;
  const summary = { pass: passed === total, passed, total, results: cases };
  if (strict) assertSmokePass(summary, '[position-monitor-agent-plan-smoke]');
  if (json) return summary;
  return {
    ...summary,
    text: [
      `[position-monitor-agent-plan-smoke] ${passed}/${total} 통과`,
      ...cases.map((item) => `${item.pass ? '✓' : '✗'} ${item.name}`),
    ].join('\n'),
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => {
      const json = process.argv.includes('--json');
      return runPositionMonitorAgentPlanSmoke({ json, strict: true });
    },
    onSuccess: async (result) => {
      if (result?.text) console.log(result.text);
      else console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '[position-monitor-agent-plan-smoke]',
  });
}
