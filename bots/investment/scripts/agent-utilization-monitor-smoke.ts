#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { summarizeAgentUtilization } from '../shared/agent-utilization-monitor.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runSmoke() {
  const summary = summarizeAgentUtilization(
    [
      { agent: 'luna', ok: true, at: '2026-04-30T00:00:00.000Z' },
      { agent: 'luna', ok: false, status: 'failed' },
      { owner: 'kairos', ok: true },
    ],
    { expectedAgents: ['luna', 'kairos', 'sweeper'] },
  );
  assert.equal(summary.ok, true);
  assert.equal(summary.totalEvents, 3);
  assert.equal(summary.byAgent.luna.count, 2);
  assert.ok(summary.missingAgents.includes('sweeper'));
  return { ok: true, summary };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('✅ agent-utilization-monitor-smoke');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ agent-utilization-monitor-smoke 실패:' });
}
