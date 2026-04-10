#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '../../..');
const MAX_AGE_DAYS = 7;

function runGit(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function parseBranchRows(raw) {
  return String(raw || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, unix] = line.split('\t');
      return {
        name: String(name || '').trim(),
        unix: Number(unix || 0),
      };
    })
    .filter((row) => row.name.startsWith('darwin/'));
}

function main() {
  const cutoffUnix = Math.floor(Date.now() / 1000) - MAX_AGE_DAYS * 24 * 60 * 60;
  const raw = runGit(['for-each-ref', '--format=%(refname:short)\t%(committerdate:unix)', 'refs/heads/darwin']);
  const rows = parseBranchRows(raw);
  const deleted = [];

  for (const row of rows) {
    if (!row.unix || row.unix >= cutoffUnix) continue;
    runGit(['branch', '-D', row.name]);
    deleted.push(row.name);
  }

  console.log(JSON.stringify({
    ok: true,
    scanned: rows.length,
    deleted: deleted.length,
    branches: deleted,
  }, null, 2));
}

main();
