'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RUNNER_PATH = path.resolve(__dirname, '../scripts/refactor-cycle-runner.ts');
const NODE_CHECK_HOOK_PATH = path.resolve(__dirname, '../hooks/refactor-hooks/node-check-hook.ts');
const BUILDER_PATH = path.resolve(__dirname, '../src/builder.ts');
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const ACTIVE_TARGET = 'bots/claude/__tests__/fixtures/refactor-cycle-active-target.ts';
const ACTIVE_TARGET_CONTENT = [
  '// @ts-nocheck',
  "'use strict';",
  '',
  'export function refactorCycleFixture(input) {',
  "  return String(input || 'ok');",
  '}',
  '',
].join('\n');
const AUTOFIX_MARKER = 'const __refactorAutofixFixture = true;';
const TARGETED_TSC_TMP_DIR = path.join(PROJECT_ROOT, 'packages/core/lib/tmp-refactorer-targeted-typecheck');

function ensureActiveTarget() {
  const absolute = path.join(PROJECT_ROOT, ACTIVE_TARGET);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, ACTIVE_TARGET_CONTENT, 'utf8');
}

function cleanupActiveTarget() {
  ensureActiveTarget();
}

function targetContent(target = ACTIVE_TARGET) {
  return fs.readFileSync(path.join(PROJECT_ROOT, target), 'utf8');
}

function finalNewline(content) {
  if (content.endsWith('\r\n')) return '\r\n';
  if (content.endsWith('\n')) return '\n';
  return '';
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

function strictError(file, code, message = 'mock strict error') {
  return `${file}(1,1): error TS${code}: ${message}`;
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

async function test_safe_deferred_cycle_uses_soft_operational_status() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);

  const safeDeferred = {
    ok: false,
    mode: 'active',
    active: {
      applied: false,
      worktreeRestored: true,
      stage: 'active_deferred',
    },
  };
  assert.strictEqual(runner.heartbeatStatusForCycleResult(safeDeferred), 'warn');
  assert.strictEqual(runner.exitCodeForCycleResult(safeDeferred), 0);

  const unsafeDeferred = {
    ok: false,
    mode: 'active',
    active: {
      applied: false,
      worktreeRestored: false,
      stage: 'active_deferred',
    },
  };
  assert.strictEqual(runner.heartbeatStatusForCycleResult(unsafeDeferred), 'error');
  assert.strictEqual(runner.exitCodeForCycleResult(unsafeDeferred), 1);

  console.log('✅ refactor-cycle: safe deferred cycles avoid operational heartbeat failure');
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

async function test_active_candidates_skip_non_production_fixtures() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const analysis = {
    candidates: [
      {
        file: 'bots/claude/__tests__/fixtures/refactor-cycle-active-target.ts',
        lines: 8,
        refactorType: 'ts_nocheck',
      },
      {
        file: 'bots/claude/lib/symphony/workspace-adapter.ts',
        lines: 30,
        refactorType: 'ts_nocheck',
      },
    ],
  };

  const production = runner.selectActiveCandidates(analysis, 'ts_nocheck', 1, new Set());
  assert.deepStrictEqual(production.map((item) => item.file), ['bots/claude/lib/symphony/workspace-adapter.ts']);
  assert.strictEqual(runner.isNonProductionRefactorCandidate('bots/claude/__tests__/fixtures/refactor-cycle-active-target.ts'), true);

  const testHarness = runner.selectActiveCandidates(analysis, 'ts_nocheck', 1, new Set(), {
    allowNonProductionCandidates: true,
  });
  assert.deepStrictEqual(testHarness.map((item) => item.file), ['bots/claude/__tests__/fixtures/refactor-cycle-active-target.ts']);

  console.log('✅ refactor-cycle: active production candidates skip test fixtures');
}

async function test_active_candidates_validate_current_ts_nocheck_state() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const analysis = {
    candidates: [
      {
        file: 'bots/claude/hooks/refactor-hooks/type-check-hook.ts',
        lines: 51,
        refactorType: 'ts_nocheck',
        score: 90,
      },
      {
        file: ACTIVE_TARGET,
        lines: 8,
        refactorType: 'ts_nocheck',
        score: 80,
      },
    ],
  };

  const selected = runner.selectActiveCandidates(analysis, 'ts_nocheck', 1, new Set(), {
    allowNonProductionCandidates: true,
    validateCurrentState: true,
  });
  assert.deepStrictEqual(selected.map((item) => item.file), [ACTIVE_TARGET]);
  const detailed = runner.selectActiveCandidatesDetailed(analysis, 'ts_nocheck', 1, new Set(), {
    allowNonProductionCandidates: true,
    validateCurrentState: true,
  });
  assert.deepStrictEqual(detailed.selected.map((item) => item.file), [ACTIVE_TARGET]);
  assert.strictEqual(detailed.diagnostics.staleSkipped, 1);
  assert.strictEqual(detailed.diagnostics.skippedByReason.current_state_mismatch, 1);
  console.log('✅ refactor-cycle: active candidates skip stale ts-nocheck analysis rows');
}

async function test_active_candidates_skip_ts_extension_import_until_gate_supports_it() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const targetDir = 'bots/claude/__tests__/tmp-refactor-ts-extension-import';
  const absDir = path.join(PROJECT_ROOT, targetDir);
  const target = `${targetDir}/server.ts`;
  fs.rmSync(absDir, { recursive: true, force: true });
  fs.mkdirSync(absDir, { recursive: true });
  fs.writeFileSync(path.join(PROJECT_ROOT, target), [
    '// @ts-nocheck',
    "import { run } from '" + "./handler.ts';",
    'run();',
    '',
  ].join('\n'), 'utf8');
  try {
    const detailed = runner.selectActiveCandidatesDetailed({
      candidates: [{ file: target, lines: 3, refactorType: 'ts_nocheck' }],
    }, 'ts_nocheck', 1, new Set(), {
      allowNonProductionCandidates: true,
      validateCurrentState: true,
    });
    assert.deepStrictEqual(detailed.selected, []);
    assert.strictEqual(detailed.diagnostics.skippedByReason.unsupported_ts_extension_import, 1);
  } finally {
    fs.rmSync(absDir, { recursive: true, force: true });
  }
  console.log('✅ refactor-cycle: active candidates skip .ts extension imports until targeted gate supports them');
}

