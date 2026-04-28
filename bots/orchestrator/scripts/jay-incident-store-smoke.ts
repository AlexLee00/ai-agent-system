#!/usr/bin/env tsx
import assert from 'node:assert/strict';

const store = require('../lib/jay-incident-store.ts');

async function main() {
  await store.ensureIncidentTables();

  const incidentKey = `smoke:orchestrator-incident:${Date.now()}`;

  const inserted = await store.createIncident({
    incidentKey,
    source: 'orchestrator-smoke',
    team: 'jay',
    intent: 'incident_store_smoke',
    message: 'orchestrator incident store smoke',
    args: { smoke: true },
    priority: 'normal',
  });
  assert.equal(inserted?.ok, true, 'insert/createIncident must succeed');
  assert.equal(inserted?.incident?.incidentKey, incidentKey, 'inserted incident key mismatch');

  const fetched = await store.getIncidentByKey(incidentKey);
  assert.equal(fetched?.incidentKey, incidentKey, 'fetch/getIncidentByKey must return inserted incident');

  const listed = await store.listIncidentsByStatus(['queued', 'planning', 'completed'], 500);
  assert.ok(Array.isArray(listed), 'list/listIncidentsByStatus must return an array');

  const appended = await store.appendIncidentEvent({
    incidentKey,
    eventType: 'smoke_event_appended',
    payload: { smoke: true, source: 'orchestrator' },
  });
  assert.equal(appended?.ok, true, 'append/appendIncidentEvent must succeed');
  assert.equal(
    await store.hasIncidentEvent({ incidentKey, eventType: 'smoke_event_appended' }),
    true,
    'append event must be observable',
  );

  const completed = await store.updateIncidentStatus({
    incidentKey,
    status: 'completed',
    runId: `smoke_run_${Date.now()}`,
    plan: { smoke: true },
  });
  assert.equal(completed?.ok, true, 'cleanup status update must succeed');

  console.log('jay_incident_store_smoke_ok');
}

main().catch((error) => {
  console.error(`jay_incident_store_smoke_failed: ${error?.message || error}`);
  process.exit(1);
});
