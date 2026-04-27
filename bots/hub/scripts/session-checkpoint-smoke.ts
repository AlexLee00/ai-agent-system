#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const checkpoint = require('../lib/control/session-checkpoint.ts');

function main(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-session-checkpoint-'));
  const originalDir = process.env.HUB_SESSION_CHECKPOINT_DIR;
  process.env.HUB_SESSION_CHECKPOINT_DIR = tempDir;

  try {
    const base = checkpoint.createSessionCheckpoint({
      sessionId: 'session-checkpoint-smoke',
      label: 'before compaction',
      summary: 'Pre-compaction working state',
      state: {
        plan: ['inspect', 'patch', 'verify'],
        access_token: 'fixture-access-token-that-must-be-redacted',
        nested: {
          authorization: 'Bearer should-not-persist-in-checkpoint',
          safe: 'visible',
        },
      },
      artifacts: ['bots/hub/lib/control/session-checkpoint.ts'],
    });
    assert.equal(base.kind, 'checkpoint');
    assert.equal(base.state.access_token, '[redacted]');
    assert.equal((base.state.nested as Record<string, unknown>).authorization, '[redacted]');
    assert.equal((base.state.nested as Record<string, unknown>).safe, 'visible');

    const branch = checkpoint.branchSessionCheckpoint(base.id, {
      sessionId: 'session-checkpoint-smoke',
      label: 'branch after compaction',
      summary: 'Alternative implementation branch',
      state: {
        selectedPath: 'hub-native',
        token: 'bot123456:secret-secret-secret-secret',
      },
      artifacts: ['bots/hub/scripts/session-checkpoint-smoke.ts'],
    });
    assert.equal(branch.kind, 'branch');
    assert.equal(branch.parentId, base.id);
    assert.equal(branch.state.token, '[redacted]');

    const restored = checkpoint.restoreSessionCheckpoint(branch.id);
    assert.equal(restored.kind, 'restore');
    assert.equal(restored.id, branch.id);
    assert.deepEqual(restored.state, branch.state);

    const rows = checkpoint.listSessionCheckpoints('session-checkpoint-smoke');
    assert.equal(rows.length, 2);

    console.log(JSON.stringify({
      ok: true,
      checkpoint_created: true,
      branch_created: true,
      restore_available: true,
      secret_redaction: true,
      persisted_records: rows.length,
    }));
  } finally {
    if (originalDir == null) delete process.env.HUB_SESSION_CHECKPOINT_DIR;
    else process.env.HUB_SESSION_CHECKPOINT_DIR = originalDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