async function test_local_refactor_history_avoids_repeated_failed_candidates() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const historyDir = path.join(PROJECT_ROOT, 'bots/claude/__tests__/tmp-refactor-history');
  fs.rmSync(historyDir, { recursive: true, force: true });
  fs.mkdirSync(historyDir, { recursive: true });
  const failedPlan = (id) => [
    `# Refactor Active Cycle — ${id}`,
    '',
    '## Active Results',
    '- applied: false',
    '- operational_success: false',
    '',
    '## Verification Summary',
    '### Candidate 1: bots/claude/lib/mainbot-client.ts',
    '- stage: active_deferred_strict_failed',
    '- error_summary: stage=strict_gate; file=bots/claude/lib/mainbot-client.ts; error=stage=autofix; file=bots/claude/lib/mainbot-client.ts; error=verify_failed_after_2_attempts',
    '',
  ].join('\n');
  try {
    fs.writeFileSync(path.join(historyDir, 'REFACTOR_ACTIVE_bots_claude_refactor-a.md'), failedPlan('a'), 'utf8');
    fs.writeFileSync(path.join(historyDir, 'REFACTOR_ACTIVE_bots_claude_refactor-b.md'), failedPlan('b'), 'utf8');
    const parsed = runner.parseRefactorHistoryPlan(failedPlan('parsed'));
    assert.deepStrictEqual(parsed, ['bots/claude/lib/mainbot-client.ts']);
    const mixedParsed = runner.parseRefactorHistoryPlan([
      '# Refactor Active Cycle — mixed',
      '',
      '## Verification Summary',
      '### Candidate 1: bots/claude/lib/failed.ts',
      '- stage: active_deferred_strict_failed',
      '- applied: false',
      '- error_summary: stage=strict_gate; file=bots/claude/lib/failed.ts; error=verify_failed_after_2_attempts',
      '### Candidate 2: bots/claude/lib/success.ts',
      '- stage: active_verified_ready_for_commit',
      '- applied: true',
      '',
    ].join('\n'));
    assert.deepStrictEqual(mixedParsed, ['bots/claude/lib/failed.ts']);
    const avoided = runner.deriveAvoidedFilesFromLocalHistory({ historyDir, threshold: 2 });
    assert.strictEqual(avoided.has('bots/claude/lib/mainbot-client.ts'), true);
    assert.strictEqual(runner.mergeAvoidedFiles(new Set(['a']), avoided).has('a'), true);
  } finally {
    fs.rmSync(historyDir, { recursive: true, force: true });
  }
  console.log('✅ refactor-cycle: local failed plan history avoids repeated candidates');
}

async function test_active_cycle_skips_candidates_avoided_by_local_history() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const targetDir = 'bots/claude/tmp-refactor-history-cycle';
  const absDir = path.join(PROJECT_ROOT, targetDir);
  const historyDir = path.join(PROJECT_ROOT, 'bots/claude/__tests__/tmp-refactor-history-cycle-plans');
  const fileA = `${targetDir}/a.ts`;
  const fileB = `${targetDir}/b.ts`;
  fs.rmSync(absDir, { recursive: true, force: true });
  fs.rmSync(historyDir, { recursive: true, force: true });
  fs.mkdirSync(absDir, { recursive: true });
  fs.mkdirSync(historyDir, { recursive: true });
  fs.writeFileSync(path.join(PROJECT_ROOT, fileA), '// @ts-nocheck\nexport const a = 1;\n', 'utf8');
  fs.writeFileSync(path.join(PROJECT_ROOT, fileB), '// @ts-nocheck\nexport const b = 2;\n', 'utf8');
  const failedPlan = [
    '# Refactor Active Cycle — skipped-a',
    '',
    '## Active Results',
    '- applied: false',
    '- operational_success: false',
    '',
    '## Verification Summary',
    `### Candidate 1: ${fileA}`,
    '- stage: active_deferred_strict_failed',
    `- error_summary: stage=strict_gate; file=${fileA}; error=stage=autofix; error=verify_failed_after_2_attempts`,
    '',
  ].join('\n');
  let result = null;
  try {
    fs.writeFileSync(path.join(historyDir, 'REFACTOR_ACTIVE_skip-a-1.md'), failedPlan, 'utf8');
    fs.writeFileSync(path.join(historyDir, 'REFACTOR_ACTIVE_skip-a-2.md'), failedPlan, 'utf8');
    result = await runner.runRefactorCycle({
      mode: 'active',
      target: targetDir,
      dryRun: true,
      noMcp: true,
      noVaultFeedback: true,
      noHeartbeat: true,
      noWriteOutcome: true,
      allowDirtyWorktreeForTest: true,
      allowNonProductionCandidatesForTest: true,
      refactorHistoryDir: historyDir,
      localHistoryAvoidanceEnabled: true,
      builderModule: {
        async runTargetedTypeCheck(files, options) {
          assert.deepStrictEqual(files, [fileB]);
          assert.deepStrictEqual(options.files, [fileB]);
          return { pass: true, skipped: false, results: [{ pass: true, skipped: false }] };
        },
      },
      reviewerModule: {
        async runReview(options) {
          assert.deepStrictEqual(options.files, [fileB]);
          return { pass: true, skipped: false, summary: { high: 0, critical: 0 }, findings: [], sent: false };
        },
      },
    });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.plan.candidates.map((candidate) => candidate.file), [fileB]);
    assert.strictEqual(result.plan.localHistoryAvoidedFiles.includes(fileA), true);
    assert.strictEqual(result.plan.candidateDiagnostics.skippedByReason.sigma_feedback_avoided, 1);
  } finally {
    fs.rmSync(absDir, { recursive: true, force: true });
    fs.rmSync(historyDir, { recursive: true, force: true });
    cleanupRefactorArtifacts(result);
  }
  console.log('✅ refactor-cycle: active cycle skips local-history avoided candidates');
}

async function test_active_candidates_prefer_higher_score_over_smaller_file() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const analysis = {
    candidates: [
      {
        file: 'bots/claude/lib/low-score.ts',
        lines: 5,
        refactorType: 'ts_nocheck',
        score: 30,
      },
      {
        file: 'bots/claude/lib/high-score.ts',
        lines: 20,
        refactorType: 'ts_nocheck',
        score: 90,
      },
    ],
  };
  const selected = runner.selectActiveCandidatesDetailed(analysis, 'ts_nocheck', 1, new Set(), {
    allowNonProductionCandidates: true,
  });
  assert.strictEqual(selected.selected[0].score, 90);
  console.log('✅ refactor-cycle: candidate scoring prefers higher success score over smaller files');
}

async function test_ts2365_classifier_requires_manual_or_targeted_fixer() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const classified = runner.classifyFixerCapability({
    errorText: "file.ts(1,1): error TS2365: Operator '<' cannot be applied to types 'string' and 'number'.",
    lines: 20,
    bytes: 800,
  });
  assert.deepStrictEqual(classified.errorCodes, ['TS2365']);
  assert.strictEqual(classified.fixerCapability, 'manual_required');
  assert.strictEqual(classified.failureClass, 'autofix_capability_gap');
  assert.match(classified.nextAction, /local_fixer|manual/);
  const shapeTs2339 = runner.classifyFixerCapability({
    errorText: "file.ts(2,3): error TS2339: Property 'from_bot' does not exist on type '{ team?: string; }'.",
    lines: 20,
    bytes: 800,
  });
  assert.deepStrictEqual(shapeTs2339.errorCodes, ['TS2339']);
  assert.strictEqual(shapeTs2339.fixerCapability, 'manual_required');
  assert.strictEqual(shapeTs2339.failureClass, 'autofix_capability_gap');
  const unknownTs2339 = runner.classifyFixerCapability({
    errorText: "file.ts(2,3): error TS2339: Property 'message' does not exist on type 'unknown'.",
    lines: 20,
    bytes: 800,
  });
  assert.deepStrictEqual(unknownTs2339.errorCodes, ['TS2339']);
  assert.strictEqual(unknownTs2339.fixerCapability, 'local_supported');
  console.log('✅ refactor-cycle: TS2365 and shape TS2339 are classified as manual/targeted-fixer required');
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
    allowNonProductionCandidatesForTest: true,
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
  const fullStatus = ` M bots/darwin/lib/implementor.ts\n M ${ACTIVE_TARGET}`;
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
      if (prefixes.includes('bots/claude')) return ` M ${ACTIVE_TARGET}`;
      if (prefixes.includes(target)) return ` M ${ACTIVE_TARGET}`;
      return fullStatus;
    },
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.blocked, true);
  assert.strictEqual(result.reason, 'dirty_worktree_in_scope');
  assert.strictEqual(result.dirtyScope, 'workspace');
  assert.deepStrictEqual(result.scope, ['bots/claude']);
  assert.match(result.gitStatus, /bots\/claude\/__tests__\/fixtures\/refactor-cycle-active-target\.ts/);
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
    target: ACTIVE_TARGET,
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
    target: ACTIVE_TARGET,
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
  const target = ACTIVE_TARGET;
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
  const target = ACTIVE_TARGET;
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
    assert.strictEqual(result.active.operational.success, false);
    assert.strictEqual(result.active.operational.outcomeClass, 'verified_not_applied');
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
    assert.strictEqual(result.active.operational.success, true);
    assert.strictEqual(result.active.operational.outcomeClass, 'operational_success');
    assert.deepStrictEqual(result.active.operational.commits, ['fake-sha-apply']);
    assert.deepStrictEqual(result.active.operational.originVerifiedCommits, ['fake-sha-apply']);
    assert.strictEqual(result.active.candidateDiagnostics.selected, 1);
    assert.strictEqual(result.plan.candidateDiagnostics.selected, 1);
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

