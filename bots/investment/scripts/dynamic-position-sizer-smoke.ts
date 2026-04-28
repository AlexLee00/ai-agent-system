#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { computeDynamicPositionSizing } from '../shared/dynamic-position-sizer.ts';
import { assertSmokePass } from '../shared/smoke-assert.ts';

const SCENARIOS = [
  {
    name: 'accepted_hold',
    env: 'true',
    input: { pnlPct: 2.1, currentWeightPct: 0.12, targetVolatility: 0.03, realizedVolatility: 0.028, winRate: 0.54, rewardRisk: 1.7 },
    expectMode: 'hold',
  },
  {
    name: 'reduced_volatility_trim',
    env: 'true',
    input: { pnlPct: 5.5, currentWeightPct: 0.20, targetVolatility: 0.03, realizedVolatility: 0.055, winRate: 0.52, rewardRisk: 1.6 },
    expectMode: 'trim',
    expectReasonCode: 'volatility_target_trim',
  },
  {
    name: 'kelly_correction_trim',
    env: 'true',
    input: { pnlPct: 1.5, currentWeightPct: 0.28, targetVolatility: 0.03, realizedVolatility: 0.03, winRate: 0.47, rewardRisk: 1.2 },
    expectMode: 'trim',
    expectReasonCode: 'kelly_size_correction',
  },
  {
    name: 'pyramid_continuation',
    env: 'true',
    input: { pnlPct: 7.8, currentWeightPct: 0.08, targetVolatility: 0.03, realizedVolatility: 0.025, winRate: 0.62, rewardRisk: 1.9 },
    expectMode: 'pyramid',
    expectReasonCode: 'pyramid_continuation',
    expectExecutionAction: 'BUY',
    expectRunnerHint: 'runtime:pyramid-adjust',
  },
];

export async function runDynamicPositionSizerSmoke({ json = false, strict = true } = {}) {
  const results = [];
  const saved = process.env.LUNA_DYNAMIC_POSITION_SIZING_ENABLED;
  try {
    for (const scenario of SCENARIOS) {
      process.env.LUNA_DYNAMIC_POSITION_SIZING_ENABLED = scenario.env;
      const output = computeDynamicPositionSizing(scenario.input);
      const pass = output.mode === scenario.expectMode
        && (!scenario.expectReasonCode || output.reasonCode === scenario.expectReasonCode)
        && (!scenario.expectExecutionAction || output.executionAction === scenario.expectExecutionAction)
        && (!scenario.expectRunnerHint || output.runnerHint === scenario.expectRunnerHint);
      results.push({
        scenario: scenario.name,
        pass,
        mode: output.mode,
        reasonCode: output.reasonCode,
        adjustmentRatio: output.adjustmentRatio,
        executionAction: output.executionAction,
        runnerHint: output.runnerHint,
        targetWeight: output.targetWeight,
        errors: [
          output.mode !== scenario.expectMode ? `mode mismatch ${output.mode} != ${scenario.expectMode}` : null,
          scenario.expectReasonCode && output.reasonCode !== scenario.expectReasonCode
            ? `reasonCode mismatch ${output.reasonCode} != ${scenario.expectReasonCode}`
            : null,
          scenario.expectExecutionAction && output.executionAction !== scenario.expectExecutionAction
            ? `executionAction mismatch ${output.executionAction} != ${scenario.expectExecutionAction}`
            : null,
          scenario.expectRunnerHint && output.runnerHint !== scenario.expectRunnerHint
            ? `runnerHint mismatch ${output.runnerHint} != ${scenario.expectRunnerHint}`
            : null,
        ].filter(Boolean),
      });
    }
  } finally {
    if (saved === undefined) delete process.env.LUNA_DYNAMIC_POSITION_SIZING_ENABLED;
    else process.env.LUNA_DYNAMIC_POSITION_SIZING_ENABLED = saved;
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  const summary = { pass: passed === total, passed, total, results };
  if (strict) assertSmokePass(summary, '[dynamic-position-sizer-smoke]');
  if (json) return summary;
  return {
    ...summary,
    text: [
      `[dynamic-position-sizer-smoke] ${passed}/${total} 통과`,
      ...results.map((item) => `${item.pass ? '✓' : '✗'} ${item.scenario} -> ${item.mode} (${item.reasonCode})`),
    ].join('\n'),
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => {
      const json = process.argv.includes('--json');
      return runDynamicPositionSizerSmoke({ json, strict: true });
    },
    onSuccess: async (result) => {
      if (result?.text) console.log(result.text);
      else console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '[dynamic-position-sizer-smoke]',
  });
}
