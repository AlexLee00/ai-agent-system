#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import * as db from '../shared/db.ts';
import { runAgentMessageBusHygiene } from './runtime-agent-message-bus-hygiene.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runAgentMessageBusHygieneConfirmSmoke() {
  await db.initSchema();
  const incidentPrefix = `bus-hygiene-confirm-smoke-${Date.now()}`;
  const incidentKey = `${incidentPrefix}:1`;
  await db.run(
    `INSERT INTO investment.agent_messages
       (from_agent, to_agent, incident_key, message_type, payload, created_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,NOW() - INTERVAL '30 hours')`,
    ['argos', 'sophia', incidentKey, 'query', JSON.stringify({ smoke: true })],
  );
  await db.run(
    `INSERT INTO investment.agent_messages
       (from_agent, to_agent, incident_key, message_type, payload, created_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,NOW() - INTERVAL '30 hours')`,
    ['argos', 'all', `${incidentPrefix}:broadcast`, 'broadcast', JSON.stringify({ smoke: true })],
  );

  const blocked = await runAgentMessageBusHygiene({
    staleHours: 1,
    limit: 20,
    incidentKeyPrefix: incidentPrefix,
    apply: true,
    confirm: null,
    suppressAlert: true,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 'agent_message_bus_hygiene_confirm_required');

  const stillOpen = await db.get(
    `SELECT responded_at FROM investment.agent_messages WHERE incident_key = $1 LIMIT 1`,
    [incidentKey],
  );
  assert.equal(stillOpen?.responded_at, null);

  const applied = await runAgentMessageBusHygiene({
    staleHours: 1,
    limit: 20,
    incidentKeyPrefix: incidentPrefix,
    apply: true,
    confirm: 'luna-agent-bus-hygiene',
    suppressAlert: true,
  });
  assert.equal(applied.ok, true);
  assert.ok(applied.action.expired >= 1);
  assert.equal(applied.action.safeOnly, true);
  const broadcastStillOpen = await db.get(
    `SELECT responded_at FROM investment.agent_messages WHERE incident_key = $1 LIMIT 1`,
    [`${incidentPrefix}:broadcast`],
  );
  assert.equal(broadcastStillOpen?.responded_at, null);
  await db.run(
    `UPDATE investment.agent_messages
        SET responded_at = NOW(),
            payload = COALESCE(payload, '{}'::jsonb) || $2::jsonb
      WHERE incident_key = $1`,
    [`${incidentPrefix}:broadcast`, JSON.stringify({ smokeCleanup: true })],
  );
  return { ok: true, blocked: blocked.status, expired: applied.action.expired };
}

async function main() {
  const result = await runAgentMessageBusHygieneConfirmSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('agent-message-bus-hygiene-confirm-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ agent-message-bus-hygiene-confirm-smoke 실패:',
  });
}