async function test_origin_contains_checks_current_branch_when_main_is_stale() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const calls = [];
  const ok = runner.defaultOriginContainsCommit('pushed-sha', (args) => {
    calls.push(args);
    const key = args.join(' ');
    if (key === 'rev-parse --abbrev-ref HEAD') return 'codex/refactor-test\n';
    if (key === 'rev-parse --abbrev-ref --symbolic-full-name @{u}') return 'origin/codex/refactor-test\n';
    if (key === 'fetch origin') throw new Error('transient fetch failure');
    if (key === 'merge-base --is-ancestor pushed-sha origin/main') throw new Error('main stale');
    if (key === 'merge-base --is-ancestor pushed-sha origin/codex/refactor-test') return '';
    throw new Error(`unexpected git call: ${key}`);
  });
  assert.strictEqual(ok, true);
  assert.ok(calls.some((args) => args.join(' ') === 'fetch origin'));
  assert.ok(calls.some((args) => args.join(' ') === 'merge-base --is-ancestor pushed-sha origin/codex/refactor-test'));
  console.log('✅ refactor-cycle: push verification accepts current upstream branch when main is stale');
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
      strictCheckFn: async () => strictPass(),
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

async function test_strict_autofix_success_commits_after_strict_recheck() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
  const before = targetContent(target);
  const { builderModule, reviewerModule } = verifierModulesAlwaysPass(target);
  const strictErrors = [
    "TS7006: Parameter 'name' implicitly has an 'any' type.",
  ];
  const strictCalls = [];
  const fixerSeeds = [];
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
      autofixEnabled: true,
      autofixMaxAttempts: 2,
      builderModule,
      reviewerModule,
      strictCheckFn: async () => {
        strictCalls.push(targetContent(target));
        if (strictCalls.length === 1) return { pass: false, skipped: false, error: strictErrors[0] };
        return strictPass();
      },
      fixerFn: async (_context, params) => {
        fixerSeeds.push(params.builderError);
        assert.match(params.builderError, /TS7006/);
        return {
          ok: true,
          fixedContent: `${params.currentContent}\n${AUTOFIX_MARKER}\n`,
          model: 'mock-strict-fixer',
          provider: 'mock',
        };
      },
      currentHeadFn: async () => 'before-strict-autofix-sha',
      rollbackFn: async () => {
        throw new Error('rollback should not be called');
      },
      pushFn: async () => ({ ok: true }),
      originContainsFn: async () => true,
      commitFileFn: async (file) => {
        commits.push(file);
        return 'fake-sha-strict-autofix';
      },
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.active.applied, true);
    assert.strictEqual(result.active.strictAutofixedCount, 1);
    assert.strictEqual(result.active.autofixedCount, 1);
    assert.strictEqual(result.active.results[0].stage, 'active_autofixed_ready_for_commit');
    assert.strictEqual(result.active.results[0].strictAutofixed, true);
    assert.strictEqual(result.active.results[0].autofixAttempts, 1);
    assert.strictEqual(result.active.results[0].strict.pass, true);
    assert.deepStrictEqual(commits, [target]);
    assert.strictEqual(strictCalls.length, 2);
    assert.strictEqual(fixerSeeds.length, 1);
    assert.notStrictEqual(targetContent(target), before);
  } finally {
    fs.writeFileSync(path.join(PROJECT_ROOT, target), before, 'utf8');
    cleanupRefactorArtifacts(result);
  }
  console.log('✅ refactor-cycle: strict autofix retries strict gate and commits only after pass');
}

async function test_strict_autofix_reviewer_high_blocks_commit() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
  const before = targetContent(target);
  const { builderModule } = verifierModulesAlwaysPass(target);
  let reviewerCalls = 0;
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
      autofixEnabled: true,
      autofixMaxAttempts: 1,
      builderModule,
      reviewerModule: {
        async runReview(options) {
          reviewerCalls += 1;
          assert.deepStrictEqual(options.files, [target]);
          if (reviewerCalls === 1) {
            return { pass: true, skipped: false, summary: { high: 0, critical: 0 }, findings: [], sent: false };
          }
          return {
            pass: false,
            skipped: false,
            summary: { high: 1, critical: 0 },
            findings: [{ severity: 'high', file: target, message: 'mock reviewer high after strict autofix' }],
            sent: false,
          };
        },
      },
      strictCheckFn: async () => {
        const content = targetContent(target);
        if (content.includes(AUTOFIX_MARKER)) return strictPass();
        return { pass: false, skipped: false, error: "TS7006: Parameter 'name' implicitly has an 'any' type." };
      },
      fixerFn: async (_context, params) => ({
        ok: true,
        fixedContent: `${params.currentContent}\n${AUTOFIX_MARKER}\n`,
        model: 'mock-strict-fixer',
        provider: 'mock',
      }),
      commitFileFn: async (file) => {
        commits.push(file);
        return 'unexpected';
      },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.active.applied, false);
    assert.strictEqual(result.active.results[0].stage, 'active_deferred_strict_failed');
    assert.strictEqual(result.active.results[0].verify.reviewerHigh, 1);
    assert.strictEqual(result.active.results[0].autofixAttempts, 1);
    assert.match(result.active.results[0].errorSummary, /reviewer_high=1|strict_autofix_failed|autofix/);
    assert.strictEqual(reviewerCalls, 2);
    assert.deepStrictEqual(commits, []);
    assert.strictEqual(targetContent(target), before);
  } finally {
    fs.writeFileSync(path.join(PROJECT_ROOT, target), before, 'utf8');
    cleanupRefactorArtifacts(result);
  }
  console.log('✅ refactor-cycle: strict autofix still requires reviewer gate before commit');
}

async function test_strict_autofix_failure_restores_and_defers_strict_failed() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
  const before = targetContent(target);
  const { builderModule, reviewerModule } = verifierModulesAlwaysPass(target);
  const commits = [];
  let fixerCalls = 0;
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
      autofixEnabled: true,
      autofixMaxAttempts: 1,
      builderModule,
      reviewerModule,
      strictCheckFn: async () => ({ pass: false, skipped: false, error: "TS7006: Parameter 'name' implicitly has an 'any' type." }),
      fixerFn: async (_context, params) => {
        fixerCalls += 1;
        return {
          ok: true,
          fixedContent: `${params.currentContent}\n${AUTOFIX_MARKER}\n`,
          model: 'mock-strict-fixer',
          provider: 'mock',
        };
      },
      commitFileFn: async (file) => {
        commits.push(file);
        return 'unexpected';
      },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.active.applied, false);
    assert.strictEqual(result.active.results[0].stage, 'active_deferred_strict_failed');
    assert.strictEqual(result.active.results[0].autofixAttempts, 1);
    assert.strictEqual(result.active.results[0].strictAutofixed, undefined);
    assert.strictEqual(result.active.applyResults[0].reason, 'strict_failed');
    assert.strictEqual(fixerCalls, 1);
    assert.deepStrictEqual(commits, []);
    assert.strictEqual(targetContent(target), before);
  } finally {
    fs.writeFileSync(path.join(PROJECT_ROOT, target), before, 'utf8');
    cleanupRefactorArtifacts(result);
  }
  console.log('✅ refactor-cycle: strict autofix failure restores snapshot and defers strict_failed');
}

