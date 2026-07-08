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
  path.join(PROJECT_ROOT, 'dist/daemons/ai.ska.naver-monitor.cjs'),
  path.join(PROJECT_ROOT, 'dist/daemons/ai.ska.pickko-accurate.cjs'),
];
const REMOVED_SYMBOLS = [
  'futureCancelService',
  'createNaverFutureCancelService',
  'naver-future-cancel-service',
  'naver_future_confirmed',
  'upsertFutureConfirmed',
  'getStaleConfirmed',
  'deleteStaleConfirmed',
  'pruneOldFutureConfirmed',
];
const FRESHNESS_TARGETS = [
  {
    dist: path.join(PROJECT_ROOT, 'dist/daemons/ai.ska.naver-monitor.cjs'),
    sources: [
      path.join(PROJECT_ROOT, 'bots/reservation/auto/monitors/naver-monitor.ts'),
      path.join(PROJECT_ROOT, 'bots/reservation/lib/db.ts'),
      path.join(PROJECT_ROOT, 'bots/reservation/lib/naver-cancel-detection-service.ts'),
    ],
  },
  {
    dist: path.join(PROJECT_ROOT, 'dist/daemons/ai.ska.pickko-accurate.cjs'),
    sources: [
      path.join(PROJECT_ROOT, 'bots/reservation/manual/reservation/pickko-accurate.ts'),
      path.join(PROJECT_ROOT, 'bots/reservation/lib/db.ts'),
    ],
  },
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

  const staleDist = [];
  for (const target of FRESHNESS_TARGETS) {
    assert.ok(fs.existsSync(target.dist), `missing dist daemon target: ${target.dist}`);
    const distStat = fs.statSync(target.dist);
    let newestSource = null;
    for (const source of target.sources) {
      assert.ok(fs.existsSync(source), `missing freshness source: ${source}`);
      const sourceStat = fs.statSync(source);
      if (!newestSource || sourceStat.mtimeMs > newestSource.mtimeMs) {
        newestSource = { source, mtimeMs: sourceStat.mtimeMs };
      }
    }
    if (newestSource && distStat.mtimeMs < newestSource.mtimeMs) {
      staleDist.push({
        dist: path.relative(PROJECT_ROOT, target.dist),
        newestSource: path.relative(PROJECT_ROOT, newestSource.source),
        distMtimeMs: distStat.mtimeMs,
        sourceMtimeMs: newestSource.mtimeMs,
      });
    }
  }

  if (failures.length > 0) {
    console.error(JSON.stringify({ ok: false, staleSymbols: failures, staleDistWarnings: staleDist }, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({
    ok: true,
    checked: TARGETS.map((target) => path.relative(PROJECT_ROOT, target)),
    removedSymbols: REMOVED_SYMBOLS,
    freshnessChecked: FRESHNESS_TARGETS.map((target) => ({
      dist: path.relative(PROJECT_ROOT, target.dist),
      sources: target.sources.map((source) => path.relative(PROJECT_ROOT, source)),
    })),
    staleDistWarnings: staleDist,
  }));
}

main();
