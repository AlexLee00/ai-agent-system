#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { buildFailedSignalReflexion } from '../shared/failed-signal-reflexion.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runSmoke() {
  const retryable = buildFailedSignalReflexion({ symbol: 'ORCA/USDT', error: 'provider_cooldown' });
  assert.equal(retryable.ok, true);
  assert.equal(retryable.memoryEvent.type, 'failed_signal_reflexion');
  assert.equal(retryable.lesson.correctiveAction, 'defer_and_retry_with_guard');

  const manual = buildFailedSignalReflexion({ symbol: 'LUNC/USDT', error: 'manual_reconcile_required' });
  assert.match(manual.lesson.promptHint, /Avoid repeating/);
  assert.ok(manual.lesson.confidence >= 0 && manual.lesson.confidence <= 1);
  return { ok: true, retryable, manual };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('✅ failed-signal-reflexion-smoke');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ failed-signal-reflexion-smoke 실패:' });
}