async function test_strict_autofix_disabled_preserves_immediate_strict_defer() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
  const before = targetContent(target);
  const { builderModule, reviewerModule } = verifierModulesAlwaysPass(target);
  let fixerCalls = 0;
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
      autofixEnabled: true,
      strictAutofixEnabled: false,
      builderModule,
      reviewerModule,
      strictCheckFn: async () => ({ pass: false, skipped: false, error: 'mock strict failed' }),
      fixerFn: async () => {
        fixerCalls += 1;
        return { ok: true, fixedContent: 'should-not-be-called' };
      },
      commitFileFn: async (file) => {
        commits.push(file);
        return 'unexpected';
      },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.active.results[0].stage, 'active_deferred_strict_failed');
    assert.strictEqual(result.active.results[0].autofixAttempts, undefined);
    assert.strictEqual(fixerCalls, 0);
    assert.deepStrictEqual(commits, []);
    assert.strictEqual(targetContent(target), before);
  } finally {
    fs.writeFileSync(path.join(PROJECT_ROOT, target), before, 'utf8');
    cleanupRefactorArtifacts(result);
  }
  console.log('✅ refactor-cycle: strict autofix opt-out preserves immediate strict defer');
}

async function test_strict_baseline_diff_allows_existing_errors_and_removed_errors() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const existingA = strictError('bots/blog/__tests__/asset-memory.test.ts', '2304', 'Cannot find name jest');
  const existingB = strictError('packages/core/lib/runtime-env-policy.ts', '7006', 'Parameter key implicitly has an any type');
  const unchanged = runner.defaultStrictCheck({
    file: ACTIVE_TARGET,
    context: {
      strictGateBaselineEnabled: true,
      strictBaseline: new Set([existingA, existingB]),
      strictRunFn: () => ({ ok: false, output: `${existingA}\n${existingB}`, command: 'mock strict' }),
    },
  });
  assert.strictEqual(unchanged.pass, true);
  assert.strictEqual(unchanged.newErrorCount, 0);

  const removed = runner.defaultStrictCheck({
    file: ACTIVE_TARGET,
    context: {
      strictGateBaselineEnabled: true,
      strictBaseline: new Set([existingA, existingB]),
      strictRunFn: () => ({ ok: false, output: existingA, command: 'mock strict' }),
    },
  });
  assert.strictEqual(removed.pass, true);
  assert.strictEqual(removed.newErrorCount, 0);
  console.log('✅ refactor-cycle: strict baseline allows unchanged and removed existing errors');
}

async function test_apply_strict_baseline_passes_and_commits_when_no_new_errors() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
  const before = targetContent(target);
  const { builderModule, reviewerModule } = verifierModulesAlwaysPass(target);
  const existing = strictError('bots/blog/__tests__/asset-memory.test.ts', '2304', 'Cannot find name jest');
  const strictCalls = [];
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
      captureStrictBaselineFn: async () => new Set([existing]),
      strictRunFn: (meta) => {
        strictCalls.push(meta.stage);
        return { ok: false, output: existing, command: 'mock strict' };
      },
      currentHeadFn: async () => 'before-baseline-pass-sha',
      rollbackFn: async () => {
        throw new Error('rollback should not be called');
      },
      pushFn: async () => ({ ok: true }),
      originContainsFn: async () => true,
      commitFileFn: async (file) => {
        commits.push(file);
        return 'fake-sha-baseline-pass';
      },
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.active.applied, true);
    assert.deepStrictEqual(strictCalls, ['after']);
    assert.deepStrictEqual(commits, [target]);
    assert.strictEqual(result.active.applyResults[0].commit, 'fake-sha-baseline-pass');
    assert.notStrictEqual(targetContent(target), before);
  } finally {
    fs.writeFileSync(path.join(PROJECT_ROOT, target), before, 'utf8');
    cleanupRefactorArtifacts(result);
  }
  console.log('✅ refactor-cycle: strict baseline allows apply when no new strict errors appear');
}

async function test_apply_strict_baseline_blocks_new_errors_before_commit() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
  const before = targetContent(target);
  const { builderModule, reviewerModule } = verifierModulesAlwaysPass(target);
  const existing = strictError('bots/blog/__tests__/asset-memory.test.ts', '2304', 'Cannot find name jest');
  const introduced = strictError('bots/claude/lib/symphony/consumer.ts', '2339', 'Property id does not exist');
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
      captureStrictBaselineFn: async () => new Set([existing]),
      strictRunFn: () => ({ ok: false, output: `${existing}\n${introduced}`, command: 'mock strict' }),
      commitFileFn: async (file) => {
        commits.push(file);
        return 'unexpected';
      },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.active.applied, false);
    assert.strictEqual(result.active.results[0].stage, 'active_deferred_strict_failed');
    assert.strictEqual(result.active.results[0].strict.reason, 'strict_new_errors');
    assert.deepStrictEqual(result.active.results[0].strict.newErrors, [introduced]);
    assert.deepStrictEqual(commits, []);
    assert.strictEqual(targetContent(target), before);
  } finally {
    fs.writeFileSync(path.join(PROJECT_ROOT, target), before, 'utf8');
    cleanupRefactorArtifacts(result);
  }
  console.log('✅ refactor-cycle: strict baseline blocks newly introduced strict errors');
}

async function test_apply_strict_baseline_fails_closed_when_baseline_unavailable() {
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
      captureStrictBaselineFn: async () => null,
      commitFileFn: async (file) => {
        commits.push(file);
        return 'unexpected';
      },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.active.results[0].stage, 'active_deferred_strict_failed');
    assert.strictEqual(result.active.results[0].strict.reason, 'strict_baseline_unavailable');
    assert.deepStrictEqual(commits, []);
    assert.strictEqual(targetContent(target), before);
  } finally {
    fs.writeFileSync(path.join(PROJECT_ROOT, target), before, 'utf8');
    cleanupRefactorArtifacts(result);
  }
  console.log('✅ refactor-cycle: strict baseline unavailable fails closed');
}

async function test_apply_strict_baseline_fails_closed_when_after_infra_fails() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
  const before = targetContent(target);
  const { builderModule, reviewerModule } = verifierModulesAlwaysPass(target);
  const existing = strictError('bots/blog/__tests__/asset-memory.test.ts', '2304', 'Cannot find name jest');
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
      captureStrictBaselineFn: async () => new Set([existing]),
      strictRunFn: () => ({ ok: false, output: 'tsc command timed out', infraError: true, command: 'mock strict' }),
      commitFileFn: async (file) => {
        commits.push(file);
        return 'unexpected';
      },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.active.results[0].stage, 'active_deferred_strict_failed');
    assert.strictEqual(result.active.results[0].strict.reason, 'strict_after_infra_error');
    assert.deepStrictEqual(commits, []);
    assert.strictEqual(targetContent(target), before);
  } finally {
    fs.writeFileSync(path.join(PROJECT_ROOT, target), before, 'utf8');
    cleanupRefactorArtifacts(result);
  }
  console.log('✅ refactor-cycle: strict after-run infrastructure failure fails closed');
}

