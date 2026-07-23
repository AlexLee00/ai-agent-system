#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAgentPersonaEntry, runAgentPersonaFeed } from './runtime-sigma-agent-persona-feed.ts';

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-persona-feed-'));
  const filePath = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(filePath, '# AGENTS.md\n\n> 정신: 증거로 운영한다.\n', 'utf8');

  const entry = buildAgentPersonaEntry('jay', { filePath });
  assert.equal(entry.meta.source_ref.team, 'jay');
  assert.equal(entry.meta.source_ref.table, 'repo.agent_persona');
  assert.equal(entry.libraryCoords.validation_state, 'validated');
  assert.deepEqual(entry.tags, ['sigma-library', 'jay', 'persona', 'identity']);

  let writes = 0;
  const manager = {
    addToInbox: async (candidate) => {
      writes += 1;
      assert.equal(candidate.filePath, 'library/jay/persona/AGENTS.md');
      return { ok: true, id: 'persona-fixture' };
    },
  };
  const dry = await runAgentPersonaFeed({ team: 'jay', filePath, manager, write: true, dryRun: true });
  assert.equal(dry.applied, false);
  assert.equal(writes, 0);

  const applied = await runAgentPersonaFeed({ team: 'jay', filePath, manager, write: true, dryRun: false });
  assert.equal(applied.applied, true);
  assert.equal(writes, 1);

  console.log(JSON.stringify({ ok: true, sourceRef: entry.meta.source_ref }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
