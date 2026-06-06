'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RUNNER_PATH = path.resolve(__dirname, '../scripts/refactor-cycle-runner.ts');
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const ACTIVE_TARGET = 'bots/claude/lib/agent-heartbeat.ts';
const AUTOFIX_MARKER = 'const __refactorAutofixFixture = true;';

function targetContent(target = ACTIVE_TARGET) {
  return fs.readFileSync(path.join(PROJECT_ROOT, target), 'utf8');
}

function verifierModulesForAutofix(target = ACTIVE_TARGET) {
  const calls = { builder: [], reviewer: [] };
  const builderModule = {
    async runBuildCheck(options) {
      calls.builder.push(options);
      assert.deepStrictEqual(options.files, [target]);
      assert.strictEqual(options.force, true);
      assert.strictEqual(options.test, true);
      const content = targetContent(target);
      const pass = content.includes(AUTOFIX_MARKER);
      return {
        pass,
        skipped: false,
        message: pass ? 'forced builder pass after autofix' : 'forced builder fail before autofix',
        results: [{
          pass,
          skipped: false,
          error: pass ? null : 'TS2322: mocked type error after ts-nocheck removal',
        }],
      };
    },
  };
  const reviewerModule = {
    async runReview(options) {
      calls.reviewer.push(options);
      assert.deepStrictEqual(options.files, [target]);
      assert.strictEqual(options.force, true);
      assert.strictEqual(options.test, true);
      return { pass: true, skipped: false, summary: { high: 0, critical: 0 }, findings: [], sent: false };
    },
  };
  return { calls, builderModule, reviewerModule };
}

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

async function test_cycle_stamp_uses_kst() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  assert.strictEqual(runner.cycleStamp(new Date('2026-06-06T18:00:00.000Z')), '202606070300');
  assert.match(runner.buildCycleContext({ mode: 'shadow', target: 'bots/claude' }).cycleId, /^refactor-\d{12}-[a-f0-9]{8}$/);
  console.log('✅ refactor-cycle: cycleId stamp uses KST while generated_at stays UTC');
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

async function test_active_verifies_and_restores_without_autocommit() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = 'bots/claude/lib/agent-heartbeat.ts';
  const absoluteTarget = path.join(PROJECT_ROOT, target);
  const before = fs.readFileSync(absoluteTarget, 'utf8');
  const calls = { builder: [], reviewer: [] };
  const builderModule = {
    async runBuildCheck(options) {
      calls.builder.push(options);
      assert.deepStrictEqual(options.files, [target]);
      assert.strictEqual(options.force, true);
      assert.strictEqual(options.test, true);
      return { pass: true, skipped: false, message: 'forced builder test' };
    },
  };
  const reviewerModule = {
    async runReview(options) {
      calls.reviewer.push(options);
      assert.deepStrictEqual(options.files, [target]);
      assert.strictEqual(options.force, true);
      assert.strictEqual(options.test, true);
      return { pass: true, skipped: false, summary: { high: 0, critical: 0 }, findings: [] };
    },
  };
  const result = await runner.runRefactorCycle({
    mode: 'active',
    target,
    dryRun: true,
    noMcp: true,
    noVaultFeedback: true,
    noHeartbeat: true,
    noWriteOutcome: true,
    allowDirtyWorktreeForTest: true,
    builderModule,
    reviewerModule,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.mode, 'active');
  assert.strictEqual(calls.builder.length, 1);
  assert.strictEqual(calls.reviewer.length, 1);
  assert.strictEqual(result.active.stage, 'active_verified_ready_for_commit');
  assert.deepStrictEqual(result.active.changedFiles, [target]);
  assert.match(result.active.patchText, /-\/\/ @ts-nocheck/);
  assert.strictEqual(result.active.worktreeRestored, true);
  assert.strictEqual(result.steps.find((step) => step.id === 'fix').status, 'none');
  assert.strictEqual(result.steps.find((step) => step.id === 'commit').status, 'ready_for_review_autocommit_false');
  assert.strictEqual(fs.readFileSync(absoluteTarget, 'utf8'), before);
  console.log('✅ refactor-cycle: active verifies, captures patch, and restores without autocommit');
}

