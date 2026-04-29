#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import * as db from '../shared/db.ts';
import { fetchPendingPosttradeCandidates } from '../shared/trade-quality-evaluator.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  await db.initSchema();
  const all = await fetchPendingPosttradeCandidates({ limit: 5, market: 'all' });
  assert.ok(Array.isArray(all), 'candidate list array');

  const crypto = await fetchPendingPosttradeCandidates({ limit: 5, market: 'crypto' });
  assert.ok(Array.isArray(crypto), 'crypto list array');
  assert.ok(crypto.every((item) => Number.isFinite(Number(item.tradeId))), 'candidate tradeId numeric');

  return {
    ok: true,
    allCount: all.length,
    cryptoCount: crypto.length,
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('trade-quality-evaluator-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ trade-quality-evaluator-smoke 실패:',
  });
}

