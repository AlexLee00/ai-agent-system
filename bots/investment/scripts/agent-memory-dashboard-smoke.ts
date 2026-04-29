#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildAgentMemoryDashboard, recordAgentMemoryDashboard } from './runtime-agent-memory-dashboard.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  const report = await buildAgentMemoryDashboard({ days: 3, market: 'all' });
  assert.equal(report?.ok, true, 'dashboard build ok');
  assert.equal(report?.event_type, 'agent_memory_dashboard_report', 'event_type fixed');
  assert.ok(report?.summary?.context_calls >= 0, 'summary context count exists');

  const dry = await recordAgentMemoryDashboard(report, { dryRun: true });
  assert.equal(dry?.ok, true, 'dry record ok');
  assert.equal(dry?.recorded, false, 'dry run must not publish');

  return {
    ok: true,
    event_type: report.event_type,
    summary: report.summary,
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('agent-memory-dashboard-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ agent-memory-dashboard-smoke 실패:',
  });
}

