#!/usr/bin/env node
// @ts-nocheck
'use strict';

const {
  runBookReviewCollector,
} = require('../lib/book-review-collector.ts');

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safe));
}

async function main() {
  const json = hasFlag('json');
  const write = hasFlag('write');
  const noDryRun = hasFlag('no-dry-run');
  const result = await runBookReviewCollector({
    fixture: hasFlag('fixture'),
    dryRun: !write || !noDryRun || hasFlag('dry-run'),
    save: write,
    limit: boundedNumber(argValue('limit', 12), 12, 1, 30),
    naverLimit: boundedNumber(argValue('naver-limit', 12), 12, 1, 30),
    seedLimit: boundedNumber(argValue('seed-limit', 6), 6, 1, 20),
    categoryLimit: boundedNumber(argValue('category-limit', 2), 2, 1, 4),
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`[book-review-collector] dryRun=${result.dryRun} collected=${result.collected} bySource=${JSON.stringify(result.bySource)}`);
  for (const item of result.items.slice(0, 10)) {
    console.log(`- [${item.source}] ${item.review_title || item.book_title} (${item.genre})`);
  }
}

main().catch((error) => {
  console.error('[book-review-collector] failed:', error?.message || String(error));
  process.exit(1);
});
