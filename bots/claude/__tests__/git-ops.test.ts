'use strict';

const assert = require('assert');
const gitOps = require('../lib/git-ops.ts');

function recorder(outputs = {}) {
  const calls = [];
  const fn = (args, opts = {}) => {
    calls.push({ args, opts });
    const key = args.join(' ');
    if (outputs[key] instanceof Error) throw outputs[key];
    return outputs[key] ?? '';
  };
  fn.calls = calls;
  return fn;
}

function testRunGitMockableHelpers() {
  const git = recorder({
    'rev-parse HEAD': 'abc123\n',
    'status --short': ' M file.ts\n',
  });
  assert.equal(gitOps.currentHead(git), 'abc123');
  assert.equal(gitOps.statusShort('/repo', git), ' M file.ts');
  assert.deepEqual(git.calls.map((call) => call.args), [
    ['rev-parse', 'HEAD'],
    ['status', '--short'],
  ]);
  assert.equal(git.calls[1].opts.cwd, '/repo');
}

function testCommitFileUsesPathScopedCommit() {
  const git = recorder({ 'rev-parse HEAD': 'deadbeef\n' });
  const sha = gitOps.commitFile('bots/claude/lib/a.ts', 'test commit', git, { cwd: '/repo' });
  assert.equal(sha, 'deadbeef');
  assert.deepEqual(git.calls.map((call) => call.args), [
    ['add', '--', 'bots/claude/lib/a.ts'],
    ['commit', '-m', 'test commit', '--', 'bots/claude/lib/a.ts'],
    ['rev-parse', 'HEAD'],
  ]);
  assert.equal(git.calls[0].opts.cwd, '/repo');
}

function testPushRefSecurity() {
  assert.throws(() => gitOps.pushRef('--receive-pack=x', recorder()), /flags not allowed/);
  assert.throws(() => gitOps.pushRef('HEAD:main', recorder()), /refspec not allowed/);
  assert.throws(() => gitOps.pushRef('@{-1}', recorder()), /invalid ref/);
  assert.throws(() => gitOps.pushRef('main --force', recorder()), /invalid ref/);

  const headGit = recorder();
  gitOps.pushRef('HEAD', headGit);
  assert.deepEqual(headGit.calls.map((call) => call.args), [
    ['push', 'origin', 'HEAD'],
  ]);

  const branchGit = recorder();
  gitOps.pushRef('valid-branch', branchGit);
  assert.deepEqual(branchGit.calls.map((call) => call.args), [
    ['check-ref-format', '--branch', 'valid-branch'],
    ['push', 'origin', 'valid-branch'],
  ]);

  const headToBranchGit = recorder();
  gitOps.pushHeadToBranch('main', headToBranchGit, { cwd: '/worktree' });
  assert.deepEqual(headToBranchGit.calls.map((call) => call.args), [
    ['check-ref-format', '--branch', 'main'],
    ['push', 'origin', 'HEAD:main'],
  ]);
  assert.equal(headToBranchGit.calls[1].opts.cwd, '/worktree');
}

function testRollbackAndOriginContains() {
  const originGit = recorder({
    'rev-parse --abbrev-ref HEAD': 'main\n',
    'rev-parse --abbrev-ref --symbolic-full-name @{u}': 'origin/main\n',
    'merge-base --is-ancestor abc origin/main': '',
  });
  assert.equal(gitOps.originContains('abc', originGit), true);

  const rollbackGit = recorder();
  assert.deepEqual(gitOps.rollbackToHead('abc', 'file.ts', rollbackGit), { ok: true });
  assert.deepEqual(rollbackGit.calls.map((call) => call.args), [
    ['reset', '--soft', 'abc'],
    ['reset', '--', 'file.ts'],
  ]);
}

function testCreatePrUsesGhAndReturnsViewResult() {
  const gh = recorder({
    'pr create --base main --head claude/auto-dev-job-20260703 --title Test PR --body body': 'https://github.com/example/repo/pull/7\n',
    'pr view https://github.com/example/repo/pull/7 --json number,url': '{"number":7,"url":"https://github.com/example/repo/pull/7"}\n',
  });
  const result = gitOps.createPR({
    head: 'claude/auto-dev-job-20260703',
    title: 'Test PR',
    body: 'body',
  }, gh, { cwd: '/repo' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.number, 7);
  assert.strictEqual(result.url, 'https://github.com/example/repo/pull/7');
  assert.deepEqual(gh.calls.map((call) => call.args), [
    ['pr', 'create', '--base', 'main', '--head', 'claude/auto-dev-job-20260703', '--title', 'Test PR', '--body', 'body'],
    ['pr', 'view', 'https://github.com/example/repo/pull/7', '--json', 'number,url'],
  ]);
  assert.equal(gh.calls[0].opts.cwd, '/repo');
}

function testCreatePrFailureDoesNotThrow() {
  const gh = recorder({
    'pr create --base main --head claude/fail --title Test PR --body ': new Error('gh failed'),
  });
  const result = gitOps.createPR({ head: 'claude/fail', title: 'Test PR' }, gh);
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /gh failed/);
}

