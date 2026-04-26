#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'investment-runtime-ops-'));
process.env.INVESTMENT_OPS_RUNTIME_DIR = runtimeDir;

try {
  const evidence = await import('../shared/evidence-gap-task-queue.ts');
  const marketQueue = await import('./runtime-position-runtime-market-queue-store.ts');
  const autotune = await import('./runtime-position-runtime-autotune.ts');

  const evidenceFile = path.join(runtimeDir, 'position-runtime-evidence-gap-queue.json');
  const marketFile = path.join(runtimeDir, 'position-runtime-market-open-queue.json');
  const overrideFile = path.join(runtimeDir, 'position-runtime-overrides.json');

  assert.equal(evidence.DEFAULT_EXTERNAL_EVIDENCE_GAP_QUEUE_FILE, evidenceFile);
  assert.equal(marketQueue.DEFAULT_POSITION_RUNTIME_MARKET_QUEUE_FILE, marketFile);
  assert.equal(autotune.OVERRIDE_FILE, overrideFile);

  const evidenceResult = evidence.updateExternalEvidenceGapTaskQueue({
    symbol: 'OPS/USDT',
    exchange: 'binance',
    tradeMode: 'smoke',
    evidenceCount: 0,
    threshold: 1,
    cooldownMinutes: 1,
    reason: 'runtime_ops_path_smoke',
  });
  assert.equal(evidenceResult.ok, true);
  assert.equal(evidenceResult.file, evidenceFile);
  assert.equal(fs.existsSync(evidenceFile), true);

  marketQueue.writePositionRuntimeMarketQueue([
    {
      candidate: {
        symbol: 'OPS',
        exchange: 'kis',
        tradeMode: 'smoke',
        action: 'HOLD',
      },
      reason: 'runtime_ops_path_smoke',
    },
  ]);
  assert.equal(fs.existsSync(marketFile), true);

  console.log(JSON.stringify({
    ok: true,
    status: 'runtime_ops_path_smoke_passed',
    runtimeDir,
  }));
} finally {
  fs.rmSync(runtimeDir, { recursive: true, force: true });
}
