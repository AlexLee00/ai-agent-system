'use strict';

const assert = require('assert');
const path = require('path');

const RUNNER_PATH = path.resolve(__dirname, '../scripts/refactor-cycle-runner.ts');

async function test_mode_defaults_off() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  assert.strictEqual(runner.normalizeCycleMode(undefined), 'off');
  assert.strictEqual(runner.normalizeCycleMode(''), 'off');
  assert.strictEqual(runner.normalizeCycleMode('shadow'), 'shadow');
  assert.strictEqual(runner.normalizeCycleMode('active'), 'active');
  assert.strictEqual(runner.normalizeCycleMode('invalid'), 'off');
  console.log('✅ refactor-cycle: mode defaults and normalization are safe');
}

async function test_protected_target_guard() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  assert.strictEqual(runner.isProtectedTarget('bots/investment/markets/crypto.ts'), true);
  assert.strictEqual(runner.isProtectedTarget('bots/investment/markets'), true);
  assert.strictEqual(runner.isProtectedTarget('bots/claude/src/reviewer.ts'), false);
  const outside = runner.resolveTarget('../outside-project');
  assert.strictEqual(outside.ok, false);
  assert.strictEqual(outside.reason, 'target_outside_project_root');
  console.log('✅ refactor-cycle: protected and outside targets are blocked');
}

async function test_protected_descendants_are_excluded_from_analysis() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const protectedTarget = runner.resolveTarget('bots/investment/markets/crypto.ts');
  assert.strictEqual(protectedTarget.ok, true);
  const protectedAnalysis = runner.analyzeLocalTechDebt(protectedTarget);
  assert.strictEqual(protectedAnalysis.summary.totalTsFiles, 0);
  assert.deepStrictEqual(protectedAnalysis.candidates, []);
  console.log('✅ refactor-cycle: protected descendants are excluded from analysis');
}

async function test_shadow_dry_run_analyze_plan_only() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const result = await runner.runRefactorCycle({
    mode: 'shadow',
    target: 'bots/claude/lib/agent-heartbeat.ts',
    dryRun: true,
    noMcp: true,
    noHeartbeat: true,
    noWriteOutcome: true,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.mode, 'shadow');
  assert.strictEqual(result.plan.wrote, false);
  assert.strictEqual(result.steps.find((step) => step.id === 'analyze').status, 'complete');
  assert.strictEqual(result.steps.find((step) => step.id === 'plan').status, 'complete');
  assert.strictEqual(result.steps.find((step) => step.id === 'refactor').status, 'pending_phase3_active');
  assert.strictEqual(result.analysis.summary.totalTsFiles, 1);
  assert.strictEqual(result.plan.vaultFeedback.skipped, true);
  assert.strictEqual(result.plan.vaultFeedback.reason, 'dry_run');
  assert.strictEqual(result.outcome.skipped, true);
  assert.strictEqual(result.heartbeat.skipped, true);
  console.log('✅ refactor-cycle: shadow dry-run only analyzes and plans');
}

async function test_plan_includes_sigma_feedback_context() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const context = runner.buildCycleContext({
    mode: 'shadow',
    target: 'bots/claude/lib/agent-heartbeat.ts',
    dryRun: true,
  });
  const analysis = runner.analyzeLocalTechDebt(context.target);
  const plan = runner.planStep(context, analysis, {
    vaultFeedback: {
      ok: true,
      query: 'refactor ts_nocheck fixture',
      results: [{
        title: '[claude_refactor] previous plan',
        source: 'claude_refactor',
        similarity: 0.91,
        cycleId: 'refactor-fixture',
      }],
    },
  });
  assert.match(plan.content, /## Sigma Feedback/);
  assert.match(plan.content, /source=claude_refactor/);
  assert.match(plan.content, /cycle=refactor-fixture/);
  console.log('✅ refactor-cycle: plan embeds Sigma refactor feedback');
}

async function test_active_is_blocked_in_phase1() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const result = await runner.runRefactorCycle({
    mode: 'active',
    target: 'bots/claude/agents',
    noHeartbeat: true,
    noWriteOutcome: true,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocked, true);
  assert.strictEqual(result.reason, 'active_not_implemented_phase1');
  console.log('✅ refactor-cycle: active mode is blocked in Phase 1');
}

async function main() {
  console.log('=== Refactor Cycle Runner 테스트 시작 ===\n');
  const tests = [
    test_mode_defaults_off,
    test_protected_target_guard,
    test_protected_descendants_are_excluded_from_analysis,
    test_shadow_dry_run_analyze_plan_only,
    test_plan_includes_sigma_feedback_context,
    test_active_is_blocked_in_phase1,
  ];
  let passed = 0;
  let failed = 0;
  for (const test of tests) {
    try {
      await test();
      passed += 1;
    } catch (error) {
      console.error(`❌ ${test.name}: ${error.message}`);
      failed += 1;
    }
  }
  console.log(`\n결과: ${passed}/${tests.length} 통과`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
