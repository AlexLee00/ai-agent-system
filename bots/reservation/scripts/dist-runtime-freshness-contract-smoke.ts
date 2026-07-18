#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  computeFileHash,
  computeSourcesHash,
  findStaleDist,
} = require('./dist-runtime-drift-smoke');

function writeManifest(manifestPath, dist, sources, root) {
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    sourceHash: computeSourcesHash(sources, root),
    bundleHash: computeFileHash(dist),
  }));
}

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ska-dist-freshness-'));
  try {
    const dist = path.join(root, 'daemon.cjs');
    const manifest = `${dist}.manifest.json`;
    const sourceA = path.join(root, 'entry.ts');
    const sourceB = path.join(root, 'dependency.ts');
    fs.writeFileSync(sourceA, 'export const a = 1;');
    fs.writeFileSync(sourceB, 'export const b = 1;');
    fs.writeFileSync(dist, 'bundle-v1');
    writeManifest(manifest, dist, [sourceA, sourceB], root);

    const targets = [{ dist, manifest, sources: [sourceA, sourceB] }];
    assert.deepEqual(findStaleDist(targets, root), [], 'matching source and bundle hashes must pass');

    fs.writeFileSync(sourceB, 'export const b = 2;');
    fs.utimesSync(dist, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    const stale = findStaleDist(targets, root);
    assert.equal(stale.length, 1, 'changed transitive source content must fail regardless of mtime');
    assert.equal(stale[0].reason, 'source_hash_mismatch');

    writeManifest(manifest, dist, [sourceA, sourceB], root);
    fs.writeFileSync(dist, 'tampered-bundle');
    const tampered = findStaleDist(targets, root);
    assert.equal(tampered.length, 1, 'tampered bundle content must fail freshness');
    assert.equal(tampered[0].reason, 'bundle_hash_mismatch');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  process.stdout.write('dist-runtime-freshness-contract-smoke: ok\n');
}

main();
