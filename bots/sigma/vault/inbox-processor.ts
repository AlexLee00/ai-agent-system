#!/usr/bin/env node
// @ts-nocheck
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from './para-classifier.ts';
import { VaultManager } from './vault-manager.ts';
import {
  DEFAULT_SIGMA_VAULT_ROOT,
  ensureSigmaVaultStructure,
  moveSigmaVaultNote,
  scanSigmaVault,
} from '../ts/lib/vault-manager.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIGMA_ROOT = resolve(__dirname, '..');

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

function modeAllowsMutation(mode) {
  return ['active', 'apply'].includes(String(mode || '').toLowerCase());
}

export async function runInboxProcessor(options = {}) {
  const root = resolve(options.root || DEFAULT_SIGMA_VAULT_ROOT);
  const mode = String(options.mode || process.env.SIGMA_VAULT_PROCESSOR_MODE || 'shadow').toLowerCase();
  const apply = Boolean(options.apply) || (modeAllowsMutation(mode) && hasFlag('apply'));
  const writeDb = Boolean(options.writeDb) || hasFlag('write-db') || ['active', 'db'].includes(mode);
  const useLlm = Boolean(options.useLlm) || hasFlag('llm') || ['true', '1', 'yes'].includes(String(process.env.SIGMA_VAULT_LLM_CLASSIFICATION || '').toLowerCase());
  const startedAt = Date.now();
  const structure = ensureSigmaVaultStructure(root);
  const inboxRows = scanSigmaVault({ root, category: 'inbox' });
  const manager = writeDb ? new VaultManager() : null;
  const results = [];

  for (const row of inboxRows) {
    const content = fs.readFileSync(row.path, 'utf8');
    const title = titleFromMarkdown(content, path.basename(row.relativePath, '.md'));
    const classification = await classify(title, content, { useLlm, timeoutMs: Number(options.timeoutMs || 8000) });
    let db = { ok: true, skipped: true };
    if (manager) {
      db = await manager.addToInbox({
        title,
        type: 'markdown',
        content,
        tags: ['sigma-vault', classification.paraCategory],
        filePath: row.relativePath,
        source: 'vault-inbox-processor',
        libraryCoords: classification.libraryCoords,
        meta: {
          classification,
          mode,
          dryRun: !apply,
        },
      });
    }

    const move = classification.paraCategory === 'inbox'
      ? { ok: true, moved: false, reason: 'classified_as_inbox', relativePath: row.relativePath }
      : moveSigmaVaultNote({
        root,
        file: row.relativePath,
        category: classification.paraCategory,
        dryRun: !apply,
      });
    let dbMove = null;
    if (manager && db?.id && classification.paraCategory !== 'inbox') {
      const moveOpts = {
        dryRun: !apply,
        reasoning: classification.reasoning,
        classifier: classification.classifier,
        confidence: classification.confidence,
      };
      if (classification.paraCategory === 'projects') dbMove = await manager.moveToProject(db.id, 'auto', moveOpts);
      if (classification.paraCategory === 'areas') dbMove = await manager.moveToArea(db.id, 'auto', moveOpts);
      if (classification.paraCategory === 'resources') dbMove = await manager.moveToResource(db.id, 'auto', moveOpts);
      if (classification.paraCategory === 'archives') dbMove = await manager.archive(db.id, classification.reasoning, moveOpts);
    }

    results.push({
      file: row.relativePath,
      title,
      category: classification.paraCategory,
      confidence: classification.confidence,
      classifier: classification.classifier,
      reasoning: classification.reasoning,
      db,
      dbMove,
      moved: Boolean(move.moved),
      applied: Boolean(apply && move.moved),
      target: move.relativePath || null,
      reason: move.reason || null,
    });
  }

  return {
    ok: true,
    status: apply ? 'sigma_vault_inbox_processor_applied' : 'sigma_vault_inbox_processor_shadow',
    generatedAt: new Date().toISOString(),
    root,
    mode,
    apply,
    writeDb,
    useLlm,
    inboxNotes: inboxRows.length,
    processed: results.length,
    moved: results.filter((item) => item.moved).length,
    durationMs: Date.now() - startedAt,
    structure,
    results,
    safety: {
      fileMoveRequiresApply: true,
      dbWriteRequiresWriteDb: true,
      defaultMode: 'shadow',
      liveTradeImpact: false,
      protectedPidImpact: false,
    },
  };
}

async function main() {
  const result = await runInboxProcessor({
    root: argValue('root', DEFAULT_SIGMA_VAULT_ROOT),
    mode: argValue('mode', process.env.SIGMA_VAULT_PROCESSOR_MODE || 'shadow'),
    apply: hasFlag('apply'),
    writeDb: hasFlag('write-db'),
    useLlm: hasFlag('llm'),
    timeoutMs: Number(argValue('timeout-ms', '8000')),
  });
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`[sigma-vault-inbox-processor] ${result.status} inbox=${result.inboxNotes} moved=${result.moved} writeDb=${result.writeDb}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`sigma-vault-inbox-processor error: ${error?.message || error}`);
    process.exit(1);
  });
}

export default { runInboxProcessor };
