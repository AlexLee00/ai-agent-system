#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLaunchdMigrationPlan, executeLaunchdMigration } from './runtime-luna-launchd-migrate.ts';

export async function runLaunchdMigrateSmoke() {
  const plan = buildLaunchdMigrationPlan({
    visibleLabels: [
      'ai.luna.marketdata-mcp',
      'ai.luna.tradingview-ws',
      'ai.investment.commander',
      'ai.elixir.supervisor',
      'ai.luna.ops-scheduler',
      'ai.investment.reporter',
      'ai.investment.argos',
      'ai.luna.binance-ws',
    ],
  });
  assert.equal(plan.ok, true);
  assert.ok(plan.retireCandidates.length >= 15);
  assert.ok(plan.protectedLabels.includes('ai.luna.tradingview-ws'));
  assert.ok(plan.targetLabels.includes('ai.investment.commander'));
  assert.ok(plan.targetLabels.includes('ai.luna.ops-scheduler'));
  assert.equal(plan.steps.length >= 5, true);
  const confirmBlocked = await executeLaunchdMigration({
    apply: true,
    visibleLabels: ['ai.luna.marketdata-mcp', 'ai.luna.binance-ws'],
  });
  assert.equal(confirmBlocked.ok, false);
  assert.equal(confirmBlocked.code, 'confirmation_required');
  const dryRun = await executeLaunchdMigration({
    visibleLabels: [
      'ai.luna.marketdata-mcp',
      'ai.luna.tradingview-ws',
      'ai.investment.commander',
      'ai.elixir.supervisor',
      'ai.luna.ops-scheduler',
      'ai.investment.reporter',
      'ai.investment.argos',
      'ai.luna.binance-ws',
      'ai.investment.position-watch',
      'ai.investment.market-alert-domestic-open',
      'ai.luna.guardrails-hourly',
    ],
    validationWaitMs: 0,
  });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.dryRun, true);
  assert.ok(dryRun.steps.some((step) => step.visibleLabels.length > 0));
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
