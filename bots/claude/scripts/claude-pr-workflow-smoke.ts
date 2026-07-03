#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('assert');
const gitOps = require('../lib/git-ops.ts');
const pipeline = require('../lib/auto-dev-pipeline.ts');
const refactorRunner = require('./refactor-cycle-runner.ts');

async function main() {
  const off = pipeline.resolveAutoDevRuntimeConfig({}, { CLAUDE_AUTO_DEV_PROFILE: 'shadow' });
  assert.strictEqual(off.prWorkflowEnabled, false);
  const on = pipeline.resolveAutoDevRuntimeConfig({}, { CLAUDE_AUTO_DEV_PROFILE: 'shadow', CLAUDE_PR_WORKFLOW_ENABLED: 'true' });
  assert.strictEqual(on.prWorkflowEnabled, true);

  const branch = pipeline._testOnly_autoDevPrBranch({ id: 'job:abc/123' }, new Date('2026-07-03T00:00:00.000Z'));
  assert.match(branch, /^claude\/auto-dev-/);
  assert.ok(!branch.includes(':'));

  const originalPush = gitOps.pushHeadToBranch;
  const originalCreate = gitOps.createPR;
  const calls = [];
  try {
    gitOps.pushHeadToBranch = (target, opts) => {
      calls.push({ type: 'push', target, cwd: opts.cwd });
      return '';
    };
    gitOps.createPR = (input) => {
      calls.push({ type: 'pr', input });
      return { ok: true, number: 42, url: 'https://github.com/example/repo/pull/42' };
    };
    const result = pipeline._testOnly_publishIntegrationAsPR({
      mode: 'direct_push_prepared',
      worktreePath: '/tmp/worktree',
      worktreeCommitSha: 'abc123',
    }, {
      id: 'job123',
      relPath: 'docs/auto_dev/CODEX_TEST.md',
    }, {
      branch: 'claude/auto-dev-job123-20260703000000',
    });
    assert.strictEqual(result.prCreated, true);
    assert.strictEqual(result.prNumber, 42);
    assert.deepStrictEqual(calls.map((call) => call.type), ['push', 'pr']);
    assert.strictEqual(calls[0].target, 'claude/auto-dev-job123-20260703000000');
    assert.strictEqual(calls[1].input.base, 'main');
  } finally {
    gitOps.pushHeadToBranch = originalPush;
    gitOps.createPR = originalCreate;
  }

  const originalRunGit = gitOps.runGit;
  const cleanupCalls = [];
  try {
    gitOps.pushHeadToBranch = () => '';
    gitOps.createPR = () => ({ ok: false, error: 'pr_failed' });
    gitOps.runGit = (args, opts) => {
      cleanupCalls.push({ args, opts });
      return '';
    };
    const failed = pipeline._testOnly_publishIntegrationAsPR({
      mode: 'direct_push_prepared',
      worktreePath: '/tmp/worktree',
      worktreeCommitSha: 'abc123',
    }, {
      id: 'job456',
      relPath: 'docs/auto_dev/CODEX_FAIL.md',
    }, {
      branch: 'claude/auto-dev-job456-20260703000000',
    });
    assert.strictEqual(failed.prCreated, false);
    assert.strictEqual(failed.branchCleanup.deleted, true);
    assert.deepStrictEqual(cleanupCalls[0].args, ['push', 'origin', '--delete', 'claude/auto-dev-job456-20260703000000']);
  } finally {
    gitOps.pushHeadToBranch = originalPush;
    gitOps.createPR = originalCreate;
    gitOps.runGit = originalRunGit;
  }

  const refactorCleanupCalls = [];
  try {
    gitOps.createPR = () => ({ ok: false, error: 'pr_failed' });
    const failedRefactorPr = refactorRunner.defaultPushRefactorPr({
      commit: 'def456',
      file: 'bots/claude/lib/example.ts',
      context: { cycleId: 'cycle-123' },
    }, (args, opts) => {
      refactorCleanupCalls.push({ args, opts });
      return '';
    });
    assert.strictEqual(failedRefactorPr.ok, false);
    assert.strictEqual(failedRefactorPr.branchCleanup.deleted, true);
    assert.deepStrictEqual(refactorCleanupCalls.map((call) => call.args), [
      ['check-ref-format', '--branch', 'claude/refactor-example-cycle-123'],
      ['push', 'origin', 'HEAD:claude/refactor-example-cycle-123'],
      ['push', 'origin', '--delete', 'claude/refactor-example-cycle-123'],
    ]);
  } finally {
    gitOps.createPR = originalCreate;
  }

  console.log(JSON.stringify({
    ok: true,
    checked: [
      'env_gate',
      'branch_slug',
      'publish_pr_helper',
      'auto_dev_pr_failure_branch_cleanup',
      'refactor_pr_failure_branch_cleanup',
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
