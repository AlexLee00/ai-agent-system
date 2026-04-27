#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const outputPath = path.join(os.tmpdir(), `steward-gemini-model-drill-${process.pid}.json`);

const result = spawnSync(tsxBin, [
  path.join(scriptDir, 'steward-gemini-model-drill.ts'),
  '--mock',
  '--json',
  '--output',
  outputPath,
], {
  cwd: path.resolve(scriptDir, '..'),
  encoding: 'utf8',
  env: {
    ...process.env,
    HUB_AUTH_TOKEN: 'steward-gemini-drill-smoke-token',
  },
});

try {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, 'mock');
  assert.equal(payload.requiredCount, 3);
  assert.equal(payload.optionalCount, 1);
  assert.equal(payload.results.length, 4);
  assert(payload.results.every((item: any) => item.provider === 'gemini-cli-oauth'));
  assert(payload.results.every((item: any) => typeof item.wallMs === 'number'));
  console.log(JSON.stringify({
    ok: true,
    steward_gemini_drill_mock: true,
    results: payload.results.length,
    max_wall_ms: payload.latency.maxWallMs,
  }));
} finally {
  fs.rmSync(outputPath, { force: true });
}
