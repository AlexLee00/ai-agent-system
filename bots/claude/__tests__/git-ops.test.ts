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

testRunGitMockableHelpers();
testCommitFileUsesPathScopedCommit();
testPushRefSecurity();
testRollbackAndOriginContains();

console.log('git-ops tests ok');
