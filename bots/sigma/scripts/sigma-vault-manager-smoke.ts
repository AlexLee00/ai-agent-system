#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyParaCategory,
  ensureSigmaVaultStructure,
  readSigmaVaultNote,
  scanSigmaVault,
  searchSigmaVault,
  writeSigmaVaultNote,
} from '../ts/lib/vault-manager.ts';
import { runSigmaVaultClassifier } from './runtime-sigma-vault-classifier.ts';

export async function runSigmaVaultManagerSmoke() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-vault-smoke-'));
  const structure = ensureSigmaVaultStructure(root);
  assert.equal(structure.ok, true);
  assert.equal(fs.existsSync(path.join(root, '00-inbox')), true);
  assert.equal(fs.existsSync(path.join(root, '20-areas', 'luna')), true);

  const note = writeSigmaVaultNote({
    root,
    category: 'inbox',
    title: 'Luna Phase A launchd integration task',
    content: '# Luna Phase A\n\nlaunchd integration task',
    meta: { tags: ['luna', 'phase-a'] },
  });
  assert.equal(note.ok, true);
  assert.match(note.relativePath, /^00-inbox\//u);
  assert.match(readSigmaVaultNote({ root, file: note.relativePath }).content, /category/u);
  assert.equal(scanSigmaVault({ root }).length, 1);
  assert.equal(searchSigmaVault({ root, query: 'launchd' }).length, 1);
  assert.equal(classifyParaCategory({ title: 'research paper', content: 'external community pattern' }), 'resources');

  const dryRun = await runSigmaVaultClassifier({ root, apply: false });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.results[0].category, 'projects');
  assert.equal(fs.existsSync(path.join(root, note.relativePath)), true);

  const applied = await runSigmaVaultClassifier({ root, apply: true });
  assert.equal(applied.moved, 1);
  assert.equal(fs.existsSync(path.join(root, '10-projects', path.basename(note.relativePath))), true);

  return {
    ok: true,
    smoke: 'sigma-vault-manager',
    root,
    moved: applied.moved,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSigmaVaultManagerSmoke()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(`sigma-vault-manager-smoke error: ${error?.message || error}`);
      process.exit(1);
    });
}
