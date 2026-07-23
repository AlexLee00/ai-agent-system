'use strict';

/**
 * Darwin worktree lab helpers.
 *
 * Invariant: this module never checks out or switches the OPS root branch.
 */

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { execFileSync }: typeof import('child_process') = require('child_process');
const env: { PROJECT_ROOT: string } = require('../../../packages/core/lib/env');
const telemetry = require('./telemetry');

type ExecFileOptions = Omit<import('child_process').ExecFileSyncOptionsWithStringEncoding, 'encoding'>;

interface GitRunner {
  (args: string[], opts?: ExecFileOptions & { cwd?: string }): string;
}

interface LabOptions {
  repoRoot?: string;
  labRoot?: string;
  baseRef?: string;
  runGit?: GitRunner;
  env?: NodeJS.ProcessEnv;
}

interface LabRecord {
  branchName: string;
  path: string;
  labRoot: string;
  baseRef: string;
}

function defaultRunGit(args: string[], opts: ExecFileOptions & { cwd?: string } = {}): string {
  return execFileSync('git', args, {
    cwd: opts.cwd || env.PROJECT_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim();
}

function toErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const maybe = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
    return String(maybe.stderr || maybe.stdout || maybe.message || 'unknown error');
  }
  return String(error || 'unknown error');
}

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function getLabRoot(options: LabOptions = {}): string {
  const envObj = options.env || process.env;
  const raw = options.labRoot || envObj.DARWIN_LAB_ROOT || '~/.ai-agent-system/workspace/darwin/labs';
  return path.resolve(expandHome(raw));
}

function sanitizeBranchForPath(branchName: string): string {
  const raw = String(branchName || '').trim();
  if (!raw || raw.startsWith('/') || raw.includes('\0') || raw.split('/').includes('..')) {
    throw new Error(`invalid_lab_branch:${branchName}`);
  }
  return raw.replace(/[^a-zA-Z0-9._/-]+/g, '-').replace(/\/+/g, '/');
}

function resolveLabPath(branchName: string, options: LabOptions = {}): string {
  const labRoot = getLabRoot(options);
  const safeBranch = sanitizeBranchForPath(branchName);
  const basePath = path.resolve(labRoot, safeBranch);
  if (!(basePath === labRoot || basePath.startsWith(`${labRoot}${path.sep}`))) {
    throw new Error(`lab_path_escape_blocked:${branchName}`);
  }
  if (!fs.existsSync(basePath)) return basePath;
  return `${basePath}-${Date.now()}`;
}

function createLab(branchName: string, options: LabOptions = {}): LabRecord {
  const repoRoot = options.repoRoot || env.PROJECT_ROOT;
  const baseRef = options.baseRef || 'main';
  const runGit = options.runGit || defaultRunGit;
  const labRoot = getLabRoot(options);
  const labPath = resolveLabPath(branchName, { ...options, labRoot });
  fs.mkdirSync(path.dirname(labPath), { recursive: true });

  try {
    runGit(['worktree', 'add', labPath, '-b', branchName, baseRef], { cwd: repoRoot });
  } catch (error) {
    const message = toErrorMessage(error);
    if (!/already exists|a branch named|invalid reference/i.test(message)) throw error;
    runGit(['worktree', 'add', labPath, branchName], { cwd: repoRoot });
  }

  telemetry.recordTelemetry({
    phase: 'worktree_lab',
    event: 'create',
    branchName,
    labPath,
    baseRef,
  });
  return { branchName, path: labPath, labRoot, baseRef };
}

function removeLab(labPath: string, options: LabOptions = {}): { removed: boolean; pruned: boolean } {
  const repoRoot = options.repoRoot || env.PROJECT_ROOT;
  const runGit = options.runGit || defaultRunGit;
  const labRoot = getLabRoot(options);
  const resolved = path.resolve(labPath || '.');
  if (resolved === labRoot) throw new Error(`lab_remove_root_forbidden:${resolved}`);
  if (!resolved.startsWith(`${labRoot}${path.sep}`)) throw new Error(`lab_remove_outside_root:${resolved}`);
  const registered = listLabs({ ...options, repoRoot, labRoot, runGit })
    .some((lab) => path.resolve(lab.path) === resolved);
  if (!registered) throw new Error(`lab_remove_unregistered:${resolved}`);
  runGit(['worktree', 'remove', '--force', resolved], { cwd: repoRoot });
  runGit(['worktree', 'prune'], { cwd: repoRoot });
  telemetry.recordTelemetry({
    phase: 'worktree_lab',
    event: 'remove',
    labPath: resolved,
  });
  return { removed: true, pruned: true };
}

function isInsideLab(cwd: string, options: LabOptions = {}): boolean {
  const labRoot = getLabRoot(options);
  const resolved = path.resolve(cwd || '.');
  return resolved === labRoot || resolved.startsWith(`${labRoot}${path.sep}`);
}

function listLabs(options: LabOptions = {}): LabRecord[] {
  const repoRoot = options.repoRoot || env.PROJECT_ROOT;
  const runGit = options.runGit || defaultRunGit;
  const labRoot = getLabRoot(options);
  const output = runGit(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  const labs: LabRecord[] = [];
  let currentPath = '';
  let currentBranch = '';

  const flush = () => {
    if (currentPath && isInsideLab(currentPath, { ...options, labRoot })) {
      labs.push({
        branchName: currentBranch.replace(/^refs\/heads\//, ''),
        path: currentPath,
        labRoot,
        baseRef: '',
      });
    }
    currentPath = '';
    currentBranch = '';
  };

  for (const line of String(output || '').split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      currentPath = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ')) {
      currentBranch = line.slice('branch '.length).trim();
    }
  }
  flush();
  return labs;
}

module.exports = {
  createLab,
  removeLab,
  listLabs,
  isInsideLab,
  getLabRoot,
  resolveLabPath,
  _testOnly_defaultRunGit: defaultRunGit,
};
