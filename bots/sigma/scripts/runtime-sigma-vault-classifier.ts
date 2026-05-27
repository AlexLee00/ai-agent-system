#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_SIGMA_VAULT_ROOT,
  classifyParaCategory,
  ensureSigmaVaultStructure,
  moveSigmaVaultNote,
  scanSigmaVault,
} from '../ts/lib/vault-manager.ts';

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function titleFromMarkdown(content = '', fallback = 'Untitled') {
  const heading = String(content || '').split('\n').find((line) => /^#\s+/.test(line));
  return heading ? heading.replace(/^#\s+/, '').trim() : fallback;
}

export async function runSigmaVaultClassifier(options = {}) {
  const root = path.resolve(options.root || DEFAULT_SIGMA_VAULT_ROOT);
  const apply = options.apply === true;
  const structure = ensureSigmaVaultStructure(root);
  const inboxRows = scanSigmaVault({ root, category: 'inbox' });
  const results = inboxRows.map((row) => {
    const content = fs.readFileSync(row.path, 'utf8');
    const category = classifyParaCategory({
      title: titleFromMarkdown(content, path.basename(row.relativePath, '.md')),
      content,
    });
    const move = category === 'inbox'
      ? { ok: true, moved: false, reason: 'classified_as_inbox', relativePath: row.relativePath }
      : moveSigmaVaultNote({ root, file: row.relativePath, category, dryRun: !apply });
    return {
      file: row.relativePath,
      category,
      applied: apply && move.moved === true,
      target: move.relativePath || null,
      reason: move.reason || null,
    };
  });
  return {
    ok: true,
    status: apply ? 'sigma_vault_classifier_applied' : 'sigma_vault_classifier_dry_run',
    generatedAt: new Date().toISOString(),
    root,
    structure,
    apply,
    inboxNotes: inboxRows.length,
    moved: results.filter((item) => item.applied).length,
    results,
    safety: {
      llmClassification: 'disabled_by_default',
      fileMoveRequiresApply: true,
      paraRootEscapesBlocked: true,
    },
  };
}

async function main() {
  const result = await runSigmaVaultClassifier({
    root: argValue('root', DEFAULT_SIGMA_VAULT_ROOT),
    apply: hasFlag('apply'),
  });
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`[sigma-vault-classifier] ${result.status} inbox=${result.inboxNotes} moved=${result.moved}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`runtime-sigma-vault-classifier error: ${error?.message || error}`);
    process.exit(1);
  });
}
