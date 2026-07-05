#!/usr/bin/env node
// @ts-nocheck
'use strict';

const { runCommentStrategyEvolver } = require('../lib/comment-strategy-evolver.ts');

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function main() {
  const report = await runCommentStrategyEvolver({
    days: Math.max(1, Math.min(90, Number(argValue('days', 7)) || 7)),
    write: hasFlag('write') && hasFlag('no-dry-run'),
  });
  if (hasFlag('json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`[comment-strategy-evolver] source=${report.source} events=${report.totalEvents} proposals=${report.proposals.length}`);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  process.exit(1);
});