async function test_active_verify_skip_defers_and_restores() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = 'bots/claude/lib/agent-heartbeat.ts';
  const absoluteTarget = path.join(PROJECT_ROOT, target);
  const before = fs.readFileSync(absoluteTarget, 'utf8');
  const builderModule = {
    async runBuildCheck(options) {
      assert.deepStrictEqual(options.files, [target]);
      assert.strictEqual(options.force, true);
      assert.strictEqual(options.test, true);
      return { pass: true, skipped: true, message: 'unexpected skip' };
    },
  };
  const reviewerModule = {
    async runReview(options) {
      assert.deepStrictEqual(options.files, [target]);
      assert.strictEqual(options.force, true);
      assert.strictEqual(options.test, true);
      return { pass: true, skipped: false, summary: { high: 0, critical: 0 }, findings: [] };
    },
  };
  const result = await runner.runRefactorCycle({
    mode: 'active',
    target,
    dryRun: true,
    noMcp: true,
    noVaultFeedback: true,
    noHeartbeat: true,
    noWriteOutcome: true,
    allowDirtyWorktreeForTest: true,
    builderModule,
    reviewerModule,
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.active.stage, 'active_deferred');
  assert.deepStrictEqual(result.active.changedFiles, []);
  assert.strictEqual(result.active.patchText, '');
  assert.match(result.active.results[0].errorSummary, /builder_skipped=true/);
  assert.strictEqual(result.steps.find((step) => step.id === 'fix').status, 'active_deferred_no_auto_fix');
  assert.strictEqual(fs.readFileSync(absoluteTarget, 'utf8'), before);
  console.log('✅ refactor-cycle: verify skip defers and restores without self-heal');
}

async function test_autofix_off_preserves_phase3_defer() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
  const before = targetContent(target);
  const { calls, builderModule, reviewerModule } = verifierModulesForAutofix(target);
  let fixerCalls = 0;
  const result = await runner.runRefactorCycle({
    mode: 'active',
    target,
    dryRun: true,
    noMcp: true,
    noVaultFeedback: true,
    noHeartbeat: true,
    noWriteOutcome: true,
    allowDirtyWorktreeForTest: true,
    builderModule,
    reviewerModule,
    fixerFn: async () => {
      fixerCalls += 1;
      return { ok: true, fixedContent: 'should-not-be-called' };
    },
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.active.stage, 'active_deferred');
  assert.strictEqual(result.active.results[0].stage, 'active_deferred');
  assert.strictEqual(fixerCalls, 0);
  assert.strictEqual(calls.builder.length, 1);
  assert.strictEqual(calls.reviewer.length, 1);
  assert.strictEqual(targetContent(target), before);
  console.log('✅ refactor-cycle: autofix off keeps Phase 3 defer path');
}

async function test_autofix_success_captures_patch_and_restores() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
  const before = targetContent(target);
  const { calls, builderModule, reviewerModule } = verifierModulesForAutofix(target);
  let fixerCalls = 0;
  const result = await runner.runRefactorCycle({
    mode: 'active',
    target,
    dryRun: true,
    noMcp: true,
    noVaultFeedback: true,
    noHeartbeat: true,
    noWriteOutcome: true,
    allowDirtyWorktreeForTest: true,
    autofixEnabled: true,
    builderModule,
    reviewerModule,
    fixerFn: async (_context, params) => {
      fixerCalls += 1;
      assert.strictEqual(params.fileRel, target);
      assert.match(params.builderError, /TS2322/);
      return {
        ok: true,
        fixedContent: `${params.currentContent}\n${AUTOFIX_MARKER}\n`,
        model: 'mock-refactorer',
        provider: 'mock',
      };
    },
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.active.stage, 'active_autofixed_ready_for_commit');
  assert.strictEqual(result.active.results[0].stage, 'active_autofixed_ready_for_commit');
  assert.strictEqual(result.active.results[0].autofixAttempts, 1);
  assert.strictEqual(result.active.results[0].model, 'mock-refactorer');
  assert.deepStrictEqual(result.active.changedFiles, [target]);
  assert.match(result.active.patchText, /-\/\/ @ts-nocheck/);
  assert.match(result.active.patchText, new RegExp(AUTOFIX_MARKER));
  assert.strictEqual(result.steps.find((step) => step.id === 'fix').status, 'autofix_complete');
  assert.strictEqual(fixerCalls, 1);
  assert.strictEqual(calls.builder.length, 2);
  assert.strictEqual(calls.reviewer.length, 2);
  assert.strictEqual(targetContent(target), before);
  console.log('✅ refactor-cycle: autofix success re-verifies, captures patch, and restores');
}

