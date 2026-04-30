#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildAgentMessageBusHygienePlan } from '../shared/luna-operational-closure-pack.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runAgentMessageBusHygienePlanSmoke() {
  const clear = buildAgentMessageBusHygienePlan({
    ok: true,
    before: { staleCount: 0, staleHours: 6, rows: [] },
    action: { dryRun: true },
  });
  assert.equal(clear.length, 0);

  const stale = buildAgentMessageBusHygienePlan({
    ok: true,
    before: {
      staleCount: 110,
      staleHours: 6,
      rows: [{ to_agent: 'luna', message_type: 'query', stale_count: '110' }],
    },
    action: { dryRun: true },
  });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].category, 'stale_agent_messages');
  assert.equal(stale[0].safeToApply, false);
  assert.equal(stale[0].dryRunOnly, true);
  assert.ok(stale[0].applyCommand.includes('--confirm=luna-agent-bus-hygiene'));

  const failed = buildAgentMessageBusHygienePlan({ ok: false, error: 'db_down' });
  assert.equal(failed.length, 1);
  assert.equal(failed[0].category, 'query_failed');
  return { ok: true, clear, stale, failed };
}

async function main() {
  const result = await runAgentMessageBusHygienePlanSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('agent-message-bus-hygiene-plan-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ agent-message-bus-hygiene-plan-smoke 실패:',
  });
}
