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

function normalizeGitCall(gitFnOrOptions = runGit, options = {}) {
  if (typeof gitFnOrOptions === 'function') {
    return { gitFn: gitFnOrOptions, options: options || {} };
  }
  return { gitFn: runGit, options: gitFnOrOptions || {} };
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

module.exports = {
  ROOT,
  runGit,
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
  originContains,
  rollbackToHead,
};
