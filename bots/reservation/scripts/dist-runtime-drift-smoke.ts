#!/usr/bin/env node
// @ts-nocheck
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const TARGETS = [
  path.join(PROJECT_ROOT, 'dist/ts-runtime/bots/reservation/auto/monitors/naver-monitor.js'),
  path.join(PROJECT_ROOT, 'dist/ts-runtime/bots/reservation/auto/monitors/naver-monitor.js.map'),
];
const REMOVED_SYMBOLS = [
  'futureCancelService',
  'createNaverFutureCancelService',
  'naver-future-cancel-service',
];

function main() {
  const failures = [];
  for (const target of TARGETS) {
    assert.ok(fs.existsSync(target), `missing dist runtime target: ${target}`);
    const text = fs.readFileSync(target, 'utf8');
    for (const symbol of REMOVED_SYMBOLS) {
      if (text.includes(symbol)) failures.push(`${path.relative(PROJECT_ROOT, target)}:${symbol}`);
    }
  }

  if (failures.length > 0) {
    console.error(JSON.stringify({ ok: false, staleSymbols: failures }, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({
    ok: true,
    checked: TARGETS.map((target) => path.relative(PROJECT_ROOT, target)),
    removedSymbols: REMOVED_SYMBOLS,
  }));
}

main();
