#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { checkAvoidPatterns } from '../shared/reflexion-engine.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  const result = await checkAvoidPatterns('BTC/USDT', 'crypto', 'long', 'trending_bull');
  assert.equal(typeof result?.matched, 'boolean', 'matched boolean');
  assert.ok(Number(result?.penalty || 0) >= 0, 'penalty non-negative');
  assert.equal(typeof result?.reason, 'string', 'reason string');
  return { ok: true, result };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('reflexion-engine-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ reflexion-engine-smoke 실패:',
  });
}

