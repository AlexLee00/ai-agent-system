#!/usr/bin/env node
// @ts-nocheck
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { createHash } = require('node:crypto');
const { build } = require('esbuild');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const TARGETS = [
  path.join(PROJECT_ROOT, 'dist/ts-runtime/bots/reservation/auto/monitors/naver-monitor.js'),
  path.join(PROJECT_ROOT, 'dist/ts-runtime/bots/reservation/auto/monitors/naver-monitor.js.map'),
  path.join(PROJECT_ROOT, 'dist/daemons/ai.ska.naver-monitor.cjs'),
  path.join(PROJECT_ROOT, 'dist/daemons/ai.ska.pickko-accurate.cjs'),
  path.join(PROJECT_ROOT, 'dist/daemons/ai.ska.pickko-pay-pending.cjs'),
  path.join(PROJECT_ROOT, 'dist/daemons/ai.ska.pickko-verify.cjs'),
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
const FRESHNESS_DEFINITIONS = [
  {
    dist: path.join(PROJECT_ROOT, 'dist/daemons/ai.ska.naver-monitor.cjs'),
    manifest: path.join(PROJECT_ROOT, 'dist/daemons/ai.ska.naver-monitor.cjs.manifest.json'),
    entry: path.join(PROJECT_ROOT, 'bots/reservation/auto/monitors/naver-monitor.ts'),
  },
  {
    dist: path.join(PROJECT_ROOT, 'dist/daemons/ai.ska.pickko-accurate.cjs'),
    manifest: path.join(PROJECT_ROOT, 'dist/daemons/ai.ska.pickko-accurate.cjs.manifest.json'),
    entry: path.join(PROJECT_ROOT, 'bots/reservation/manual/reservation/pickko-accurate.ts'),
  },
  {
    dist: path.join(PROJECT_ROOT, 'dist/daemons/ai.ska.pickko-pay-pending.cjs'),
    manifest: path.join(PROJECT_ROOT, 'dist/daemons/ai.ska.pickko-pay-pending.cjs.manifest.json'),
    entry: path.join(PROJECT_ROOT, 'bots/reservation/manual/reports/pickko-pay-pending.ts'),
  },
  {
    dist: path.join(PROJECT_ROOT, 'dist/daemons/ai.ska.pickko-verify.cjs'),
    manifest: path.join(PROJECT_ROOT, 'dist/daemons/ai.ska.pickko-verify.cjs.manifest.json'),
    entry: path.join(PROJECT_ROOT, 'bots/reservation/manual/admin/pickko-verify.ts'),
  },
];

function computeFileHash(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function computeSourcesHash(sources, root = PROJECT_ROOT) {
  const hash = createHash('sha256');
  for (const source of [...sources].sort()) {
    const relative = path.relative(root, source).split(path.sep).join('/');
    hash.update(relative);
    hash.update('\0');
    hash.update(fs.readFileSync(source));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function collectTransitiveSources(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: ['node26'],
    format: 'cjs',
    write: false,
    metafile: true,
    absWorkingDir: PROJECT_ROOT,
    logLevel: 'silent',
    packages: 'external',
    tsconfig: path.join(PROJECT_ROOT, 'tsconfig.json'),
  });
  return Object.keys(result.metafile.inputs).map((input) => (
    path.isAbsolute(input) ? input : path.join(PROJECT_ROOT, input)
  ));
}

function findStaleDist(targets, root = PROJECT_ROOT) {
  const staleDist = [];
  for (const target of targets) {
    assert.ok(fs.existsSync(target.dist), `missing dist daemon target: ${target.dist}`);
    for (const source of target.sources) {
      assert.ok(fs.existsSync(source), `missing freshness source: ${source}`);
    }
    if (!target.manifest || !fs.existsSync(target.manifest)) {
      staleDist.push({
        dist: path.relative(root, target.dist),
        reason: 'manifest_missing',
      });
      continue;
    }

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(target.manifest, 'utf8'));
    } catch {
      staleDist.push({ dist: path.relative(root, target.dist), reason: 'manifest_invalid' });
      continue;
    }
    if (manifest.version !== 1) {
      staleDist.push({ dist: path.relative(root, target.dist), reason: 'manifest_invalid' });
      continue;
    }

    const sourceHash = computeSourcesHash(target.sources, root);
    if (manifest.sourceHash !== sourceHash) {
      staleDist.push({ dist: path.relative(root, target.dist), reason: 'source_hash_mismatch' });
      continue;
    }

    const bundleHash = computeFileHash(target.dist);
    if (manifest.bundleHash !== bundleHash) {
      staleDist.push({ dist: path.relative(root, target.dist), reason: 'bundle_hash_mismatch' });
    }
  }
  return staleDist;
}

async function main() {
  const failures = [];
  for (const target of TARGETS) {
    assert.ok(fs.existsSync(target), `missing dist runtime target: ${target}`);
    const text = fs.readFileSync(target, 'utf8');
    for (const symbol of REMOVED_SYMBOLS) {
      if (text.includes(symbol)) failures.push(`${path.relative(PROJECT_ROOT, target)}:${symbol}`);
    }
  }

  const freshnessTargets = [];
  for (const target of FRESHNESS_DEFINITIONS) {
    freshnessTargets.push({
      ...target,
      sources: await collectTransitiveSources(target.entry),
    });
  }
  const staleDist = findStaleDist(freshnessTargets);

  if (failures.length > 0 || staleDist.length > 0) {
    console.error(JSON.stringify({ ok: false, staleSymbols: failures, staleDistWarnings: staleDist }, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({
    ok: true,
    checked: TARGETS.map((target) => path.relative(PROJECT_ROOT, target)),
    removedSymbols: REMOVED_SYMBOLS,
    freshnessChecked: freshnessTargets.map((target) => ({
      dist: path.relative(PROJECT_ROOT, target.dist),
      entry: path.relative(PROJECT_ROOT, target.entry),
      sourceCount: target.sources.length,
    })),
    staleDistWarnings: staleDist,
  }));
}

module.exports = {
  collectTransitiveSources,
  computeFileHash,
  computeSourcesHash,
  findStaleDist,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}
