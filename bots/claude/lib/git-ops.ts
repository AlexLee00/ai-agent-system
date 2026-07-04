// @ts-nocheck
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const env = require('../../../packages/core/lib/env');

const ROOT = env.PROJECT_ROOT || path.resolve(__dirname, '..', '..', '..');

function runGit(args = [], opts = {}) {
  if (!Array.isArray(args)) throw new Error('git args must be an array');
  const { raw = false, cwd = ROOT, timeout = 30000 } = opts || {};
  return execFileSync('git', args, {
    cwd,
    timeout,
    encoding: raw ? undefined : 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runGh(args = [], opts = {}) {
  if (!Array.isArray(args)) throw new Error('gh args must be an array');
  const { raw = false, cwd = ROOT, timeout = 30000 } = opts || {};
  return execFileSync('gh', args, {
    cwd,
    timeout,
    encoding: raw ? undefined : 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function normalizeGitCall(gitFnOrOptions = runGit, options = {}) {
  if (typeof gitFnOrOptions === 'function') {
    return { gitFn: gitFnOrOptions, options: options || {} };
  }
  return { gitFn: runGit, options: gitFnOrOptions || {} };
}

function normalizeGhCall(ghFnOrOptions = runGh, options = {}) {
  if (typeof ghFnOrOptions === 'function') {
    return { ghFn: ghFnOrOptions, options: options || {} };
  }
  return { ghFn: runGh, options: ghFnOrOptions || {} };
}

function asText(value) {
  return String(value || '').trim();
}

function asTrimEndText(value) {
  return String(value || '').trimEnd();
}

function currentHead(gitFnOrOptions = runGit, options = {}) {
  const call = normalizeGitCall(gitFnOrOptions, options);
  return asText(call.gitFn(['rev-parse', 'HEAD'], call.options));
}

function currentBranch(gitFnOrOptions = runGit, options = {}) {
  const call = normalizeGitCall(gitFnOrOptions, options);
  return asText(call.gitFn(['rev-parse', '--abbrev-ref', 'HEAD'], call.options));
}

function isRepo(cwd = ROOT, gitFn = runGit) {
  try {
    gitFn(['rev-parse', '--is-inside-work-tree'], { cwd, timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

function statusShort(cwd = ROOT, gitFn = runGit) {
  return asTrimEndText(gitFn(['status', '--short'], { cwd, timeout: 20000 }));
}

function statusPorcelain(cwd = ROOT, gitFn = runGit) {
  return asTrimEndText(gitFn(['status', '--porcelain'], { cwd, timeout: 20000 }));
}

function log(n = 1, gitFnOrOptions = runGit, options = {}) {
  const call = normalizeGitCall(gitFnOrOptions, options);
  const count = Math.max(1, Math.min(200, Math.floor(Number(n) || 1)));
  return String(call.gitFn(['log', '--oneline', `-${count}`], call.options) || '');
}

function stashList(gitFnOrOptions = runGit, options = {}) {
  const call = normalizeGitCall(gitFnOrOptions, options);
  return asText(call.gitFn(['stash', 'list'], call.options));
}

function diffNames(ref = 'HEAD', gitFnOrOptions = runGit, options = {}) {
  const call = normalizeGitCall(gitFnOrOptions, options);
  return String(call.gitFn(['diff', '--name-only', ref], call.options) || '');
}

function diffBinary(files = [], gitFnOrOptions = runGit, options = {}) {
  const call = normalizeGitCall(gitFnOrOptions, options);
  const list = Array.isArray(files) ? files : [files];
  return call.gitFn(['diff', '--binary', '--', ...list], { ...call.options, raw: true, timeout: call.options.timeout || 120000 });
}

function add(files = [], cwd = ROOT, gitFn = runGit) {
  const list = Array.isArray(files) ? files : [files];
  return gitFn(['add', '--', ...list], { cwd, timeout: 60000 });
}

function commit(message, gitFnOrOptions = runGit, options = {}) {
  const call = normalizeGitCall(gitFnOrOptions, options);
  return call.gitFn(['commit', '-m', String(message || 'update')], { ...call.options, timeout: call.options.timeout || 120000 });
}

function commitFile(file, message, gitFnOrOptions = runGit, options = {}) {
  const call = normalizeGitCall(gitFnOrOptions, options);
  const cwd = call.options.cwd || ROOT;
  call.gitFn(['add', '--', file], { cwd, timeout: 60000 });
  call.gitFn(['commit', '-m', message, '--', file], { cwd, timeout: 120000 });
  return currentHead(call.gitFn, { cwd, timeout: 10000 });
}

function switchBranch(branch, gitFnOrOptions = runGit, options = {}) {
  const call = normalizeGitCall(gitFnOrOptions, options);
  return call.gitFn(['switch', branch], { ...call.options, timeout: call.options.timeout || 60000 });
}

function worktreeAdd(worktreePath, sha, gitFnOrOptions = runGit, options = {}) {
  const call = normalizeGitCall(gitFnOrOptions, options);
  return call.gitFn(['worktree', 'add', '--detach', worktreePath, sha], { ...call.options, timeout: call.options.timeout || 20000 });
}

function resetHard(ref, gitFnOrOptions = runGit, options = {}) {
  const call = normalizeGitCall(gitFnOrOptions, options);
  return call.gitFn(['reset', '--hard', ref], { ...call.options, timeout: call.options.timeout || 60000 });
}

function validatePushRef(ref, gitFn = runGit, options = {}) {
  const value = String(ref || 'HEAD').trim();
  if (!value) throw new Error('push ref is required');
  if (value.startsWith('-')) throw new Error(`flags not allowed: ${value}`);
  if (value.includes(':')) throw new Error(`refspec not allowed: ${value}`);
  if (value !== 'HEAD') {
    if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.includes('..') || value.includes('@{') || value.endsWith('.lock')) {
      throw new Error(`invalid ref: ${value}`);
    }
    try {
      gitFn(['check-ref-format', '--branch', value], { cwd: options.cwd || ROOT, timeout: 10000 });
    } catch {
      throw new Error(`invalid ref: ${value}`);
    }
  }
  return value;
}

function validateBranchName(ref, label = 'branch') {
  const value = String(ref || '').trim();
  if (!value) throw new Error(`${label} is required`);
  if (value.startsWith('-')) throw new Error(`flags not allowed: ${value}`);
  if (value.includes(':')) throw new Error(`refspec not allowed: ${value}`);
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.includes('..') || value.includes('@{') || value.endsWith('.lock')) {
    throw new Error(`invalid ${label}: ${value}`);
  }
  return value;
}

function pushRef(ref = 'HEAD', gitFnOrOptions = runGit, options = {}) {
  const call = normalizeGitCall(gitFnOrOptions, options);
  const safeRef = validatePushRef(ref, call.gitFn, call.options);
  return call.gitFn(['push', 'origin', safeRef], { ...call.options, timeout: call.options.timeout || 120000 });
}

function pushHeadToBranch(branch, gitFnOrOptions = runGit, options = {}) {
  const call = normalizeGitCall(gitFnOrOptions, options);
  const safeBranch = validatePushRef(branch, call.gitFn, call.options);
  if (safeBranch === 'HEAD') throw new Error('target branch must not be HEAD');
  return call.gitFn(['push', 'origin', `HEAD:${safeBranch}`], { ...call.options, timeout: call.options.timeout || 120000 });
}

function originContains(sha, gitFn = runGit) {
  if (!sha) return false;
  const refs = new Set(['origin/main']);
  try {
    const branch = asText(gitFn(['rev-parse', '--abbrev-ref', 'HEAD']));
    if (branch && branch !== 'HEAD') refs.add(`origin/${branch}`);
  } catch {}
  try {
    const upstream = asText(gitFn(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']));
    if (upstream) refs.add(upstream);
  } catch {}
  try {
    gitFn(['fetch', 'origin']);
  } catch {}
  for (const ref of refs) {
    try {
      gitFn(['merge-base', '--is-ancestor', sha, ref]);
      return true;
    } catch {}
  }
  return false;
}

function rollbackToHead(head, file = null, gitFn = runGit) {
  if (!head) throw new Error('rollback_head_missing');
  gitFn(['reset', '--soft', head]);
  if (file) gitFn(['reset', '--', file]);
  return { ok: true };
}

function parseJson(text) {
  try {
    return JSON.parse(String(text || '{}'));
  } catch {
    return null;
  }
}

function summarizeToolError(error) {
  const stderr = error?.stderr ? String(error.stderr) : '';
  const stdout = error?.stdout ? String(error.stdout) : '';
  const message = error?.message ? String(error.message) : String(error || 'unknown_error');
  return [stderr, stdout, message].filter(Boolean).join('\n').trim().slice(0, 2000);
}

function createPR(input = {}, ghFnOrOptions = runGh, options = {}) {
  const call = normalizeGhCall(ghFnOrOptions, options);
  try {
    const head = validateBranchName(input.head, 'head');
    const base = validateBranchName(input.base || 'main', 'base');
    const title = String(input.title || '').trim();
    if (!title) throw new Error('title is required');
    const body = String(input.body || '');
    const created = asText(call.ghFn([
      'pr',
      'create',
      '--base',
      base,
      '--head',
      head,
      '--title',
      title,
      '--body',
      body,
    ], { ...call.options, timeout: call.options.timeout || 120000 }));
    const viewTarget = created || head;
    const viewed = parseJson(call.ghFn([
      'pr',
      'view',
      viewTarget,
      '--json',
      'number,url',
    ], { ...call.options, timeout: call.options.timeout || 30000 }));
    return {
      ok: true,
      number: viewed?.number || null,
      url: viewed?.url || created || null,
      head,
      base,
    };
  } catch (error) {
    return { ok: false, error: summarizeToolError(error) };
  }
}

function mergePR(prNumber, mergeOptions = {}, ghFnOrOptions = runGh, options = {}) {
  if (process.env.CLAUDE_PR_AUTOMERGE_ENABLED !== 'true') {
    return { ok: true, merged: false, reason: 'automerge_disabled' };
  }
  const call = normalizeGhCall(ghFnOrOptions, options);
  try {
    const number = Math.floor(Number(prNumber));
    if (!Number.isFinite(number) || number <= 0) throw new Error('valid pr number is required');
    const method = String(mergeOptions.method || 'squash').trim().toLowerCase();
    if (!['squash', 'merge', 'rebase'].includes(method)) throw new Error(`invalid merge method: ${method}`);
    const output = asText(call.ghFn([
      'pr',
      'merge',
      String(number),
      `--${method}`,
    ], { ...call.options, timeout: call.options.timeout || 120000 }));
    return { ok: true, merged: true, number, method, output };
  } catch (error) {
    return { ok: false, merged: false, error: summarizeToolError(error) };
  }
}

function cleanupRemoteBranch(branch, gitFn = runGit, options = {}) {
  try {
    gitFn(['push', 'origin', '--delete', branch], { ...options, timeout: options.timeout || 120000 });
    return { attempted: true, deleted: true };
  } catch (error) {
    return { attempted: true, deleted: false, error: summarizeToolError(error) };
  }
}

function validateCommitSha(value, label = 'commit') {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.startsWith('-')) throw new Error(`flags not allowed: ${normalized}`);
  if (!/^[A-Fa-f0-9]{7,64}$/.test(normalized)) throw new Error(`invalid ${label}: ${normalized}`);
  return normalized;
}

function createRevertPR(input = {}, helpers = {}) {
  const gitFn = helpers.gitFn || runGit;
  const ghFn = helpers.ghFn || runGh;
  const cwd = helpers.cwd || ROOT;
  const timeout = helpers.timeout || 120000;
  let mergeCommit = '';
  try {
    mergeCommit = validateCommitSha(input.mergeCommit || input.commit, 'mergeCommit');
  } catch (error) {
    return { ok: false, error: summarizeToolError(error) };
  }

  const branch = validateBranchName(
    input.branch || `claude/revert-${mergeCommit.replace(/[^A-Za-z0-9._/-]+/g, '-').slice(0, 16)}`,
    'revert branch'
  );
  const base = validateBranchName(input.base || 'main', 'base');
  const title = String(input.title || `revert: ${mergeCommit.slice(0, 12)}`).trim();
  const body = String(input.body || [
    'Automated rollback PR prepared by Claude automerge safety.',
    '',
    `- merge_commit: ${mergeCommit}`,
    `- reason: ${input.reason || 'post_merge_failure'}`,
  ].join('\n'));
  let remotePushed = false;
  let originalBranch = null;

  try {
    if (input.switchBack !== false) {
      try { originalBranch = currentBranch(gitFn, { cwd, timeout: 10000 }); } catch {}
    }
    gitFn(['switch', '-c', branch], { cwd, timeout });
    gitFn(['revert', '--no-edit', mergeCommit], { cwd, timeout });
    pushHeadToBranch(branch, gitFn, { cwd, timeout });
    remotePushed = true;
    const pr = createPR({ head: branch, base, title, body }, ghFn, { cwd, timeout });
    if (!pr?.ok) {
      const branchCleanup = cleanupRemoteBranch(branch, gitFn, { cwd, timeout });
      return { ok: false, branch, branchCleanup, error: pr?.error || 'revert_pr_create_failed' };
    }
    return { ok: true, branch, prNumber: pr.number || null, prUrl: pr.url || null, pr };
  } catch (error) {
    const branchCleanup = remotePushed ? cleanupRemoteBranch(branch, gitFn, { cwd, timeout }) : null;
    return { ok: false, branch, branchCleanup, error: summarizeToolError(error) };
  } finally {
    if (originalBranch && originalBranch !== 'HEAD') {
      try { gitFn(['switch', originalBranch], { cwd, timeout: 60000 }); } catch {}
      if (!remotePushed || input.cleanupLocalOnFailure === true) {
        try { gitFn(['branch', '-D', branch], { cwd, timeout: 60000 }); } catch {}
      }
    }
  }
}

module.exports = {
  ROOT,
  runGit,
  runGh,
  currentHead,
  currentBranch,
  isRepo,
  statusShort,
  statusPorcelain,
  log,
  stashList,
  diffNames,
  diffBinary,
  add,
  commit,
  commitFile,
  switchBranch,
  worktreeAdd,
  resetHard,
  pushRef,
  pushHeadToBranch,
  validatePushRef,
  validateBranchName,
  validateCommitSha,
  createPR,
  mergePR,
  createRevertPR,
  originContains,
  rollbackToHead,
};
