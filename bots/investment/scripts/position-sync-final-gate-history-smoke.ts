#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  appendPositionSyncFinalGateHistory,
  readRecentPositionSyncFinalGateHistory,
} from '../shared/position-sync-final-gate-history.ts';

const originalDir = process.env.INVESTMENT_OPS_RUNTIME_DIR;
const tempDir = mkdtempSync(join(tmpdir(), 'position-sync-history-'));

try {
  process.env.INVESTMENT_OPS_RUNTIME_DIR = tempDir;
  appendPositionSyncFinalGateHistory({
    event: 'smoke',
    status: 'position_sync_final_gate_clear',
    secret: 'must-not-leak',
    syncSummary: { checkedMarkets: ['crypto'], mismatchCount: 0 },
  });
  const history = readRecentPositionSyncFinalGateHistory({ limit: 5 });
  assert.equal(history.rows.length, 1);
  assert.equal(history.rows[0].secret, '[redacted]');
  assert.equal(history.rows[0].syncSummary.checkedMarkets[0], 'crypto');
  console.log(JSON.stringify({ ok: true, file: history.file }, null, 2));
} finally {
  if (originalDir == null) delete process.env.INVESTMENT_OPS_RUNTIME_DIR;
  else process.env.INVESTMENT_OPS_RUNTIME_DIR = originalDir;
  rmSync(tempDir, { recursive: true, force: true });
}
