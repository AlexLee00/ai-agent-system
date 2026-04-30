#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { buildFailedSignalRecoveryPlan, summarizeRecoveryPlans } from '../shared/failed-signal-recovery.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runSmoke() {
  const retryable = buildFailedSignalRecoveryPlan(
    { id: 101, symbol: 'ORCA/USDT', action: 'BUY', error: 'provider_cooldown' },
    { now: '2026-04-30T00:00:00.000Z' },
  );
  assert.equal(retryable.recoveryState, 'queued');
  assert.equal(retryable.requiresConfirm, false);
  assert.ok(retryable.retryAt);

  const blocked = buildFailedSignalRecoveryPlan({ id: 102, symbol: 'LUNC/USDT', error: 'unknown fatal' });
  assert.equal(blocked.recoveryState, 'blocked');
  assert.equal(blocked.requiresConfirm, true);

  const summary = summarizeRecoveryPlans([
    { id: 201, error: 'provider_cooldown' },
    { id: 202, error: 'manual_reconcile_required' },
  ]);
  assert.equal(summary.total, 2);
  assert.equal(summary.queued + summary.blocked, 2);
  return { ok: true, retryable, blocked, summary };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('✅ failed-signal-recovery-smoke');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ failed-signal-recovery-smoke 실패:' });
}