async function test_autofix_failure_defers_unfixable_and_restores() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
  const before = targetContent(target);
  const { calls, builderModule, reviewerModule } = verifierModulesForAutofix(target);
  let fixerCalls = 0;
  const result = await runner.runRefactorCycle({
    mode: 'active',
    target,
    dryRun: true,
    noMcp: true,
    noVaultFeedback: true,
    noHeartbeat: true,
    noWriteOutcome: true,
    allowDirtyWorktreeForTest: true,
    autofixEnabled: true,
    autofixMaxAttempts: 1,
    builderModule,
    reviewerModule,
    fixerFn: async (_context, params) => {
      fixerCalls += 1;
      return { ok: true, fixedContent: params.currentContent, model: 'mock-bad-fix' };
    },
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.active.stage, 'active_deferred_unfixable');
  assert.strictEqual(result.active.results[0].stage, 'active_deferred_unfixable');
  assert.strictEqual(result.active.results[0].autofixAttempts, 1);
  assert.match(result.active.results[0].errorSummary, /mocked type error|verify_failed|builder/);
  assert.strictEqual(fixerCalls, 1);
  assert.strictEqual(calls.builder.length, 2);
  assert.strictEqual(calls.reviewer.length, 2);
  assert.strictEqual(targetContent(target), before);
  console.log('✅ refactor-cycle: autofix failure defers unfixable and restores');
}

async function test_autofix_rejects_unexpected_mutation() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
  const before = targetContent(target);
  const unexpectedRel = 'bots/claude/__tests__/tmp-refactor-unexpected.txt';
  const unexpectedAbs = path.join(PROJECT_ROOT, unexpectedRel);
  fs.rmSync(unexpectedAbs, { force: true });
  const { builderModule, reviewerModule } = verifierModulesForAutofix(target);
  const result = await runner.runRefactorCycle({
    mode: 'active',
    target,
    dryRun: true,
    noMcp: true,
    noVaultFeedback: true,
    noHeartbeat: true,
    noWriteOutcome: true,
    allowDirtyWorktreeForTest: true,
    autofixEnabled: true,
    builderModule,
    reviewerModule,
    fixerFn: async (_context, params) => {
      fs.writeFileSync(unexpectedAbs, 'unexpected mutation', 'utf8');
      return {
        ok: true,
        fixedContent: `${params.currentContent}\n${AUTOFIX_MARKER}\n`,
        model: 'mock-mutating-fix',
      };
    },
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.active.results[0].stage, 'active_deferred_unfixable');
  assert.match(result.active.results[0].errorSummary, /autofix_unexpected_mutation/);
  assert.strictEqual(fs.existsSync(unexpectedAbs), false);
  assert.strictEqual(targetContent(target), before);
  console.log('✅ refactor-cycle: autofix rejects and cleans unexpected mutation');
}

async function main() {
  console.log('=== Refactor Cycle Runner 테스트 시작 ===\n');
  const tests = [
    test_mode_defaults_off,
    test_cycle_stamp_uses_kst,
    test_protected_target_guard,
    test_protected_descendants_are_excluded_from_analysis,
    test_shadow_dry_run_analyze_plan_only,
    test_plan_includes_sigma_feedback_context,
    test_active_verifies_and_restores_without_autocommit,
    test_active_verify_skip_defers_and_restores,
    test_autofix_off_preserves_phase3_defer,
    test_autofix_success_captures_patch_and_restores,
    test_autofix_failure_defers_unfixable_and_restores,
    test_autofix_rejects_unexpected_mutation,
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
