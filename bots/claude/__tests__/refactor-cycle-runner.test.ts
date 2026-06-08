'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RUNNER_PATH = path.resolve(__dirname, '../scripts/refactor-cycle-runner.ts');
const BUILDER_PATH = path.resolve(__dirname, '../src/builder.ts');
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const ACTIVE_TARGET = 'bots/claude/lib/agent-heartbeat.ts';
const AUTOFIX_MARKER = 'const __refactorAutofixFixture = true;';
const TARGETED_TSC_TMP_DIR = path.join(PROJECT_ROOT, 'packages/core/lib/tmp-refactorer-targeted-typecheck');

function targetContent(target = ACTIVE_TARGET) {
  return fs.readFileSync(path.join(PROJECT_ROOT, target), 'utf8');
}

function resetTargetedTypecheckTmp() {
  fs.rmSync(TARGETED_TSC_TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TARGETED_TSC_TMP_DIR, { recursive: true });
}

function cleanupTargetedTypecheckTmp() {
  fs.rmSync(TARGETED_TSC_TMP_DIR, { recursive: true, force: true });
  for (const name of fs.readdirSync(PROJECT_ROOT)) {
    if (/^\.refactorer-tscheck-.*\.json$/.test(name)) {
      fs.rmSync(path.join(PROJECT_ROOT, name), { force: true });
    }
  }
}

function writeTmpTsFile(name, content) {
  const absolute = path.join(TARGETED_TSC_TMP_DIR, name);
  fs.writeFileSync(absolute, content, 'utf8');
  return path.relative(PROJECT_ROOT, absolute).replace(/\\/g, '/');
}

function requireBuilder() {
  delete require.cache[BUILDER_PATH];
  return require(BUILDER_PATH);
}

function cleanupRefactorArtifacts(result) {
  for (const rel of [
    result?.active?.patchRelPath,
    result?.active?.planRelPath,
    result?.plan?.patchRelPath,
    result?.plan?.relPath,
  ].filter(Boolean)) {
    fs.rmSync(path.join(PROJECT_ROOT, rel), { force: true });
  }
}

