#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const compaction = require('../lib/control/session-compaction.ts');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jay-session-compaction-'));
  const originalCompactionFlag = process.env.HUB_SESSION_COMPACTION;
  const originalCheckpointDir = process.env.HUB_SESSION_CHECKPOINT_DIR;
  process.env.HUB_SESSION_COMPACTION = 'true';
  process.env.HUB_SESSION_CHECKPOINT_DIR = tempDir;

  try {
    await compaction.ensureSessionCompactionTable();
    const sessionId = `session-compaction-smoke:${Date.now()}`;
    const result = await compaction.maybeCompactSession({
      sessionId,
      force: true,
      messageCount: 250,
      tokenEstimate: 62_000,
      summary: 'smoke compaction checkpoint',
      recentMessages: ['frame: smoke', 'plan: checkpoint'],
      state: { smoke: true, path: 'jay' },
    });
    assert.equal(result?.ok, true, 'compaction should succeed');
    assert.equal(result?.compacted, true, 'compaction should be performed');
    assert.ok(String(result?.checkpointId || '').length > 0, 'checkpoint id required');
    assert.equal(result?.summarySource, 'provided', 'provided summary should be marked');

    const list = await compaction.listRecentCompactions({ sessionId, limit: 5 });
    assert.ok(Array.isArray(list), 'compaction list should be array');
    assert.ok(list.some((row) => row.session_id === sessionId), 'compaction record should persist');
    console.log('session_compaction_smoke_ok');
  } finally {
    if (originalCompactionFlag == null) delete process.env.HUB_SESSION_COMPACTION;
    else process.env.HUB_SESSION_COMPACTION = originalCompactionFlag;
    if (originalCheckpointDir == null) delete process.env.HUB_SESSION_CHECKPOINT_DIR;
    else process.env.HUB_SESSION_CHECKPOINT_DIR = originalCheckpointDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`session_compaction_smoke_failed: ${error?.message || error}`);
  process.exit(1);
});
