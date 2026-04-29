#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import * as db from '../shared/db.ts';
import { buildPosttradeFeedbackActionStaging } from './runtime-posttrade-feedback-action-staging.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  await db.initSchema();
  const safeParameter = `runtime_config.posttrade.smoke.${Date.now()}`;
  const unsafeParameter = `runtime_config.secret.token.${Date.now()}`;
  const safe = await db.insertFeedbackToActionMap({
    sourceTradeId: 0,
    parameterName: safeParameter,
    oldValue: 0.1,
    newValue: 0.2,
    reason: 'posttrade staging smoke',
    metadata: { smoke: true },
  });
  const unsafe = await db.insertFeedbackToActionMap({
    sourceTradeId: 0,
    parameterName: unsafeParameter,
    oldValue: 'old',
    newValue: 'new',
    reason: 'posttrade staging smoke',
    metadata: { smoke: true },
  });
  assert.ok(safe?.id, 'safe feedback row inserted');
  assert.ok(unsafe?.id, 'unsafe feedback row inserted');

  const staging = await buildPosttradeFeedbackActionStaging({ days: 30, limit: 100 });
  assert.equal(staging.ok, true, 'staging ok');
  assert.ok(staging.patches.some((item) => item.meta?.parameterName === safeParameter), 'safe runtime parameter staged');
  assert.ok(staging.rejected.some((item) => item.parameterName === unsafeParameter), 'secret-like parameter rejected');

  return {
    ok: true,
    safeId: safe.id,
    unsafeId: unsafe.id,
    patchCount: staging.patchCount,
    rejectedCount: staging.rejectedCount,
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('posttrade-feedback-action-staging-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ posttrade-feedback-action-staging-smoke 실패:',
  });
}
