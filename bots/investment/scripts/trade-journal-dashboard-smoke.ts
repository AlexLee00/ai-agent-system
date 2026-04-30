#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildTradeJournalDashboard, writeTradeJournalDashboard } from './runtime-trade-journal-dashboard-html.ts';

export async function runTradeJournalDashboardSmoke() {
  const dashboard = buildTradeJournalDashboard();
  assert.equal(dashboard.ok, true);
  assert.ok(dashboard.html.includes('Luna Trade Journal Dashboard'));
  const dry = await writeTradeJournalDashboard({ write: false });
  assert.equal(dry.output, null);
  return { ok: true, totalTrades: dashboard.totalTrades, failureKinds: Object.keys(dashboard.failures).length };
}

async function main() {
  const result = await runTradeJournalDashboardSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('trade-journal-dashboard-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ trade-journal-dashboard-smoke 실패:' });
}
