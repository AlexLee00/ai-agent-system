#!/usr/bin/env tsx
import assert from 'node:assert/strict';

async function main() {
  const dispatcher = require('../lib/control/commander-dispatcher.ts');
  const pgPool = require('../../../packages/core/lib/pg-pool.ts');

  await dispatcher.ensureCommanderDispatchTables();
  const incidentKey = `team-bus-smoke:${Date.now()}`;
  const queued = await dispatcher.queueCommanderTask({
    incidentKey,
    team: 'blog',
    stepId: 'content_health_check',
    payload: {
      goal: 'team bus bridge smoke',
      objective: 'verify bus rows',
    },
  });
  assert.equal(queued?.ok, true, 'queue should succeed');

  const taskRow = await pgPool.get('agent', `
    SELECT incident_key, team, step_id, status
    FROM agent.jay_team_tasks
    WHERE incident_key = $1
    ORDER BY created_at DESC
    LIMIT 1
  `, [incidentKey]);
  assert.equal(taskRow?.incident_key, incidentKey, 'task row missing');
  assert.equal(String(taskRow?.status || ''), 'queued', 'task should be queued initially');

  const messageRow = await pgPool.get('agent', `
    SELECT incident_key, team, status
    FROM agent.jay_team_messages
    WHERE incident_key = $1
    ORDER BY created_at DESC
    LIMIT 1
  `, [incidentKey]);
  assert.equal(messageRow?.incident_key, incidentKey, 'message row missing');
  assert.equal(String(messageRow?.team || ''), 'blog', 'message team should match');
  assert.equal(String(messageRow?.status || ''), 'queued', 'message status should be queued');

  console.log('team_bus_bridging_smoke_ok');
}

main().catch((error) => {
  console.error(`team_bus_bridging_smoke_failed: ${error?.message || error}`);
  process.exit(1);
});