async function test_strict_baseline_rejects_config_error_with_ts_code() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const configError = "error TS5058: The specified path does not exist: 'tsconfig.strict.json'.";
  const baseline = runner.captureStrictBaseline({
    context: {
      strictRunFn: () => ({
        ok: false,
        output: configError,
        infraError: runner.isStrictInfraFailure({}, configError),
        command: 'mock strict',
      }),
    },
  });
  assert.strictEqual(baseline, null);
  console.log('✅ refactor-cycle: strict baseline rejects TypeScript config errors even with TS codes');
}

async function test_strict_infra_detection_ignores_normal_diagnostic_words() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const diagnosticWithInfraLikeNames = [
    strictError('bots/blog/scripts/draft-book-review.ts', '7006', "Parameter 'timeoutMs' implicitly has an any type."),
    strictError('bots/claude/__tests__/auto-dev-pipeline.test.ts', '7034', "Variable 'spawnedScripts' implicitly has type 'any[]'."),
  ].join('\n');
  assert.strictEqual(runner.isStrictInfraFailure({}, diagnosticWithInfraLikeNames), false);
  const baseline = runner.captureStrictBaseline({
    context: {
      strictRunFn: () => ({
        ok: false,
        output: diagnosticWithInfraLikeNames,
        infraError: runner.isStrictInfraFailure({}, diagnosticWithInfraLikeNames),
        command: 'mock strict',
      }),
    },
  });
  assert.strictEqual(baseline instanceof Set, true);
  assert.strictEqual(baseline.size, 2);
  console.log('✅ refactor-cycle: strict infra detection ignores timeout/spawn words inside normal diagnostics');
}

async function test_strict_after_rejects_timeout_with_partial_diagnostics() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const partialDiagnostic = strictError('packages/core/lib/runtime-env-policy.ts', '7006', 'Parameter key implicitly has an any type');
  const result = runner.defaultStrictCheck({
    file: ACTIVE_TARGET,
    context: {
      strictGateBaselineEnabled: true,
      strictBaseline: new Set([partialDiagnostic]),
      strictRunFn: () => ({
        ok: false,
        output: partialDiagnostic,
        infraError: runner.isStrictInfraFailure({ killed: true, signal: 'SIGTERM' }, partialDiagnostic),
        command: 'mock strict',
      }),
    },
  });
  assert.strictEqual(result.pass, false);
  assert.strictEqual(result.reason, 'strict_after_infra_error');
  console.log('✅ refactor-cycle: strict after-run rejects timeout even with partial diagnostics');
}

async function test_strict_baseline_disabled_preserves_legacy_pass_fail() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const legacyFail = runner.defaultStrictCheck({
    file: ACTIVE_TARGET,
    context: {
      strictGateBaselineEnabled: false,
      strictRunFn: () => ({ ok: false, output: 'legacy strict failed', command: 'mock strict' }),
    },
  });
  assert.strictEqual(legacyFail.pass, false);
  assert.strictEqual(legacyFail.reason, 'strict_legacy_failed');

  const legacyPass = runner.defaultStrictCheck({
    file: ACTIVE_TARGET,
    context: {
      strictGateBaselineEnabled: false,
      strictRunFn: () => ({ ok: true, output: '', command: 'mock strict' }),
    },
  });
  assert.strictEqual(legacyPass.pass, true);
  console.log('✅ refactor-cycle: strict baseline disabled preserves legacy strict pass/fail');
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

async function test_autofix_preserves_original_final_newline() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
  const before = targetContent(target);
  assert.strictEqual(before.endsWith('\n'), true);
  assert.strictEqual(finalNewline(before), '\n');
  const calls = { builder: [] };
  const builderModule = {
    async runTargetedTypeCheck(files, options) {
      calls.builder.push(options);
      assert.deepStrictEqual(files, [target]);
      assert.deepStrictEqual(options.files, [target]);
      const content = targetContent(target);
      const pass = content.includes(AUTOFIX_MARKER);
      if (pass) {
        assert.strictEqual(finalNewline(content), '\n');
        assert.strictEqual(content.endsWith('\n\n'), false);
        assert.doesNotMatch(content, /@ts-nocheck/);
      }
      return {
        pass,
        skipped: false,
        message: pass ? 'forced builder pass after newline-preserving autofix' : 'forced builder fail before autofix',
        results: [{ pass, skipped: false, error: pass ? null : 'TS2322: mocked type error' }],
      };
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
    autofixEnabled: true,
    gitStatusShortFn: () => '',
    builderModule,
    reviewerModule: reviewerModuleAlwaysPass(target),
    fixerFn: async (_context, params) => ({
      ok: true,
      fixedContent: params.currentContent.replace(/^\/\/ @ts-nocheck\n/, '').trimEnd() + `\n${AUTOFIX_MARKER}`,
      model: 'mock-refactorer',
      provider: 'mock',
    }),
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.active.stage, 'active_autofixed_ready_for_commit');
  assert.strictEqual(calls.builder.length, 2);
  assert.strictEqual(targetContent(target), before);
  console.log('✅ refactor-cycle: autofix preserves original final newline before re-verify');
}

