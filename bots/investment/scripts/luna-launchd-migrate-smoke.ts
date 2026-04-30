#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLaunchdMigrationPlan } from './runtime-luna-launchd-migrate.ts';

export async function runLaunchdMigrateSmoke() {
  const plan = buildLaunchdMigrationPlan({
    visibleLabels: ['ai.luna.tradingview-ws', 'ai.investment.commander', 'ai.luna.binance-ws'],
  });
  assert.equal(plan.ok, true);
  assert.ok(plan.retireCandidates.length >= 15);
  assert.ok(plan.protectedLabels.includes('ai.luna.tradingview-ws'));
  assert.ok(plan.targetLabels.includes('ai.investment.commander'));
  assert.equal(plan.steps.length >= 5, true);
  return { ok: true, retireCandidates: plan.retireCandidates.length, targetLabels: plan.targetLabels.length };
}

async function main() {
  const result = await runLaunchdMigrateSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`luna-launchd-migrate-smoke ok retire=${result.retireCandidates}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ luna-launchd-migrate-smoke 실패:' });
}
