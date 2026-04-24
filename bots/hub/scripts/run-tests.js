#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  return Number(result.status ?? 1);
}

function main() {
  const args = process.argv.slice(2).filter(Boolean);
  const target = args.find((arg) => !arg.startsWith('-')) || 'secrets-meta';

  if (target === 'secrets-meta') {
    process.exit(run(process.execPath, ['--test', '__tests__/secrets-meta.node.test.js']));
  }

  console.error(`[hub test] unknown target: ${target}`);
  console.error('[hub test] supported targets: secrets-meta');
  process.exit(1);
}

main();