async function test_autofix_preserves_original_crlf_final_newline() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
  const targetAbs = path.join(PROJECT_ROOT, target);
  const before = targetContent(target);
  const crlfBefore = before.replace(/\n/g, '\r\n');
  fs.writeFileSync(targetAbs, crlfBefore, 'utf8');
  try {
    assert.strictEqual(finalNewline(targetContent(target)), '\r\n');
    const calls = { builder: [] };
    const builderModule = {
      async runTargetedTypeCheck(files, options) {
        calls.builder.push(options);
        assert.deepStrictEqual(files, [target]);
        assert.deepStrictEqual(options.files, [target]);
        const content = targetContent(target);
        const pass = content.includes(AUTOFIX_MARKER);
        if (pass) {
          assert.strictEqual(finalNewline(content), '\r\n');
          assert.strictEqual(content.endsWith(`${AUTOFIX_MARKER}\r\n`), true);
          assert.doesNotMatch(content, /@ts-nocheck/);
        }
        return {
          pass,
          skipped: false,
          message: pass ? 'forced builder pass after CRLF-preserving autofix' : 'forced builder fail before autofix',
          results: [{ pass, skipped: false, error: pass ? null : 'TS2322: mocked type error' }],
        };
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
      autofixEnabled: true,
      gitStatusShortFn: () => '',
      builderModule,
      reviewerModule: reviewerModuleAlwaysPass(target),
      fixerFn: async (_context, params) => ({
        ok: true,
        fixedContent: params.currentContent.replace(/^\/\/ @ts-nocheck\r?\n/, '').trimEnd() + `\r\n${AUTOFIX_MARKER}`,
        model: 'mock-refactorer',
        provider: 'mock',
      }),
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.active.stage, 'active_autofixed_ready_for_commit');
    assert.strictEqual(calls.builder.length, 2);
    assert.strictEqual(targetContent(target), crlfBefore);
  } finally {
    fs.writeFileSync(targetAbs, before, 'utf8');
  }
  console.log('✅ refactor-cycle: autofix preserves original CRLF final newline before re-verify');
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

async function test_autofix_budget_precheck_blocks_fixer_call() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const targetDir = 'bots/claude/__tests__/tmp-refactor-budget';
  const absDir = path.join(PROJECT_ROOT, targetDir);
  const target = `${targetDir}/large-budget.ts`;
  fs.rmSync(absDir, { recursive: true, force: true });
  fs.mkdirSync(absDir, { recursive: true });
  const content = [
    '// @ts-nocheck',
    ...Array.from({ length: 1305 }, (_, index) => `export const value${index} = ${index};`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(PROJECT_ROOT, target), content, 'utf8');
  let fixerCalls = 0;
  let result = null;
  try {
    result = await runner.runRefactorCycle({
      mode: 'active',
      target,
      dryRun: true,
      noMcp: true,
      noVaultFeedback: true,
      noHeartbeat: true,
      noWriteOutcome: true,
      allowDirtyWorktreeForTest: true,
      allowNonProductionCandidatesForTest: true,
      autofixEnabled: true,
      builderModule: {
        async runTargetedTypeCheck() {
          return {
            pass: false,
            skipped: false,
            results: [{ pass: false, skipped: false, error: 'large-budget.ts(1,1): error TS7006: Parameter input implicitly has an any type.' }],
          };
        },
      },
      reviewerModule: reviewerModuleAlwaysPass(target),
      fixerFn: async () => {
        fixerCalls += 1;
        return { ok: false, error: 'should_not_call_fixer' };
      },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.active.results[0].failureClass, 'budget_blocked');
    assert.strictEqual(result.active.results[0].fixerCapability, 'budget_blocked');
    assert.strictEqual(fixerCalls, 0);
  } finally {
    fs.rmSync(absDir, { recursive: true, force: true });
    cleanupRefactorArtifacts(result);
  }
  console.log('✅ refactor-cycle: budget precheck blocks expensive autofix calls');
}

async function test_autofix_metadata_records_failure_class_and_next_action() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
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
    autofixEnabled: true,
    autofixMaxAttempts: 1,
    gitStatusShortFn: () => '',
    builderModule: {
      async runTargetedTypeCheck(files, options) {
        assert.deepStrictEqual(files, [target]);
        assert.deepStrictEqual(options.files, [target]);
        const content = targetContent(target);
        const pass = content.includes(AUTOFIX_MARKER);
        return {
          pass,
          skipped: false,
          results: [{
            pass,
            skipped: false,
            error: pass ? null : "fixture.ts(1,1): error TS2365: Operator '<' cannot be applied to types 'string' and 'number'.",
          }],
        };
      },
    },
    reviewerModule: reviewerModuleAlwaysPass(target),
    fixerFn: async (_context, params) => ({
      ok: true,
      fixedContent: params.currentContent,
      model: 'mock-noop',
    }),
  });
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.active.results[0].errorCodes, ['TS2365']);
  assert.strictEqual(result.active.results[0].fixerCapability, 'manual_required');
  assert.strictEqual(result.active.results[0].failureClass, 'autofix_capability_gap');
  assert.match(result.active.results[0].nextAction, /local_fixer|manual/);
  assert.strictEqual(targetContent(target), before);
  console.log('✅ refactor-cycle: autofix metadata records failure class and next action');
}

async function test_autofix_metadata_reclassifies_final_failure() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const target = ACTIVE_TARGET;
  const before = targetContent(target);
  let builderCalls = 0;
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
    builderModule: {
      async runTargetedTypeCheck(files, options) {
        builderCalls += 1;
        assert.deepStrictEqual(files, [target]);
        assert.deepStrictEqual(options.files, [target]);
        const error = builderCalls === 1
          ? "fixture.ts(1,1): error TS7006: Parameter 'input' implicitly has an 'any' type."
          : "fixture.ts(1,1): error TS2365: Operator '<' cannot be applied to types 'string' and 'number'.";
        return {
          pass: false,
          skipped: false,
          results: [{ pass: false, skipped: false, error }],
        };
      },
    },
    reviewerModule: reviewerModuleAlwaysPass(target),
    fixerFn: async (_context, params) => ({
      ok: true,
      fixedContent: params.currentContent,
      model: 'mock-noop',
    }),
  });
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.active.results[0].errorCodes, ['TS2365']);
  assert.strictEqual(result.active.results[0].fixerCapability, 'manual_required');
  assert.strictEqual(result.active.results[0].failureClass, 'autofix_capability_gap');
  assert.strictEqual(targetContent(target), before);
  console.log('✅ refactor-cycle: autofix metadata reclassifies the final failure');
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

async function test_node_check_hook_passes_and_fails_raw_node_syntax() {
  delete require.cache[NODE_CHECK_HOOK_PATH];
  const { runNodeCheckHook } = require(NODE_CHECK_HOOK_PATH);
  resetTargetedTypecheckTmp();
  const clean = writeTmpTsFile('node-check-clean.ts', [
    '#!/usr/bin/env node',
    "'use strict';",
    'function main(name = "") { return name; }',
    'module.exports = { main };',
    '',
  ].join('\n'));
  const bad = writeTmpTsFile('node-check-bad.ts', [
    '#!/usr/bin/env node',
    "'use strict';",
    'function main(name: string) { return name; }',
    'module.exports = { main };',
    '',
  ].join('\n'));
  const regularModule = writeTmpTsFile('node-check-regular-module.ts', [
    'export interface RegularModule { name: string }',
    'export function getName(input: RegularModule): string { return input.name; }',
    '',
  ].join('\n'));
  try {
    const cleanResult = runNodeCheckHook(clean, PROJECT_ROOT);
    assert.strictEqual(cleanResult.pass, true);
    const badResult = runNodeCheckHook(bad, PROJECT_ROOT);
    assert.strictEqual(badResult.pass, false);
    assert.match(badResult.error, /Unexpected token|SyntaxError|type/i);
    const regularResult = runNodeCheckHook(regularModule, PROJECT_ROOT);
    assert.strictEqual(regularResult.pass, true);
    assert.strictEqual(regularResult.skipped, true);
  } finally {
    cleanupTargetedTypecheckTmp();
  }
  console.log('✅ refactor-cycle: node-check hook checks raw Node files and skips regular TS modules');
}

async function test_active_node_check_failure_defers_before_apply() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const targetDir = 'bots/claude/__tests__/tmp-refactor-node-check';
  const absDir = path.join(PROJECT_ROOT, targetDir);
  const target = `${targetDir}/bad-node-script.ts`;
  fs.rmSync(absDir, { recursive: true, force: true });
  fs.mkdirSync(absDir, { recursive: true });
  fs.writeFileSync(path.join(PROJECT_ROOT, target), [
    '#!/usr/bin/env node',
    '// @ts-nocheck',
    "'use strict';",
    'function hasFlag(name: string) { return process.argv.includes(`--${name}`); }',
    'module.exports = { hasFlag };',
    '',
  ].join('\n'), 'utf8');
  const before = targetContent(target);
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
      gitStatusShortFn: () => '',
      builderModule: {
        async runTargetedTypeCheck(files, options) {
          assert.deepStrictEqual(files, [target]);
          assert.deepStrictEqual(options.files, [target]);
          return { pass: true, skipped: false, results: [{ pass: true, skipped: false }] };
        },
      },
      reviewerModule: {
        async runReview(options) {
          assert.deepStrictEqual(options.files, [target]);
          return { pass: true, skipped: false, summary: { high: 0, critical: 0 }, findings: [], sent: false };
        },
      },
      strictCheckFn: async () => strictPass(),
      commitFileFn: async (file) => {
        commits.push(file);
        return 'mock-commit';
      },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.active.results[0].stage, 'active_deferred');
    assert.strictEqual(result.active.results[0].verify.nodeCheckPass, false);
    assert.match(result.active.results[0].errorSummary, /node_check_pass=false/);
    assert.deepStrictEqual(commits, []);
    assert.strictEqual(targetContent(target), before);
  } finally {
    cleanupRefactorArtifacts(result);
    fs.rmSync(absDir, { recursive: true, force: true });
  }
  console.log('✅ refactor-cycle: node-check failure defers and prevents apply');
}

