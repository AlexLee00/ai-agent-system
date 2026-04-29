#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildPosttradeFeedbackPhasePlan,
  patchPosttradeFeedbackConfig,
  runSmokeCommands,
} from './runtime-posttrade-feedback-phase-operator.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const baseConfig = {
  posttrade_feedback: {
    mode: 'shadow',
    trade_quality: { enabled: false, shadow: true, hard_gate: false },
    parameter_feedback_map: { enabled: false, shadow: true, hard_gate: false, auto_apply: false },
    worker: { enabled: false, shadow: true, hard_gate: false, interval_sec: 120 },
  },
};

async function runSmoke() {
  const plan = buildPosttradeFeedbackPhasePlan({
    config: baseConfig,
    requestedPhase: 'phaseA,phaseE,worker',
    mode: 'supervised_l4',
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.steps.length, 3);
  assert.equal(plan.mode, 'supervised_l4');

  const patched = patchPosttradeFeedbackConfig(baseConfig, ['phaseA', 'phaseE', 'worker'], 'supervised_l4');
  assert.equal(patched.posttrade_feedback.mode, 'supervised_l4');
  assert.equal(patched.posttrade_feedback.trade_quality.enabled, true);
  assert.equal(patched.posttrade_feedback.trade_quality.shadow, false);
  assert.equal(patched.posttrade_feedback.trade_quality.hard_gate, false);
  assert.equal(patched.posttrade_feedback.parameter_feedback_map.auto_apply, false);
  assert.equal(patched.posttrade_feedback.worker.enabled, true);
  assert.ok(patched.posttrade_feedback.worker.interval_sec >= 300);
  assert.equal(baseConfig.posttrade_feedback.trade_quality.enabled, false);

  const autoApplyPatched = patchPosttradeFeedbackConfig(baseConfig, ['phaseE'], 'supervised_l4', { autoApply: true });
  assert.equal(autoApplyPatched.posttrade_feedback.parameter_feedback_map.enabled, true);
  assert.equal(autoApplyPatched.posttrade_feedback.parameter_feedback_map.shadow, false);
  assert.equal(autoApplyPatched.posttrade_feedback.parameter_feedback_map.auto_apply, true);

  const shadowAutoApply = buildPosttradeFeedbackPhasePlan({
    config: baseConfig,
    requestedPhase: 'phaseE',
    mode: 'shadow',
    autoApply: true,
  });
  assert.equal(shadowAutoApply.ok, false);
  assert.ok(shadowAutoApply.blockers.includes('auto_apply_requires_supervised_or_higher'));

  const autonomous = buildPosttradeFeedbackPhasePlan({
    config: baseConfig,
    requestedPhase: 'all',
    mode: 'autonomous_l5',
  });
  assert.equal(autonomous.ok, false);
  assert.ok(autonomous.blockers.includes('autonomous_l5_requires_separate_human_cutover'));

  const smoke = runSmokeCommands(['node -e "process.exit(0)"']);
  assert.equal(smoke.length, 1);
  assert.equal(smoke[0].ok, true);

  return {
    ok: true,
    mode: plan.mode,
    phases: plan.steps.map((step) => step.phase),
    autonomousBlocked: autonomous.blockers,
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('posttrade feedback phase operator smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ posttrade-feedback-phase-operator-smoke 실패:',
  });
}
