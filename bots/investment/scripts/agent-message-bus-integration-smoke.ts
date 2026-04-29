#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import * as db from '../shared/db.ts';
import { publishAgentHint, consumeAgentHints } from '../shared/agent-hint-bridge.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  await db.initSchema();
  const oldEnabled = process.env.LUNA_AGENT_CROSS_BUS_ENABLED;
  process.env.LUNA_AGENT_CROSS_BUS_ENABLED = 'true';

  const incidentKey = `bus-int-smoke-${Date.now()}`;
  const published = await publishAgentHint(
    'argos',
    ['sophia', 'hermes'],
    { type: 'strategy_context', symbol: 'BTC/USDT', smoke: true },
    { incidentKey, messageType: 'query' },
  );
  assert.ok(published.delivered.length >= 1, 'at least one hint delivered');

  const sophiaHints = await consumeAgentHints('sophia', { incidentKey, limit: 5 });
  assert.ok(sophiaHints.length >= 1, 'sophia consumed hints');
  assert.equal(String(sophiaHints[0]?.payload?.symbol || ''), 'BTC/USDT', 'payload propagated');

  if (oldEnabled === undefined) delete process.env.LUNA_AGENT_CROSS_BUS_ENABLED;
  else process.env.LUNA_AGENT_CROSS_BUS_ENABLED = oldEnabled;

  return {
    ok: true,
    delivered: published.delivered.length,
    consumed: sophiaHints.length,
    failedTargets: published.failed,
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('agent-message-bus-integration-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ agent-message-bus-integration-smoke 실패:',
  });
}