async function test_autofix_prompt_for_node_executable_requires_jsdoc() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const currentContent = [
    '#!/usr/bin/env node',
    "'use strict';",
    'function hasFlag(name) { return process.argv.includes(`--${name}`); }',
    '',
  ].join('\n');
  const prompt = runner.buildFixerPrompt({
    fileRel: 'bots/claude/scripts/example.ts',
    currentContent,
    builderError: 'TS7006',
    reviewerFindings: [],
    priorErrors: [],
    attempt: 1,
  });
  const systemPrompt = runner.buildFixerSystemPrompt({ nodeExecutable: true });
  assert.match(prompt, /node_executable: true/);
  assert.match(prompt, /JSDoc only/i);
  assert.match(systemPrompt, /raw Node/);
  assert.match(systemPrompt, /Never add inline TypeScript type annotations/);
  console.log('✅ refactor-cycle: node executable autofix prompt requires JSDoc');
}

async function test_node_executable_ts7006_uses_local_jsdoc_fix() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const currentContent = [
    "'use strict';",
    '// @ts-nocheck',
    'exports.up = function(db) {',
    '  db.exec("SELECT 1");',
    '};',
    '',
    'exports.down = function(db) {',
    '  db.exec("SELECT 0");',
    '};',
    '',
  ].join('\n');
  const fix = runner.addNodeExecutableImplicitAnyJsdoc(
    currentContent,
    "migration.ts(3,23): error TS7006: Parameter 'db' implicitly has an 'any' type."
  );
  assert.strictEqual(fix.ok, true);
  assert.doesNotMatch(fix.fixedContent, /@ts-nocheck/);
  assert.match(fix.fixedContent, /@param \{any\} db/);
  assert.match(fix.fixedContent, /exports\.up = function\(db\)/);
  assert.match(fix.fixedContent, /exports\.down = function\(db\)/);
  assert.doesNotMatch(fix.fixedContent, /db:\s*any|as\s+any/);

  resetTargetedTypecheckTmp();
  const target = writeTmpTsFile('node-jsdoc-local-fix.ts', fix.fixedContent);
  try {
    const nodeCheck = runner.runNodeCheckForFile
      ? runner.runNodeCheckForFile(target)
      : { pass: true };
    assert.strictEqual(nodeCheck.pass, true);
  } finally {
    cleanupTargetedTypecheckTmp();
  }
  console.log('✅ refactor-cycle: node executable TS7006 uses local JSDoc fix');
}

async function test_node_executable_ts18046_uses_local_unknown_guard() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const currentContent = [
    "'use strict';",
    '// @ts-nocheck',
    'async function main() {',
    '  try {',
    '    await Promise.resolve();',
    '  } catch (e) {',
    "    console.error('fatal', e.message);",
    '  }',
    '}',
    '',
    'main();',
    '',
  ].join('\n');
  const fix = runner.attemptNodeExecutableLocalTypeFix(
    currentContent,
    "script.ts(7,28): error TS18046: 'e' is of type 'unknown'."
  );
  assert.strictEqual(fix.ok, true);
  assert.doesNotMatch(fix.fixedContent, /@ts-nocheck/);
  assert.match(fix.fixedContent, /e && e\.message \? e\.message : String\(e\)/);
  assert.doesNotMatch(fix.fixedContent, /e:\s*any|as\s+any/);

  resetTargetedTypecheckTmp();
  const target = writeTmpTsFile('node-unknown-local-fix.ts', fix.fixedContent);
  try {
    const nodeCheck = runner.runNodeCheckForFile(target);
    assert.strictEqual(nodeCheck.pass, true);
  } finally {
    cleanupTargetedTypecheckTmp();
  }
  console.log('✅ refactor-cycle: node executable TS18046 uses local unknown guard');
}

async function test_node_executable_ts2339_empty_object_message_uses_local_guard() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const currentContent = [
    "'use strict';",
    '// @ts-nocheck',
    'function run() {',
    '  try {',
    '    throw new Error("boom");',
    '  } catch (e) {',
    "    console.error('fatal', e.message);",
    '  }',
    '}',
    'module.exports = { run };',
    '',
  ].join('\n');
  const fix = runner.attemptNodeExecutableLocalTypeFix(
    currentContent,
    "script.ts(7,30): error TS2339: Property 'message' does not exist on type '{}'."
  );
  assert.strictEqual(fix.ok, true);
  assert.doesNotMatch(fix.fixedContent, /@ts-nocheck/);
  assert.match(fix.fixedContent, /e && e\.message \? e\.message : String\(e\)/);
  assert.doesNotMatch(fix.fixedContent, /e:\s*any|as\s+any/);
  console.log('✅ refactor-cycle: node executable TS2339 empty-object message uses local guard');
}

async function test_node_executable_ts2339_uses_local_unknown_property_guard() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const currentContent = [
    "'use strict';",
    '// @ts-nocheck',
    'function run(data) {',
    '  const items = [];',
    '  for (const [name, info] of Object.entries(data.resources)) {',
    '    items.push({',
    "      status: info.status || 'ok',",
    '      label: `Hub ${name}`,',
    "      detail: info.detail || `${info.latency_ms || '?'}ms`,",
    '    });',
    '  }',
    '  return items;',
    '}',
    'module.exports = { run };',
    '',
  ].join('\n');
  const fix = runner.attemptNodeExecutableLocalTypeFix(
    currentContent,
    [
      "hub.ts(7,20): error TS2339: Property 'status' does not exist on type 'unknown'.",
      "hub.ts(9,20): error TS2339: Property 'detail' does not exist on type 'unknown'.",
      "hub.ts(9,38): error TS2339: Property 'latency_ms' does not exist on type 'unknown'.",
    ].join('\n')
  );
  assert.strictEqual(fix.ok, true);
  assert.doesNotMatch(fix.fixedContent, /@ts-nocheck/);
  assert.match(fix.fixedContent, /const infoEntries = JSON\.parse\(JSON\.stringify\(data\.resources \|\| \{\}\)\)/);
  assert.match(fix.fixedContent, /for \(const name of Object\.keys\(infoEntries\)\)/);
  assert.match(fix.fixedContent, /const info = infoEntries\[name\]/);
  assert.match(fix.fixedContent, /info\.status/);
  assert.match(fix.fixedContent, /info\.detail/);
  assert.match(fix.fixedContent, /info\.latency_ms/);

  resetTargetedTypecheckTmp();
  const target = writeTmpTsFile('node-unknown-property-local-fix.ts', fix.fixedContent);
  try {
    const nodeCheck = runner.runNodeCheckForFile(target);
    assert.strictEqual(nodeCheck.pass, true);
  } finally {
    cleanupTargetedTypecheckTmp();
  }
  console.log('✅ refactor-cycle: node executable TS2339 uses local unknown property guard');
}