function testMergePrRequiresEnvGate() {
  const original = process.env.CLAUDE_PR_AUTOMERGE_ENABLED;
  const gh = recorder();
  try {
    delete process.env.CLAUDE_PR_AUTOMERGE_ENABLED;
    assert.deepEqual(gitOps.mergePR(7, {}, gh), {
      ok: true,
      merged: false,
      reason: 'automerge_disabled',
    });
    assert.deepEqual(gh.calls, []);

    process.env.CLAUDE_PR_AUTOMERGE_ENABLED = 'true';
    const result = gitOps.mergePR(7, { method: 'squash' }, gh);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.merged, true);
    assert.deepEqual(gh.calls.map((call) => call.args), [
      ['pr', 'merge', '7', '--squash'],
    ]);
  } finally {
    if (original === undefined) delete process.env.CLAUDE_PR_AUTOMERGE_ENABLED;
    else process.env.CLAUDE_PR_AUTOMERGE_ENABLED = original;
  }
}

function testCreateRevertPrUsesMockableGitAndGh() {
  const git = recorder();
  const gh = recorder({
    'pr create --base main --head claude/revert-abc1234 --title Revert test --body body': 'https://github.com/example/repo/pull/9\n',
    'pr view https://github.com/example/repo/pull/9 --json number,url': '{"number":9,"url":"https://github.com/example/repo/pull/9"}\n',
  });
  const result = gitOps.createRevertPR({
    mergeCommit: 'abc1234',
    branch: 'claude/revert-abc1234',
    title: 'Revert test',
    body: 'body',
    switchBack: false,
  }, { gitFn: git, ghFn: gh, cwd: '/repo' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.prNumber, 9);
  assert.deepEqual(git.calls.map((call) => call.args), [
    ['switch', '-c', 'claude/revert-abc1234'],
    ['revert', '--no-edit', 'abc1234'],
    ['check-ref-format', '--branch', 'claude/revert-abc1234'],
    ['push', 'origin', 'HEAD:claude/revert-abc1234'],
  ]);
  assert.deepEqual(gh.calls.map((call) => call.args), [
    ['pr', 'create', '--base', 'main', '--head', 'claude/revert-abc1234', '--title', 'Revert test', '--body', 'body'],
    ['pr', 'view', 'https://github.com/example/repo/pull/9', '--json', 'number,url'],
  ]);
}

function testCreateRevertPrCleansRemoteBranchOnPrFailure() {
  const git = recorder();
  const gh = recorder({
    'pr create --base main --head claude/revert-fail --title Revert fail --body body': new Error('gh failed'),
  });
  const result = gitOps.createRevertPR({
    mergeCommit: 'def4567',
    branch: 'claude/revert-fail',
    title: 'Revert fail',
    body: 'body',
    switchBack: false,
  }, { gitFn: git, ghFn: gh, cwd: '/repo' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.branchCleanup.deleted, true);
  assert.deepEqual(git.calls.map((call) => call.args), [
    ['switch', '-c', 'claude/revert-fail'],
    ['revert', '--no-edit', 'def4567'],
    ['check-ref-format', '--branch', 'claude/revert-fail'],
    ['push', 'origin', 'HEAD:claude/revert-fail'],
    ['push', 'origin', '--delete', 'claude/revert-fail'],
  ]);
}

function testCreateRevertPrRejectsOptionLikeCommit() {
  const git = recorder();
  const result = gitOps.createRevertPR({ mergeCommit: '--abort', switchBack: false }, { gitFn: git });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /flags not allowed/);
  assert.deepEqual(git.calls, []);
}

testRunGitMockableHelpers();
testCommitFileUsesPathScopedCommit();
testPushRefSecurity();
testRollbackAndOriginContains();
testCreatePrUsesGhAndReturnsViewResult();
testCreatePrFailureDoesNotThrow();
testMergePrRequiresEnvGate();
testCreateRevertPrUsesMockableGitAndGh();
testCreateRevertPrCleansRemoteBranchOnPrFailure();
testCreateRevertPrRejectsOptionLikeCommit();

console.log('git-ops tests ok');
