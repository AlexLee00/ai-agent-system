#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import {
  buildFailedSignalReflexionBackfillPlan,
  buildFailedSignalReflexionEvent,
  onSignalFailed,
} from '../shared/failed-signal-reflexion-trigger.ts';
import { runFailedReflexionBackfillSmoke } from './runtime-failed-reflexion-backfill.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runSmoke() {
  const signal = {
    id: 'smoke-failed-signal-1',
    symbol: 'ORCA/USDT',
    action: 'buy',
    status: 'failed',
    reason: 'provider_cooldown',
    meta: { provider: 'openai-oauth' },
  };
  const event = buildFailedSignalReflexionEvent(signal, { dryRun: true });
  assert.equal(event.type, 'failed_signal_reflexion');
  assert.equal(event.classification.kind, 'provider_unavailable');
  assert.ok(event.syntheticTradeId < 0);

  const disabled = await onSignalFailed(signal, { dryRun: true });
  assert.equal(disabled.status, 'disabled');
  assert.equal(disabled.persisted, false);

  let persistCalls = 0;
  const persisted = await onSignalFailed(signal, {
    force: true,
    dryRun: false,
    persistFn: async (evt) => {
      persistCalls++;
      return { tradeId: evt.syntheticTradeId, persisted: true };
    },
  });
  assert.equal(persisted.status, 'persisted');
  assert.equal(persistCalls, 1);

  const plan = buildFailedSignalReflexionBackfillPlan({ signals: [signal, { ...signal, id: 'sig-2', reason: 'min_order' }], dryRun: true });
  assert.equal(plan.selected, 2);
  assert.equal(plan.wouldPersist, 0);
  assert.equal(plan.byKind.provider_unavailable, 1);
  assert.equal(plan.byKind.min_order, 1);

  const backfill = await runFailedReflexionBackfillSmoke();
  assert.equal(backfill.ok, true);
  return { ok: true, event, disabledStatus: disabled.status, persistedStatus: persisted.status, backfill: backfill.dry.status };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('✅ failed-signal-reflexion-trigger-smoke');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ failed-signal-reflexion-trigger-smoke 실패:' });
}