async function test_node_executable_ts2339_object_values_uses_local_guard() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const currentContent = [
    "'use strict';",
    '// @ts-nocheck',
    'function summarize(manifest) {',
    '  const entries = Object.values(manifest.entries || {});',
    "  const active = entries.filter((entry) => String(entry.state || '') === 'active');",
    '  return active.map((entry) => ({ relPath: entry.relPath, state: entry.state }));',
    '}',
    'module.exports = { summarize };',
    '',
  ].join('\n');
  const fix = runner.attemptNodeExecutableLocalTypeFix(
    currentContent,
    [
      "state-store.ts(5,62): error TS2339: Property 'state' does not exist on type 'unknown'.",
      "state-store.ts(6,50): error TS2339: Property 'relPath' does not exist on type 'unknown'.",
    ].join('\n')
  );
  assert.strictEqual(fix.ok, true);
  assert.doesNotMatch(fix.fixedContent, /@ts-nocheck/);
  assert.match(fix.fixedContent, /const entries = JSON\.parse\(JSON\.stringify\(Object\.values\(manifest\.entries \|\| \{\}\)\)\)/);

  resetTargetedTypecheckTmp();
  const target = writeTmpTsFile('node-object-values-local-fix.ts', fix.fixedContent);
  try {
    const nodeCheck = runner.runNodeCheckForFile(target);
    assert.strictEqual(nodeCheck.pass, true);
    const builder = requireBuilder();
    const result = await builder.runTargetedTypeCheck([target], { files: [target], force: true, test: true });
    assert.strictEqual(result.pass, true);
  } finally {
    cleanupTargetedTypecheckTmp();
  }
  console.log('✅ refactor-cycle: node executable TS2339 Object.values uses local guard');
}

async function test_node_executable_ts7053_record_index_uses_local_map() {
  delete require.cache[RUNNER_PATH];
  const runner = require(RUNNER_PATH);
  const currentContent = [
    "'use strict';",
    '// @ts-nocheck',
    'function countBy(items, selector) {',
    '  const counts = {};',
    '  for (const item of items || []) {',
    "    const key = selector(item) || 'unknown';",
    '    counts[key] = (counts[key] || 0) + 1;',
    '  }',
    '  return counts;',
    '}',
    'module.exports = { countBy };',
    '',
  ].join('\n');
  const fix = runner.attemptNodeExecutableLocalTypeFix(
    currentContent,
    [
      "state-store.ts(3,18): error TS7006: Parameter 'items' implicitly has an 'any' type.",
      "state-store.ts(3,25): error TS7006: Parameter 'selector' implicitly has an 'any' type.",
      "state-store.ts(7,5): error TS7053: Element implicitly has an 'any' type because expression of type 'any' can't be used to index type '{}'.",
    ].join('\n')
  );
  assert.strictEqual(fix.ok, true);
  assert.doesNotMatch(fix.fixedContent, /@ts-nocheck/);
  assert.match(fix.fixedContent, /@param \{any\} items/);
  assert.match(fix.fixedContent, /@param \{any\} selector/);
  assert.match(fix.fixedContent, /const counts = new Map\(\);/);
  assert.match(fix.fixedContent, /counts\.set\(key, \(counts\.get\(key\) \|\| 0\) \+ 1\);/);
  assert.match(fix.fixedContent, /return Object\.fromEntries\(counts\.entries\(\)\);/);
  assert.doesNotMatch(fix.fixedContent, /counts:\s*Record|as\s+Record/);

  resetTargetedTypecheckTmp();
  const target = writeTmpTsFile('node-record-index-local-fix.ts', fix.fixedContent);
  try {
    const nodeCheck = runner.runNodeCheckForFile(target);
    assert.strictEqual(nodeCheck.pass, true);
    const builder = requireBuilder();
    const result = await builder.runTargetedTypeCheck([target], { files: [target], force: true, test: true });
    assert.strictEqual(result.pass, true);
  } finally {
    cleanupTargetedTypecheckTmp();
  }
  console.log('✅ refactor-cycle: node executable TS7053 record index uses local Map rewrite');
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
    test_safe_deferred_cycle_uses_soft_operational_status,
    test_cycle_stamp_uses_kst,
    test_protected_target_guard,
    test_protected_descendants_are_excluded_from_analysis,
    test_active_candidates_skip_non_production_fixtures,
    test_active_candidates_validate_current_ts_nocheck_state,
    test_active_candidates_skip_ts_extension_import_until_gate_supports_it,
    test_local_refactor_history_avoids_repeated_failed_candidates,
    test_active_cycle_skips_candidates_avoided_by_local_history,
    test_active_candidates_prefer_higher_score_over_smaller_file,
    test_ts2365_classifier_requires_manual_or_targeted_fixer,
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
    test_origin_contains_checks_current_branch_when_main_is_stale,
    test_default_commit_file_is_path_scoped,
    test_apply_on_verify_fail_does_not_commit_and_restores,
    test_apply_on_dry_run_does_not_commit_and_restores,
    test_apply_commit_failure_restores_and_reports_apply_failed,
    test_apply_push_failure_rolls_back_and_reports_failed,
    test_apply_strict_failure_defers_before_commit,
    test_strict_autofix_success_commits_after_strict_recheck,
    test_strict_autofix_reviewer_high_blocks_commit,
    test_strict_autofix_failure_restores_and_defers_strict_failed,
    test_strict_autofix_disabled_preserves_immediate_strict_defer,
    test_strict_baseline_diff_allows_existing_errors_and_removed_errors,
    test_apply_strict_baseline_passes_and_commits_when_no_new_errors,
    test_apply_strict_baseline_blocks_new_errors_before_commit,
    test_apply_strict_baseline_fails_closed_when_baseline_unavailable,
    test_apply_strict_baseline_fails_closed_when_after_infra_fails,
    test_strict_baseline_rejects_config_error_with_ts_code,
    test_strict_infra_detection_ignores_normal_diagnostic_words,
    test_strict_after_rejects_timeout_with_partial_diagnostics,
    test_strict_baseline_disabled_preserves_legacy_pass_fail,
    test_apply_lock_fresh_skips_stale_proceeds_and_releases,
    test_apply_rate_limit_defers_extra_ready_files,
    test_builder_all_skipped_defers,
    test_builder_no_results_skipped_defers,
    test_builder_executed_pass_still_ready,
    test_builder_executed_fail_defers,
    test_autofix_off_preserves_phase3_defer,
    test_autofix_success_captures_patch_and_restores,
    test_autofix_preserves_original_final_newline,
    test_autofix_preserves_original_crlf_final_newline,
    test_autofix_failure_defers_unfixable_and_restores,
    test_autofix_budget_precheck_blocks_fixer_call,
    test_autofix_metadata_records_failure_class_and_next_action,
    test_autofix_metadata_reclassifies_final_failure,
    test_autofix_rejects_unexpected_mutation,
    test_autofix_prior_errors_filter_and_cap,
    test_autofix_prior_errors_are_passed_to_fixer,
    test_autofix_empty_vault_feedback_passes_empty_prior_errors,
    test_autofix_fixer_prompt_includes_prior_failure_section,
    test_node_check_hook_passes_and_fails_raw_node_syntax,
    test_active_node_check_failure_defers_before_apply,
    test_autofix_prompt_for_node_executable_requires_jsdoc,
    test_node_executable_ts7006_uses_local_jsdoc_fix,
    test_node_executable_ts18046_uses_local_unknown_guard,
    test_node_executable_ts2339_empty_object_message_uses_local_guard,
    test_node_executable_ts2339_uses_local_unknown_property_guard,
    test_node_executable_ts2339_object_values_uses_local_guard,
    test_node_executable_ts7053_record_index_uses_local_map,
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
      ensureActiveTarget();
      await test();
      passed += 1;
    } catch (error) {
      console.error(`❌ ${test.name}: ${error.message}`);
      failed += 1;
    } finally {
      cleanupActiveTarget();
    }
  }
  console.log(`\n결과: ${passed}/${tests.length} 통과`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
