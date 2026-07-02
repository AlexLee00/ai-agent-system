#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildWikiEntriesFromDocuments,
  mergeWikiPages,
  buildLlmWikiCompileReport,
  parseArgs,
} from './llm-wiki-compile.ts';

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-smoke-'));
  const handoff = path.join(tmp, 'handoff');
  fs.mkdirSync(handoff, { recursive: true });
  const hubFile = path.join(handoff, 'HANDOFF_HUB.md');
  const lunaFile = path.join(handoff, 'HANDOFF_LUNA.md');
  fs.writeFileSync(hubFile, '# Hub routing trace\n\nHub resource-api cycle trace and ops-mcp evidence.', 'utf8');
  fs.writeFileSync(lunaFile, '# Luna risk gate\n\nLuna capital risk, KIS, and Binance shadow promotion notes.', 'utf8');

  const entries = buildWikiEntriesFromDocuments([hubFile, lunaFile], { baseDir: tmp });
  assert.equal(entries.length, 2);
  assert.equal(entries.find((entry) => entry.title === 'Hub routing trace').topic, 'hub');
  assert.equal(entries.find((entry) => entry.title === 'Luna risk gate').topic, 'luna');

  const pages = mergeWikiPages(entries, {
    hub: '# hub wiki\n\n## Existing\n\nSource: `handoff/HANDOFF_HUB.md`\n\nold',
  });
  assert.equal((pages.hub.match(/Source:/g) || []).length, 1, 'hub source should dedupe');
  assert.match(pages.luna, /Luna capital risk/);

  const report = await buildLlmWikiCompileReport({
    projectDocs: tmp,
    outDir: path.join(tmp, 'wiki'),
    limit: 10,
    noDb: true,
    dryRun: true,
  });
  assert.equal(report.ok, true);
  assert.equal(report.dryRun, true);
  assert.equal(report.liveMutation, false);
  assert.ok(report.counts.entries >= 2);
  assert.ok(report.topics.includes('hub'));
  assert.ok(report.topics.includes('luna'));
  assert.equal(fs.existsSync(path.join(tmp, 'wiki/hub.md')), false, 'dry-run must not write files');
  const unsafeVaultArgs = parseArgs(['--write-vault', '--no-dry-run']);
  assert.equal(unsafeVaultArgs.dryRun, true, 'vault-only request without --write remains dry-run');
  assert.equal(unsafeVaultArgs.writeVault, false, 'vault write requires --write and --no-dry-run');
  const explicitVaultArgs = parseArgs(['--write', '--write-vault', '--no-dry-run']);
  assert.equal(explicitVaultArgs.dryRun, false);
  assert.equal(explicitVaultArgs.writeVault, true);

  console.log(JSON.stringify({ ok: true, checks: 13 }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
