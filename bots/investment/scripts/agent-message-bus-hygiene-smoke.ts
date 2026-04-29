#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import * as db from '../shared/db.ts';
import { expireStaleAgentMessages, getMessageBusHygiene } from '../shared/agent-message-bus.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  await db.initSchema();
  const incidentPrefix = `bus-hygiene-smoke-${Date.now()}`;
  const incidentKey = `${incidentPrefix}:1`;
  await db.run(
    `INSERT INTO investment.agent_messages
       (from_agent, to_agent, incident_key, message_type, payload, created_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,NOW() - INTERVAL '30 hours')`,
    ['argos', 'sophia', incidentKey, 'query', JSON.stringify({ smoke: true })],
  );

  const before = await getMessageBusHygiene({ staleHours: 1, limit: 20 });
  assert.ok(before.staleCount >= 1, 'stale message detected');

  const dry = await expireStaleAgentMessages({ staleHours: 1, incidentKeyPrefix: incidentPrefix, dryRun: true });
  assert.equal(dry.expired, 0, 'dry run does not expire');
  assert.ok(dry.candidates >= 1, 'dry run sees candidate');

  const applied = await expireStaleAgentMessages({ staleHours: 1, incidentKeyPrefix: incidentPrefix });
  assert.ok(applied.expired >= 1, 'stale message expired');

  const rows = await db.query(
    `SELECT responded_at, payload
       FROM investment.agent_messages
      WHERE incident_key = $1
      LIMIT 1`,
    [incidentKey],
  );
  assert.ok(rows[0]?.responded_at, 'responded_at marked');
  assert.equal(rows[0]?.payload?.staleExpired, true, 'payload marks stale expiration');

  return { ok: true, expired: applied.expired };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('agent-message-bus-hygiene-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ agent-message-bus-hygiene-smoke 실패:',
  });
}