function verifierModulesForAutofix(target = ACTIVE_TARGET) {
  const calls = { builder: [], reviewer: [] };
  const builderModule = {
    async runTargetedTypeCheck(files, options) {
      calls.builder.push(options);
      assert.deepStrictEqual(files, [target]);
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

function verifierModulesAlwaysPass(target = ACTIVE_TARGET) {
  const calls = { builder: [], reviewer: [] };
  const builderModule = {
    async runTargetedTypeCheck(files, options) {
      calls.builder.push(options);
      assert.deepStrictEqual(files, [target]);
      assert.deepStrictEqual(options.files, [target]);
      assert.strictEqual(options.force, true);
      assert.strictEqual(options.test, true);
      return {
        pass: true,
        skipped: false,
        message: 'forced builder pass',
        results: [{ pass: true, skipped: false, message: 'forced builder pass' }],
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

function reviewerModuleAlwaysPass(target = ACTIVE_TARGET) {
  return {
    async runReview(options) {
      assert.deepStrictEqual(options.files, [target]);
      assert.strictEqual(options.force, true);
      assert.strictEqual(options.test, true);
      return { pass: true, skipped: false, summary: { high: 0, critical: 0 }, findings: [], sent: false };
    },
  };
}

function strictPass() {
  return { pass: true, skipped: false, message: 'mock strict pass' };
}

async function runActiveWithBuilderResult(builderResult, target = ACTIVE_TARGET) {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const before = targetContent(target);
  const result = await runner.runRefactorCycle({
    mode: 'active',
    target,
    dryRun: true,
    noMcp: true,
    noVaultFeedback: true,
    noHeartbeat: true,
    noWriteOutcome: true,
    allowDirtyWorktreeForTest: true,
    builderModule: {
      async runTargetedTypeCheck(files, options) {
        assert.deepStrictEqual(files, [target]);
        assert.deepStrictEqual(options.files, [target]);
        assert.strictEqual(options.force, true);
        assert.strictEqual(options.test, true);
        return builderResult;
      },
    },
    reviewerModule: reviewerModuleAlwaysPass(target),
  });
  assert.strictEqual(targetContent(target), before);
  return result;
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

async function test_dirty_scope_helpers() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  assert.strictEqual(runner.normalizeDirtyScope(undefined), 'workspace');
  assert.strictEqual(runner.normalizeDirtyScope('file'), 'file');
  assert.strictEqual(runner.normalizeDirtyScope('tree'), 'tree');
  assert.strictEqual(runner.normalizeDirtyScope('invalid'), 'workspace');
  assert.deepStrictEqual(runner.refactorScopePrefixes('packages/core/lib/x.ts', 'workspace'), ['packages/core']);
  assert.deepStrictEqual(runner.refactorScopePrefixes('bots/claude/scripts/x.ts', 'workspace'), ['bots/claude']);
  assert.deepStrictEqual(runner.refactorScopePrefixes('elixir/web/lib/x.ex', 'workspace'), ['elixir/web']);
  assert.deepStrictEqual(runner.refactorScopePrefixes('docs/codex/x.md', 'workspace'), ['docs']);
  assert.deepStrictEqual(runner.refactorScopePrefixes('bots/claude/scripts/x.ts', 'file'), ['bots/claude/scripts/x.ts']);
  assert.deepStrictEqual(runner.refactorScopePrefixes('bots/claude/scripts/x.ts', 'tree'), []);
  console.log('✅ refactor-cycle: dirty scope helpers resolve file/workspace/tree');
}

async function test_dirty_scope_guard_ignores_other_workspace_dirty() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
  const fullStatus = ' M bots/darwin/lib/implementor.ts';
  const { calls, builderModule, reviewerModule } = verifierModulesAlwaysPass(target);
  const result = await runner.runRefactorCycle({
    mode: 'active',
    target,
    dryRun: true,
    noMcp: true,
    noVaultFeedback: true,
    noHeartbeat: true,
    noWriteOutcome: true,
    builderModule,
    reviewerModule,
    gitStatusShortFn: () => fullStatus,
    gitStatusScopedFn: (prefixes = []) => {
      if (!prefixes.length) return fullStatus;
      if (prefixes.includes('bots/claude') || prefixes.includes(target)) return '';
      return fullStatus;
    },
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.reason, undefined);
  assert.strictEqual(result.active.worktreeRestored, true);
  assert.strictEqual(result.active.finalGitStatus, fullStatus);
  assert.deepStrictEqual(result.active.changedFiles, [target]);
  assert.strictEqual(calls.builder.length, 1);
  assert.strictEqual(calls.reviewer.length, 1);
  console.log('✅ refactor-cycle: workspace scope ignores unrelated dirty worktree');
}

async function test_dirty_scope_guard_blocks_target_workspace_dirty() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
  const fullStatus = ' M bots/darwin/lib/implementor.ts\n M bots/claude/lib/agent-heartbeat.ts';
  const result = await runner.runRefactorCycle({
    mode: 'active',
    target,
    dryRun: true,
    noMcp: true,
    noVaultFeedback: true,
    noHeartbeat: true,
    noWriteOutcome: true,
    gitStatusShortFn: () => fullStatus,
    gitStatusScopedFn: (prefixes = []) => {
      if (prefixes.includes('bots/claude')) return ' M bots/claude/lib/agent-heartbeat.ts';
      if (prefixes.includes(target)) return ' M bots/claude/lib/agent-heartbeat.ts';
      return fullStatus;
    },
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocked, true);
  assert.strictEqual(result.reason, 'dirty_worktree_in_scope');
  assert.strictEqual(result.dirtyScope, 'workspace');
  assert.deepStrictEqual(result.scope, ['bots/claude']);
  assert.match(result.gitStatus, /bots\/claude\/lib\/agent-heartbeat\.ts/);
  console.log('✅ refactor-cycle: workspace scope blocks dirty target workspace');
}

async function test_dirty_scope_tree_mode_preserves_full_tree_guard() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const fullStatus = ' M bots/darwin/lib/implementor.ts';
  const result = await runner.runRefactorCycle({
    mode: 'active',
    target: ACTIVE_TARGET,
    dirtyScope: 'tree',
    dryRun: true,
    noMcp: true,
    noVaultFeedback: true,
    noHeartbeat: true,
    noWriteOutcome: true,
    gitStatusShortFn: () => fullStatus,
    gitStatusScopedFn: (prefixes = []) => (prefixes.length ? '' : fullStatus),
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocked, true);
  assert.strictEqual(result.reason, 'dirty_worktree_in_scope');
  assert.strictEqual(result.dirtyScope, 'tree');
  assert.deepStrictEqual(result.scope, []);
  assert.match(result.gitStatus, /bots\/darwin\/lib\/implementor\.ts/);
  console.log('✅ refactor-cycle: tree scope preserves full-tree dirty guard');
}

async function test_dirty_scope_mutation_isolation_and_cleanup() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const inScopeUntracked = 'bots/claude/__tests__/tmp-scope-untracked.txt';
  const outScopeUntracked = 'bots/darwin/__tests__/tmp-scope-outside.txt';
  const inScopeAbs = path.join(PROJECT_ROOT, inScopeUntracked);
  const outScopeAbs = path.join(PROJECT_ROOT, outScopeUntracked);
  fs.rmSync(inScopeAbs, { force: true });
  fs.rmSync(outScopeAbs, { force: true });
  fs.writeFileSync(inScopeAbs, 'in scope', 'utf8');
  fs.writeFileSync(outScopeAbs, 'out of scope', 'utf8');
  try {
    const status = [
      ` M ${ACTIVE_TARGET}`,
      ' M bots/claude/lib/unexpected.ts',
      ' M bots/darwin/lib/implementor.ts',
      `?? ${inScopeUntracked}`,
      `?? ${outScopeUntracked}`,
    ].join('\n');
    const scoped = runner.unexpectedMutationLines(status, '', [ACTIVE_TARGET], ['bots/claude']);
    assert.deepStrictEqual(scoped, [
      ' M bots/claude/lib/unexpected.ts',
      `?? ${inScopeUntracked}`,
    ]);
    const tree = runner.unexpectedMutationLines(status, '', [ACTIVE_TARGET], []);
    assert.ok(tree.includes(' M bots/darwin/lib/implementor.ts'));
    assert.ok(tree.includes(`?? ${outScopeUntracked}`));

    runner.cleanupUnexpectedUntracked(status.split('\n'), '', ['bots/claude']);
    assert.strictEqual(fs.existsSync(inScopeAbs), false);
    assert.strictEqual(fs.existsSync(outScopeAbs), true);
  } finally {
    fs.rmSync(inScopeAbs, { force: true });
    fs.rmSync(outScopeAbs, { force: true });
  }
  console.log('✅ refactor-cycle: mutation isolation ignores and preserves out-of-scope churn');
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

async function test_active_verifies_and_restores_without_apply() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = 'bots/claude/lib/agent-heartbeat.ts';
  const absoluteTarget = path.join(PROJECT_ROOT, target);
  const before = fs.readFileSync(absoluteTarget, 'utf8');
  const calls = { builder: [], reviewer: [] };
  const builderModule = {
    async runTargetedTypeCheck(files, options) {
      calls.builder.push(options);
      assert.deepStrictEqual(files, [target]);
      assert.deepStrictEqual(options.files, [target]);
      assert.strictEqual(options.force, true);
      assert.strictEqual(options.test, true);
      return {
        pass: true,
        skipped: false,
        message: 'forced builder test',
        results: [{ pass: true, skipped: false, message: 'forced builder test' }],
      };
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
  assert.strictEqual(result.active.applied, false);
  assert.deepStrictEqual(result.active.applyResults, []);
  assert.strictEqual(result.steps.find((step) => step.id === 'commit').status, 'ready_for_review_apply_disabled');
  assert.strictEqual(fs.readFileSync(absoluteTarget, 'utf8'), before);
  console.log('✅ refactor-cycle: active verifies, captures patch, and restores without apply');
}

async function test_active_verify_skip_defers_and_restores() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = 'bots/claude/lib/agent-heartbeat.ts';
  const absoluteTarget = path.join(PROJECT_ROOT, target);
  const before = fs.readFileSync(absoluteTarget, 'utf8');
  const builderModule = {
    async runTargetedTypeCheck(files, options) {
      assert.deepStrictEqual(files, [target]);
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

async function test_apply_off_does_not_commit_and_restores() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
  const before = targetContent(target);
  const { builderModule, reviewerModule } = verifierModulesAlwaysPass(target);
  const commits = [];
  let result = null;
  try {
    result = await runner.runRefactorCycle({
      mode: 'active',
      target,
      dryRun: false,
      noMcp: true,
      noVaultFeedback: true,
      noHeartbeat: true,
      noWriteOutcome: true,
      allowDirtyWorktreeForTest: true,
      builderModule,
      reviewerModule,
      commitFileFn: async (file, message) => {
        commits.push({ file, message });
        return 'unexpected';
      },
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.active.applied, false);
    assert.deepStrictEqual(result.active.applyResults, []);
    assert.deepStrictEqual(commits, []);
    assert.strictEqual(result.steps.find((step) => step.id === 'refactor').status, 'complete_restored');
    assert.strictEqual(result.steps.find((step) => step.id === 'commit').status, 'ready_for_review_apply_disabled');
    assert.strictEqual(targetContent(target), before);
  } finally {
    fs.writeFileSync(path.join(PROJECT_ROOT, target), before, 'utf8');
    cleanupRefactorArtifacts(result);
  }
  console.log('✅ refactor-cycle: apply off does not commit and restores ready changes');
}

async function test_apply_on_commits_ready_file_and_keeps_change() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
  const before = targetContent(target);
  const { builderModule, reviewerModule } = verifierModulesAlwaysPass(target);
  const commits = [];
  const pushes = [];
  const originChecks = [];
  let result = null;
  try {
    result = await runner.runRefactorCycle({
      mode: 'active',
      target,
      dryRun: false,
      noMcp: true,
      noVaultFeedback: true,
      noHeartbeat: true,
      noWriteOutcome: true,
      allowDirtyWorktreeForTest: true,
      applyEnabled: true,
      builderModule,
      reviewerModule,
      strictCheckFn: async () => strictPass(),
      currentHeadFn: async () => 'before-apply-sha',
      rollbackFn: async () => {
        throw new Error('rollback should not be called');
      },
      pushFn: async (params) => {
        pushes.push(params);
        return { ok: true };
      },
      originContainsFn: async (sha) => {
        originChecks.push(sha);
        return true;
      },
      commitFileFn: async (file, message) => {
        commits.push({ file, message });
        return 'fake-sha-apply';
      },
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.active.applied, true);
    assert.deepStrictEqual(result.active.applyResults, [{ file: target, applied: true, commit: 'fake-sha-apply', pushed: true, originContains: true }]);
    assert.strictEqual(commits.length, 1);
    assert.strictEqual(pushes.length, 1);
    assert.strictEqual(pushes[0].commit, 'fake-sha-apply');
    assert.deepStrictEqual(originChecks, ['fake-sha-apply']);
    assert.strictEqual(commits[0].file, target);
    assert.match(commits[0].message, /refactor\(ts\): drop @ts-nocheck/);
    assert.notStrictEqual(targetContent(target), before);
    assert.strictEqual(result.steps.find((step) => step.id === 'refactor').status, 'complete_applied');
    assert.strictEqual(result.steps.find((step) => step.id === 'commit').status, 'committed:fake-sha-apply');
  } finally {
    fs.writeFileSync(path.join(PROJECT_ROOT, target), before, 'utf8');
    cleanupRefactorArtifacts(result);
  }
  console.log('✅ refactor-cycle: apply on commits ready file and keeps the verified mutation');
}

async function test_default_commit_file_is_path_scoped() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const calls = [];
  const sha = runner.defaultCommitFile(ACTIVE_TARGET, 'mock commit', (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return 'fake-default-sha\n';
    return '';
  });
  assert.strictEqual(sha, 'fake-default-sha');
  assert.deepStrictEqual(calls[0], ['add', '--', ACTIVE_TARGET]);
  assert.deepStrictEqual(calls[1], ['commit', '-m', 'mock commit', '--', ACTIVE_TARGET]);
  assert.deepStrictEqual(calls[2], ['rev-parse', 'HEAD']);
  assert.ok(!calls.flat().includes('-A'));
  assert.ok(!calls.flat().includes('-a'));
  console.log('✅ refactor-cycle: default apply commit is path-scoped and avoids broad staging');
}

async function test_apply_on_verify_fail_does_not_commit_and_restores() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
  const before = targetContent(target);
  const reviewerModule = reviewerModuleAlwaysPass(target);
  const commits = [];
  let result = null;
  try {
    result = await runner.runRefactorCycle({
      mode: 'active',
      target,
      dryRun: false,
      noMcp: true,
      noVaultFeedback: true,
      noHeartbeat: true,
      noWriteOutcome: true,
      allowDirtyWorktreeForTest: true,
      applyEnabled: true,
      builderModule: {
        async runTargetedTypeCheck() {
          return { pass: false, skipped: false, results: [{ pass: false, skipped: false, error: 'mock fail' }] };
        },
      },
      reviewerModule,
      commitFileFn: async (file, message) => {
        commits.push({ file, message });
        return 'unexpected';
      },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.active.applied, false);
    assert.deepStrictEqual(result.active.applyResults, []);
    assert.deepStrictEqual(commits, []);
    assert.strictEqual(targetContent(target), before);
  } finally {
    fs.writeFileSync(path.join(PROJECT_ROOT, target), before, 'utf8');
    cleanupRefactorArtifacts(result);
  }
  console.log('✅ refactor-cycle: apply on verify failure does not commit and restores');
}

async function test_apply_on_dry_run_does_not_commit_and_restores() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
  const before = targetContent(target);
  const { builderModule, reviewerModule } = verifierModulesAlwaysPass(target);
  const commits = [];
  const result = await runner.runRefactorCycle({
    mode: 'active',
    target,
    dryRun: true,
    noMcp: true,
    noVaultFeedback: true,
    noHeartbeat: true,
    noWriteOutcome: true,
    allowDirtyWorktreeForTest: true,
    applyEnabled: true,
    builderModule,
    reviewerModule,
    commitFileFn: async (file, message) => {
      commits.push({ file, message });
      return 'unexpected';
    },
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.active.applied, false);
  assert.deepStrictEqual(result.active.applyResults, []);
  assert.deepStrictEqual(commits, []);
  assert.strictEqual(targetContent(target), before);
  console.log('✅ refactor-cycle: apply enabled dry-run does not commit and restores');
}

async function test_apply_commit_failure_restores_and_reports_apply_failed() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
  const before = targetContent(target);
  const { builderModule, reviewerModule } = verifierModulesAlwaysPass(target);
  const commits = [];
  const rollbacks = [];
  let result = null;
  try {
    result = await runner.runRefactorCycle({
      mode: 'active',
      target,
      dryRun: false,
      noMcp: true,
      noVaultFeedback: true,
      noHeartbeat: true,
      noWriteOutcome: true,
      allowDirtyWorktreeForTest: true,
      applyEnabled: true,
      builderModule,
      reviewerModule,
      strictCheckFn: async () => strictPass(),
      currentHeadFn: async () => 'before-commit-failure-sha',
      rollbackFn: async (head) => {
        rollbacks.push(head);
        return { ok: true };
      },
      commitFileFn: async (file, message) => {
        commits.push({ file, message });
        throw new Error('mock commit failed');
      },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.active.stage, 'active_deferred');
    assert.strictEqual(result.active.applied, false);
    assert.strictEqual(result.active.applyResults.length, 1);
    assert.deepStrictEqual(result.active.applyResults[0], { file: target, applied: false, error: 'mock commit failed' });
    assert.strictEqual(result.active.results[0].stage, 'active_apply_failed');
    assert.match(result.active.results[0].errorSummary, /apply_failed/);
    assert.strictEqual(commits.length, 1);
    assert.deepStrictEqual(rollbacks, ['before-commit-failure-sha']);
    assert.strictEqual(targetContent(target), before);
  } finally {
    fs.writeFileSync(path.join(PROJECT_ROOT, target), before, 'utf8');
    cleanupRefactorArtifacts(result);
  }
  console.log('✅ refactor-cycle: apply commit failure restores and reports apply_failed');
}

async function test_apply_push_failure_rolls_back_and_reports_failed() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
  const before = targetContent(target);
  const { builderModule, reviewerModule } = verifierModulesAlwaysPass(target);
  const rollbacks = [];
  let result = null;
  try {
    result = await runner.runRefactorCycle({
      mode: 'active',
      target,
      dryRun: false,
      noMcp: true,
      noVaultFeedback: true,
      noHeartbeat: true,
      noWriteOutcome: true,
      allowDirtyWorktreeForTest: true,
      applyEnabled: true,
      builderModule,
      reviewerModule,
      strictCheckFn: async () => strictPass(),
      currentHeadFn: async () => 'before-push-failure-sha',
      rollbackFn: async (head) => {
        rollbacks.push(head);
        return { ok: true };
      },
      commitFileFn: async () => 'fake-sha-push-fail',
      pushFn: async () => ({ ok: false, error: 'mock push failed' }),
      originContainsFn: async () => {
        throw new Error('origin check should not run after push failure');
      },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.active.applied, false);
    assert.strictEqual(result.active.results[0].stage, 'active_apply_failed');
    assert.deepStrictEqual(result.active.applyResults[0], { file: target, applied: false, error: 'mock push failed' });
    assert.deepStrictEqual(rollbacks, ['before-push-failure-sha']);
    assert.strictEqual(targetContent(target), before);
  } finally {
    fs.writeFileSync(path.join(PROJECT_ROOT, target), before, 'utf8');
    cleanupRefactorArtifacts(result);
  }
  console.log('✅ refactor-cycle: apply push failure rolls back local commit and reports failed');
}

async function test_apply_strict_failure_defers_before_commit() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
  const before = targetContent(target);
  const { builderModule, reviewerModule } = verifierModulesAlwaysPass(target);
  const commits = [];
  let result = null;
  try {
    result = await runner.runRefactorCycle({
      mode: 'active',
      target,
      dryRun: false,
      noMcp: true,
      noVaultFeedback: true,
      noHeartbeat: true,
      noWriteOutcome: true,
      allowDirtyWorktreeForTest: true,
      applyEnabled: true,
      builderModule,
      reviewerModule,
      strictCheckFn: async () => ({ pass: false, skipped: false, error: 'mock strict failed' }),
      commitFileFn: async (file, message) => {
        commits.push({ file, message });
        return 'unexpected';
      },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.active.applied, false);
    assert.strictEqual(result.active.results[0].stage, 'active_deferred_strict_failed');
    assert.deepStrictEqual(result.active.applyResults[0], {
      file: target,
      applied: false,
      reason: 'strict_failed',
      error: 'mock strict failed',
    });
    assert.deepStrictEqual(commits, []);
    assert.strictEqual(targetContent(target), before);
  } finally {
    fs.writeFileSync(path.join(PROJECT_ROOT, target), before, 'utf8');
    cleanupRefactorArtifacts(result);
  }
  console.log('✅ refactor-cycle: strict gate failure defers before commit');
}

async function test_apply_lock_fresh_skips_stale_proceeds_and_releases() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
  const lockPath = path.join(PROJECT_ROOT, 'bots/claude/__tests__/tmp-refactorer-active.lock');
  fs.rmSync(lockPath, { force: true });
  fs.writeFileSync(lockPath, 'fresh lock\n', 'utf8');
  const fresh = await runner.runRefactorCycle({
    mode: 'active',
    target,
    dryRun: true,
    noMcp: true,
    noVaultFeedback: true,
    noHeartbeat: true,
    noWriteOutcome: true,
    allowDirtyWorktreeForTest: true,
    applyEnabled: true,
    lockPath,
  });
  assert.strictEqual(fresh.skipped, true);
  assert.strictEqual(fresh.reason, 'another_cycle_active');
  assert.strictEqual(fs.existsSync(lockPath), true);

  const staleDate = new Date(Date.now() - (11 * 60 * 1000));
  fs.utimesSync(lockPath, staleDate, staleDate);
  const { builderModule, reviewerModule } = verifierModulesAlwaysPass(target);
  const stale = await runner.runRefactorCycle({
    mode: 'active',
    target,
    dryRun: true,
    noMcp: true,
    noVaultFeedback: true,
    noHeartbeat: true,
    noWriteOutcome: true,
    allowDirtyWorktreeForTest: true,
    applyEnabled: true,
    lockPath,
    builderModule,
    reviewerModule,
  });
  assert.notStrictEqual(stale.reason, 'another_cycle_active');
  assert.strictEqual(fs.existsSync(lockPath), false);
  console.log('✅ refactor-cycle: active apply lock skips fresh, replaces stale, and releases');
}

async function test_apply_rate_limit_defers_extra_ready_files() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const targetDir = 'bots/claude/__tests__/tmp-refactor-rate-limit';
  const absDir = path.join(PROJECT_ROOT, targetDir);
  const fileA = `${targetDir}/a.ts`;
  const fileB = `${targetDir}/b.ts`;
  fs.rmSync(absDir, { recursive: true, force: true });
  fs.mkdirSync(absDir, { recursive: true });
  fs.writeFileSync(path.join(PROJECT_ROOT, fileA), '// @ts-nocheck\nexport const a = 1;\n', 'utf8');
  fs.writeFileSync(path.join(PROJECT_ROOT, fileB), '// @ts-nocheck\nexport const b = 2;\n', 'utf8');
  const commits = [];
  let result = null;
  try {
    result = await runner.runRefactorCycle({
      mode: 'active',
      target: targetDir,
      dryRun: false,
      noMcp: true,
      noVaultFeedback: true,
      noHeartbeat: true,
      noWriteOutcome: true,
      allowDirtyWorktreeForTest: true,
      applyEnabled: true,
      applyMaxPerCycle: 1,
      activeMaxFiles: 2,
      builderModule: {
        async runTargetedTypeCheck(files, options) {
          assert.strictEqual(files.length, 1);
          assert.deepStrictEqual(options.files, files);
          return { pass: true, skipped: false, results: [{ pass: true, skipped: false }] };
        },
      },
      reviewerModule: {
        async runReview(options) {
          assert.strictEqual(options.files.length, 1);
          return { pass: true, skipped: false, summary: { high: 0, critical: 0 }, findings: [], sent: false };
        },
      },
      strictCheckFn: async () => strictPass(),
      currentHeadFn: async () => 'before-rate-limit-sha',
      rollbackFn: async () => ({ ok: true }),
      pushFn: async () => ({ ok: true }),
      originContainsFn: async () => true,
      commitFileFn: async (file) => {
        commits.push(file);
        return `sha-${commits.length}`;
      },
    });
    assert.strictEqual(result.active.stage, 'active_partial');
    assert.strictEqual(result.active.applyResults.length, 2);
    assert.strictEqual(result.active.applyResults.filter((item) => item.applied).length, 1);
    assert.strictEqual(result.active.applyResults.filter((item) => item.reason === 'rate_limited').length, 1);
    assert.strictEqual(commits.length, 1);
  } finally {
    fs.rmSync(absDir, { recursive: true, force: true });
    cleanupRefactorArtifacts(result);
  }
  console.log('✅ refactor-cycle: apply max-per-cycle rate limits extra ready files');
}

async function test_builder_all_skipped_defers() {
  const result = await runActiveWithBuilderResult({
    pass: true,
    skipped: true,
    message: 'all skipped',
    results: [{ pass: true, skipped: true, message: 'tsconfig missing' }],
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.active.stage, 'active_deferred');
  assert.strictEqual(result.active.results[0].verify.builderSkipped, true);
  assert.strictEqual(result.active.results[0].verify.builderSkipReason, 'build_not_executed');
  assert.match(result.active.results[0].errorSummary, /builder_skipped=true/);
  console.log('✅ refactor-cycle: all-skipped builder results defer instead of false-accept');
}

async function test_builder_no_results_skipped_defers() {
  const result = await runActiveWithBuilderResult({
    pass: true,
    skipped: true,
    message: 'no build plan',
    results: [],
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.active.stage, 'active_deferred');
  assert.strictEqual(result.active.results[0].verify.builderSkipped, true);
  assert.strictEqual(result.active.results[0].verify.builderSkipReason, 'no_build_plan');
  console.log('✅ refactor-cycle: no-result skipped builder defers');
}

async function test_builder_executed_pass_still_ready() {
  const result = await runActiveWithBuilderResult({
    pass: true,
    skipped: false,
    message: 'actual build passed',
    results: [{ pass: true, skipped: false, message: 'tsc passed' }],
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.active.stage, 'active_verified_ready_for_commit');
  assert.strictEqual(result.active.results[0].verify.builderSkipped, false);
  assert.strictEqual(result.active.results[0].verify.builderSkipReason, null);
  console.log('✅ refactor-cycle: executed passing builder remains ready');
}

async function test_builder_executed_fail_defers() {
  const result = await runActiveWithBuilderResult({
    pass: false,
    skipped: false,
    message: 'actual build failed',
    results: [{ pass: false, skipped: false, message: 'tsc failed' }],
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.active.stage, 'active_deferred');
  assert.strictEqual(result.active.results[0].verify.builderSkipped, false);
  assert.strictEqual(result.active.results[0].verify.builderPass, false);
  assert.strictEqual(result.active.results[0].verify.builderSkipReason, null);
  console.log('✅ refactor-cycle: executed failing builder defers');
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
    gitStatusShortFn: () => '',
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
    gitStatusShortFn: () => '',
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

async function test_autofix_prior_errors_filter_and_cap() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
  const feedback = {
    results: [
      {
        file: target,
        stage: 'active_deferred',
        outcome: 'failed',
        errorSummary: 'stage=verify; builder=TS2339 first failure; reviewer=ok',
      },
      {
        candidateFiles: [target],
        stage: 'active_deferred_unfixable',
        outcome: 'failed',
        errorSummary: 'stage=autofix; builder=TS2345 second failure',
      },
      {
        changedFiles: [target],
        stage: 'active_deferred',
        outcome: 'failed',
        errorSummary: 'stage=verify; builder=TS2345 second failure',
      },
      {
        target,
        stage: 'active_deferred',
        outcome: 'error',
        errorSummary: 'stage=verify; builder=TS7006 third failure',
      },
      {
        file: target,
        stage: 'active_deferred',
        outcome: 'failed',
        errorSummary: 'stage=verify; builder=TS9999 fourth failure',
      },
      {
        file: target,
        stage: 'active_verified_ready_for_commit',
        outcome: 'completed',
        errorSummary: 'stage=verify; builder=should be ignored',
      },
      {
        file: 'bots/claude/lib/other.ts',
        stage: 'active_deferred',
        outcome: 'failed',
        errorSummary: 'stage=verify; builder=other file ignored',
      },
      {
        file: target,
        stage: 'active_deferred',
        outcome: 'failed',
        errorSummary: '',
      },
    ],
  };
  assert.deepStrictEqual(runner.deriveFilePriorErrors(feedback, target), [
    'TS2339 first failure',
    'TS2345 second failure',
    'TS7006 third failure',
  ]);
  assert.deepStrictEqual(runner.deriveFilePriorErrors(feedback, target, 2), [
    'TS2339 first failure',
    'TS2345 second failure',
  ]);
  console.log('✅ refactor-cycle: autofix prior errors filter successful rows, dedupe, and cap');
}

async function test_autofix_prior_errors_are_passed_to_fixer() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
  const before = targetContent(target);
  const { calls, builderModule, reviewerModule } = verifierModulesForAutofix(target);
  const captured = [];
  const result = await runner.runRefactorCycle({
    mode: 'active',
    target,
    dryRun: true,
    noMcp: true,
    noHeartbeat: true,
    noWriteOutcome: true,
    allowDirtyWorktreeForTest: true,
    autofixEnabled: true,
    gitStatusShortFn: () => '',
    vaultFeedback: {
      ok: true,
      results: [{
        file: target,
        stage: 'active_deferred',
        outcome: 'failed',
        errorSummary: 'stage=verify; builder=TS2339 prior file error; reviewer=ok',
      }],
    },
    builderModule,
    reviewerModule,
    fixerFn: async (_context, params) => {
      captured.push(params.priorErrors);
      return {
        ok: true,
        fixedContent: `${params.currentContent}\n${AUTOFIX_MARKER}\n`,
        model: 'mock-refactorer',
        provider: 'mock',
      };
    },
  });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(captured, [['TS2339 prior file error']]);
  assert.strictEqual(result.active.results[0].priorErrorCount, 1);
  assert.strictEqual(calls.builder.length, 2);
  assert.strictEqual(calls.reviewer.length, 2);
  assert.strictEqual(targetContent(target), before);
  console.log('✅ refactor-cycle: prior errors are passed to autofix fixer params');
}

async function test_autofix_empty_vault_feedback_passes_empty_prior_errors() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
  const before = targetContent(target);
  const { builderModule, reviewerModule } = verifierModulesForAutofix(target);
  const captured = [];
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
    gitStatusShortFn: () => '',
    builderModule,
    reviewerModule,
    fixerFn: async (_context, params) => {
      captured.push(params.priorErrors);
      return {
        ok: true,
        fixedContent: `${params.currentContent}\n${AUTOFIX_MARKER}\n`,
        model: 'mock-refactorer',
        provider: 'mock',
      };
    },
  });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(captured, [[]]);
  assert.strictEqual(result.active.results[0].priorErrorCount, 0);
  assert.strictEqual(targetContent(target), before);
  console.log('✅ refactor-cycle: empty vault feedback keeps autofix priorErrors empty');
}

async function test_autofix_fixer_prompt_includes_prior_failure_section() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const withPrior = runner.buildFixerPrompt({
    fileRel: ACTIVE_TARGET,
    currentContent: 'export const value = 1;\n',
    builderError: 'TS2339 current',
    reviewerFindings: [],
    priorErrors: ['TS2339 previous', 'TS7006 previous'],
    attempt: 1,
  });
  assert.match(withPrior, /Prior failures for THIS file/);
  assert.match(withPrior, /1\. TS2339 previous/);
  assert.match(withPrior, /2\. TS7006 previous/);
  assert.doesNotMatch(withPrior, /@ts-nocheck/);

  const withoutPrior = runner.buildFixerPrompt({
    fileRel: ACTIVE_TARGET,
    currentContent: 'export const value = 1;\n',
    builderError: '',
    reviewerFindings: [],
    priorErrors: [],
    attempt: 1,
  });
  assert.match(withoutPrior, /Prior failures for THIS file/);
  assert.match(withoutPrior, /\(none\)/);
  console.log('✅ refactor-cycle: fixer prompt includes prior failure advisory section');
}

async function test_targeted_typecheck_finds_nearest_tsconfig() {
  const builder = requireBuilder();
  const claudeConfig = path.relative(PROJECT_ROOT, builder.findNearestTsconfig('bots/claude/src/builder.ts')).replace(/\\/g, '/');
  const coreConfig = path.relative(PROJECT_ROOT, builder.findNearestTsconfig('packages/core/lib/news-credentials.legacy.ts')).replace(/\\/g, '/');
  assert.strictEqual(claudeConfig, 'bots/claude/tsconfig.json');
  assert.strictEqual(coreConfig, 'tsconfig.json');
  console.log('✅ builder: targeted typecheck resolves nearest tsconfig with root fallback');
}

async function test_targeted_typecheck_empty_input_skips() {
  const builder = requireBuilder();
  const result = await builder.runTargetedTypeCheck([], { test: true });
  assert.strictEqual(result.pass, true);
  assert.strictEqual(result.skipped, true);
  assert.deepStrictEqual(result.results, []);
  console.log('✅ builder: targeted typecheck skips empty/non-TS input honestly');
}

async function test_targeted_typecheck_clean_and_error_files() {
  const builder = requireBuilder();
  resetTargetedTypecheckTmp();
  try {
    const clean = writeTmpTsFile('clean.ts', 'export const value: number = 1;\n');
    const cleanResult = await builder.runTargetedTypeCheck([clean], { test: true });
    assert.strictEqual(cleanResult.pass, true);
    assert.strictEqual(cleanResult.skipped, false);
    assert.strictEqual(cleanResult.results[0].skipped, false);

    const bad = writeTmpTsFile('bad.ts', 'export const value: number = "bad";\n');
    const badResult = await builder.runTargetedTypeCheck([bad], { test: true });
    assert.strictEqual(badResult.pass, false);
    assert.strictEqual(badResult.skipped, false);
    assert.match(badResult.results[0].error, /TS2322/);
  } finally {
    cleanupTargetedTypecheckTmp();
  }
  console.log('✅ builder: targeted typecheck passes clean files and fails target diagnostics');
}

async function test_targeted_typecheck_filters_dependency_errors() {
  const builder = requireBuilder();
  resetTargetedTypecheckTmp();
  try {
    writeTmpTsFile('bad-dep.ts', 'export const dep: number = "bad";\n');
    const target = writeTmpTsFile('target.ts', '/// <reference path="./bad-dep.ts" />\nexport const ok: number = 1;\n');
    const result = await builder.runTargetedTypeCheck([target], { test: true });
    assert.strictEqual(result.pass, true);
    assert.strictEqual(result.skipped, false);
    assert.match(result.results[0].message, /대상 파일 외 진단/);
  } finally {
    cleanupTargetedTypecheckTmp();
  }
  console.log('✅ builder: targeted typecheck filters non-target dependency diagnostics');
}

async function test_targeted_typecheck_respects_ts_nocheck_scope() {
  const builder = requireBuilder();
  resetTargetedTypecheckTmp();
  try {
    const target = writeTmpTsFile('nocheck.ts', '// @ts-nocheck\nexport const value: number = "bad";\n');
    const suppressed = await builder.runTargetedTypeCheck([target], { test: true });
    assert.strictEqual(suppressed.pass, true);

    const unsuppressed = writeTmpTsFile('nocheck.ts', 'export const value: number = "bad";\n');
    const failed = await builder.runTargetedTypeCheck([unsuppressed], { test: true });
    assert.strictEqual(failed.pass, false);
    assert.match(failed.results[0].error, /TS2322/);
  } finally {
    cleanupTargetedTypecheckTmp();
  }
  console.log('✅ builder: targeted typecheck treats @ts-nocheck as file-local only');
}

async function test_targeted_typecheck_temp_config_cleanup_and_gitignore() {
  const builder = requireBuilder();
  resetTargetedTypecheckTmp();
  try {
    const bad = writeTmpTsFile('cleanup-fail.ts', 'export const value: number = "bad";\n');
    const result = await builder.runTargetedTypeCheck([bad], { test: true });
    assert.strictEqual(result.pass, false);
    const leftovers = fs.readdirSync(PROJECT_ROOT).filter(name => /^\.refactorer-tscheck-.*\.json$/.test(name));
    assert.deepStrictEqual(leftovers, []);
    assert.match(fs.readFileSync(path.join(PROJECT_ROOT, '.gitignore'), 'utf8'), /^\.refactorer-tscheck-\*\.json$/m);
  } finally {
    cleanupTargetedTypecheckTmp();
  }
  console.log('✅ builder: targeted typecheck removes temp configs and gitignore covers them');
}

async function test_targeted_typecheck_command_failure_fails_closed() {
  const builder = requireBuilder();
  resetTargetedTypecheckTmp();
  try {
    const clean = writeTmpTsFile('timeout.ts', 'export const value: number = 1;\n');
    const result = await builder.runTargetedTypeCheck([clean], { test: true, timeout: 1 });
    assert.strictEqual(result.pass, false);
    assert.strictEqual(result.skipped, false);
    assert.match(result.results[0].error, /timed out|SIGTERM|ETIMEDOUT|spawnSync/i);
  } finally {
    cleanupTargetedTypecheckTmp();
  }
  console.log('✅ builder: targeted typecheck fails closed on tsc command failures');
}

async function main() {
  console.log('=== Refactor Cycle Runner 테스트 시작 ===\n');
  const tests = [
    test_mode_defaults_off,
    test_cycle_stamp_uses_kst,
    test_protected_target_guard,
    test_protected_descendants_are_excluded_from_analysis,
    test_dirty_scope_helpers,
    test_dirty_scope_guard_ignores_other_workspace_dirty,
    test_dirty_scope_guard_blocks_target_workspace_dirty,
    test_dirty_scope_tree_mode_preserves_full_tree_guard,
    test_dirty_scope_mutation_isolation_and_cleanup,
    test_shadow_dry_run_analyze_plan_only,
    test_plan_includes_sigma_feedback_context,
    test_active_verifies_and_restores_without_apply,
    test_active_verify_skip_defers_and_restores,
    test_apply_off_does_not_commit_and_restores,
    test_apply_on_commits_ready_file_and_keeps_change,
    test_default_commit_file_is_path_scoped,
    test_apply_on_verify_fail_does_not_commit_and_restores,
    test_apply_on_dry_run_does_not_commit_and_restores,
    test_apply_commit_failure_restores_and_reports_apply_failed,
    test_apply_push_failure_rolls_back_and_reports_failed,
    test_apply_strict_failure_defers_before_commit,
    test_apply_lock_fresh_skips_stale_proceeds_and_releases,
    test_apply_rate_limit_defers_extra_ready_files,
    test_builder_all_skipped_defers,
    test_builder_no_results_skipped_defers,
    test_builder_executed_pass_still_ready,
    test_builder_executed_fail_defers,
    test_autofix_off_preserves_phase3_defer,
    test_autofix_success_captures_patch_and_restores,
    test_autofix_failure_defers_unfixable_and_restores,
    test_autofix_rejects_unexpected_mutation,
    test_autofix_prior_errors_filter_and_cap,
    test_autofix_prior_errors_are_passed_to_fixer,
    test_autofix_empty_vault_feedback_passes_empty_prior_errors,
    test_autofix_fixer_prompt_includes_prior_failure_section,
    test_targeted_typecheck_finds_nearest_tsconfig,
    test_targeted_typecheck_empty_input_skips,
    test_targeted_typecheck_clean_and_error_files,
    test_targeted_typecheck_filters_dependency_errors,
    test_targeted_typecheck_respects_ts_nocheck_scope,
    test_targeted_typecheck_temp_config_cleanup_and_gitignore,
    test_targeted_typecheck_command_failure_fails_closed,
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
