#!/usr/bin/env tsx
import assert from 'node:assert/strict';

async function main() {
  const store = require('../../orchestrator/lib/jay-incident-store.ts');
  await store.ensureIncidentTables();

  const uniqueKey = `smoke:incident:${Date.now()}`;
  const created = await store.createIncident({
    incidentKey: uniqueKey,
    source: 'smoke',
    team: 'luna',
    intent: 'luna_action',
    message: 'incident store smoke',
    args: { smoke: true },
    priority: 'normal',
  });
  assert.equal(created?.ok, true, 'incident create must succeed');
  assert.equal(created?.incident?.incidentKey, uniqueKey);

  const fetched = await store.getIncidentByKey(uniqueKey);
  assert.equal(fetched?.incidentKey, uniqueKey, 'incident fetch by key failed');

  const claimed = await store.claimQueuedIncident();
  if (claimed?.incidentKey === uniqueKey) {
    const done = await store.updateIncidentStatus({
      incidentKey: uniqueKey,
      status: 'completed',
      runId: `run_${Date.now()}`,
      plan: { smoke: true },
    });
    assert.equal(done?.ok, true, 'incident completion update must succeed');
  }

  const recent = await store.listIncidentsByStatus(['queued', 'planning', 'completed'], 20);
  assert.ok(Array.isArray(recent), 'status listing should return array');
  // listIncidentsByStatus uses FIFO ASC order with a small limit — accumulated history can push new
  // incidents past the window. Verify observability directly by key instead.
  const observable = await store.getIncidentByKey(uniqueKey);
  assert.ok(observable?.incidentKey === uniqueKey, 'created incident should be observable');
  assert.ok(
    ['queued', 'planning', 'completed'].includes(observable?.status ?? ''),
    `incident status should be in expected range, got: ${observable?.status}`,
  );

  const firstAuto = await store.createIncident({
    source: 'smoke',
    team: 'luna',
    intent: 'luna_action',
    message: 'same root incident should merge',
    dedupeWindow: 'smoke-window',
    args: { groupKey: 'same-root' },
  });
  const secondAuto = await store.createIncident({
    source: 'smoke',
    team: 'luna',
    intent: 'luna_action',
    message: 'same root incident should merge',
    dedupeWindow: 'smoke-window',
    args: { groupKey: 'same-root' },
  });
  assert.equal(firstAuto?.ok, true, 'auto incident create must succeed');
  assert.equal(secondAuto?.ok, true, 'duplicate auto incident create must succeed');
  assert.equal(
    firstAuto?.incident?.incidentKey,
    secondAuto?.incident?.incidentKey,
    'same root incident should reuse deterministic incident key',
  );

  console.log('jay_incident_store_smoke_ok');
}

main().catch((error) => {
  console.error(`jay_incident_store_smoke_failed: ${error?.message || error}`);
  process.exit(1);
});
