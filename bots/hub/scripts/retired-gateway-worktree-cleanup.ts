#!/usr/bin/env tsx

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const retiredName = ['open', 'claw'].join('');
const worktreeRoot = path.join(os.homedir(), `.${retiredName}`, 'workspace', 'claude-auto-dev-worktrees');
const lockRoot = path.join(os.homedir(), `.${retiredName}`, 'workspace', 'claude-auto-dev-job-locks');

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function run(command: string, args: string[]) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function registeredRetiredWorktrees(): string[] {
  const result = run('git', ['worktree', 'list', '--porcelain']);
  if (Number(result.status) !== 0) return [];
  return String(result.stdout || '')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter((entry) => entry.startsWith(`${worktreeRoot}${path.sep}`));
}

function isSafeStatus(worktreePath: string): boolean {
  const result = run('git', ['-C', worktreePath, 'status', '--porcelain=v1', '--untracked-files=all']);
  if (Number(result.status) !== 0) return false;
  const lines = String(result.stdout || '').trim().split('\n').filter(Boolean);
  return lines.length === 0 || lines.every((line) => /^\?\?\s+node_modules\/?/.test(line));
}

function lockPathFor(worktreePath: string): string {
  const name = path.basename(worktreePath);
  const jobId = name.split('-')[0];
  return path.join(lockRoot, `${jobId}.lock`);
}

function main(): void {
  const apply = hasFlag('apply');
  const worktrees = registeredRetiredWorktrees();
  const results = worktrees.map((worktreePath) => {
    const safe = isSafeStatus(worktreePath);
    const item: Record<string, unknown> = {
      path: worktreePath,
      safe_to_remove: safe,
      removed: false,
    };
    if (apply && safe) {
      const removed = run('git', ['worktree', 'remove', '--force', worktreePath]);
      item.removed = Number(removed.status) === 0;
      if (item.removed) {
        const lockPath = lockPathFor(worktreePath);
        if (fs.existsSync(lockPath)) {
          fs.rmSync(lockPath, { force: true });
          item.lock_removed = true;
        }
      } else {
        item.error = String(removed.stderr || removed.stdout || removed.status).slice(0, 240);
      }
    }
    return item;
  });

  if (apply && results.some((item) => item.removed)) {
    run('git', ['worktree', 'prune', '-v']);
  }

  console.log(JSON.stringify({
    ok: results.every((item) => item.safe_to_remove !== false || item.removed === false),
    dry_run: !apply,
    retired_worktrees: results,
  }, null, 2));
}

main();
