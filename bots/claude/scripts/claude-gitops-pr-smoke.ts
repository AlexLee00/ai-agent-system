#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
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

function runMockSmoke() {
  const gh = recorder({
    'pr create --base main --head claude/auto-dev-smoke --title Smoke PR --body body': 'https://github.com/example/repo/pull/11\n',
    'pr view https://github.com/example/repo/pull/11 --json number,url': '{"number":11,"url":"https://github.com/example/repo/pull/11"}\n',
  });
  const pr = gitOps.createPR({ head: 'claude/auto-dev-smoke', title: 'Smoke PR', body: 'body' }, gh);
  assert.strictEqual(pr.ok, true);
  assert.strictEqual(pr.number, 11);

  const original = process.env.CLAUDE_PR_AUTOMERGE_ENABLED;
  try {
    delete process.env.CLAUDE_PR_AUTOMERGE_ENABLED;
    const disabled = gitOps.mergePR(11, {}, gh);
    assert.strictEqual(disabled.merged, false);
    assert.strictEqual(disabled.reason, 'automerge_disabled');
  } finally {
    if (original === undefined) delete process.env.CLAUDE_PR_AUTOMERGE_ENABLED;
    else process.env.CLAUDE_PR_AUTOMERGE_ENABLED = original;
  }
  return { mock: true, createPrCalls: gh.calls.length };
}

function run(command, args, options = {}) {
  return String(execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout || 120000,
    cwd: options.cwd || process.cwd(),
  }) || '').trim();
}

function runHardLiveSmoke() {
  const status = run('git', ['status', '--porcelain']);
  if (status) throw new Error('hard live PR smoke requires a clean worktree');
  const originalBranch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = `claude/pr-hard-smoke-${Date.now()}`;
  let pr = null;
  let localBranchCreated = false;
  let remoteBranchPushed = false;
  try {
    run('git', ['switch', '-c', branch]);
    localBranchCreated = true;
    run('git', ['commit', '--allow-empty', '-m', 'test: claude pr hard smoke']);
    gitOps.pushHeadToBranch(branch);
    remoteBranchPushed = true;
    pr = gitOps.createPR({
      head: branch,
      base: 'main',
      title: 'test: Claude PR hard smoke',
      body: 'Guarded live smoke for Claude Gen1 PR pipeline. This PR is closed automatically.',
    });
    if (!pr.ok) throw new Error(pr.error || 'create_pr_failed');
    run('gh', ['pr', 'close', String(pr.number || pr.url), '--comment', 'Closing guarded Claude PR hard smoke.']);
    return { skipped: false, branch, prNumber: pr.number || null, prUrl: pr.url || null, closed: true };
  } finally {
    try {
      run('git', ['switch', originalBranch || 'main']);
    } catch {}
    if (localBranchCreated) {
      try { run('git', ['branch', '-D', branch]); } catch {}
    }
    if (remoteBranchPushed) {
      try { run('git', ['push', 'origin', '--delete', branch]); } catch {}
    }
  }
}

async function main() {
  const result = { ok: true, mock: runMockSmoke(), hard: { skipped: true, reason: 'CLAUDE_PR_HARD_SMOKE_ENABLED_not_true' } };
  if (process.env.CLAUDE_PR_HARD_SMOKE_ENABLED === 'true') {
    result.hard = runHardLiveSmoke();
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
