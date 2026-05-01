#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { executeLaunchdMigration } from './runtime-luna-launchd-migrate.ts';

const SIMULATED_VISIBLE_LABELS = [
  'ai.luna.marketdata-mcp',
  'ai.luna.tradingview-ws',
  'ai.investment.commander',
  'ai.elixir.supervisor',
  'ai.investment.reporter',
  'ai.investment.argos',
  'ai.luna.binance-ws',
  'ai.luna.kis-ws-domestic',
  'ai.luna.kis-ws-overseas',
  'ai.investment.position-watch',
  'ai.investment.unrealized-pnl',
  'ai.investment.market-alert-domestic-open',
  'ai.investment.prescreen-domestic',
];

export async function runLaunchdMigrationExecuteSmoke() {
  const dryRun = await executeLaunchdMigration({
    visibleLabels: SIMULATED_VISIBLE_LABELS,
    validationWaitMs: 0,
  });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.applied, false);
  assert.equal(dryRun.steps.length, 11);
  assert.ok(dryRun.steps.some((step) => step.group === 'marketdata_ws_to_mcp' && step.visibleLabels.length === 3));
  assert.equal(dryRun.steps.find((step) => step.group === 'marketdata_ws_to_mcp').validation.ok, true);

  const oneGroup = await executeLaunchdMigration({
    visibleLabels: SIMULATED_VISIBLE_LABELS,
    group: 'prescreen_to_argos',
    validationWaitMs: 0,
  });
  assert.equal(oneGroup.ok, true);
  assert.deepEqual(oneGroup.selectedGroups, ['prescreen_to_argos']);

  const blocked = await executeLaunchdMigration({
    apply: true,
    visibleLabels: SIMULATED_VISIBLE_LABELS,
    validationWaitMs: 0,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'confirmation_required');

  return {
    ok: true,
    dryRunGroups: dryRun.steps.length,
    oneGroup: oneGroup.selectedGroups[0],
    confirmGuard: blocked.code,
  };
}

async function main() {
  const result = await runLaunchdMigrationExecuteSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`luna-launchd-migration-execute-smoke ok groups=${result.dryRunGroups}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ luna-launchd-migration-execute-smoke 실패:' });
}
