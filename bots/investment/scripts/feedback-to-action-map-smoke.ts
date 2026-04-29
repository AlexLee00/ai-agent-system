#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  await db.initSchema();
  const inserted = await db.insertFeedbackToActionMap({
    sourceTradeId: 0,
    parameterName: 'runtime_config.execution.testParameter',
    oldValue: 0.1,
    newValue: 0.2,
    reason: 'smoke_test',
    suggestionLogId: null,
    metadata: { smoke: true },
  });
  assert.ok(inserted?.id, 'inserted feedback_to_action_map row');

  const rows = await db.getRecentFeedbackToActionMap({ days: 30, limit: 50 });
  assert.ok(Array.isArray(rows), 'recent feedback rows array');
  assert.ok(rows.some((row) => Number(row?.id) === Number(inserted.id)), 'inserted row discoverable');

  return {
    ok: true,
    insertedId: inserted.id,
    recentCount: rows.length,
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('feedback-to-action-map-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ feedback-to-action-map-smoke 실패:',
  });
}

