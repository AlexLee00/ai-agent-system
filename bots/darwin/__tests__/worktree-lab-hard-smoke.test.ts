'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { createLab, removeLab } = require('../lib/worktree-lab.ts');

const repoRoot = path.resolve(__dirname, '../../..');

function git(args: string[], cwd = repoRoot): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function main() {
  const rootBranches: string[] = [];
  const recordRoot = (label: string) => {
    const branch = git(['branch', '--show-current']);
    rootBranches.push(`${label}:${branch}`);
    assert.strictEqual(branch, 'main', `OPS root branch drift at ${label}: ${branch}`);
  };

  recordRoot('start');
  const stamp = Date.now();
  const branchName = `darwin/lab-smoke-${stamp}`;
  const lab = createLab(branchName);
  try {
    recordRoot('after-createLab');
    const relPath = `bots/darwin/experimental/lab-smoke-${stamp}.txt`;
    const fullPath = path.join(lab.path, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, `lab smoke ${stamp}\n`, 'utf8');
    git(['add', relPath], lab.path);
    git([
      '-c',
      'user.name=Darwin Lab Smoke',
      '-c',
      'user.email=darwin-lab-smoke@example.invalid',
      'commit',
      '-m',
      `test(darwin): lab smoke ${stamp}`,
    ], lab.path);
    recordRoot('after-lab-commit');
  } finally {
    try {
      removeLab(lab.path);
    } catch {}
    try {
      git(['branch', '-D', branchName]);
    } catch {}
  }
  recordRoot('after-cleanup');
  console.log(JSON.stringify({ ok: true, rootBranches, branchName }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
