#!/usr/bin/env tsx
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildHealthObservationPolicy,
  buildHealthRecoveryContract,
} = require('../../../packages/core/lib/alarm-lifecycle-contract.ts');
const alarmRouteModule = require('../lib/routes/alarm.ts');
const staleScan = require('./alarm-auto-repair-stale-scan.ts');

function makeRes() {
  return {
    statusCode: 200,
    body: {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      this.body = payload;
      return payload;
    },
  };
}

async function main() {
  const first = buildHealthObservationPolicy({
    observerTeam: 'reservation',
    resourceId: 'ai.ska.kiosk-monitor',
    failureCount: 1,
  });
  assert.equal(first.alarmType, 'work');
  assert.equal(first.actionability, 'none');
  assert.equal(first.autoRepairEligible, false);

  const second = buildHealthObservationPolicy({
    observerTeam: 'reservation',
    resourceId: 'ai.ska.kiosk-monitor',
    failureCount: 2,
  });
  assert.equal(second.alarmType, 'error');
  assert.equal(second.actionability, 'auto_repair');
  assert.equal(second.autoRepairEligible, true);

  const dexterSecondary = buildHealthObservationPolicy({
    observerTeam: 'claude',
    resourceId: 'ai.ska.kiosk-monitor',
    failureCount: 4,
  });
  assert.equal(dexterSecondary.secondaryObserver, true);
  assert.equal(dexterSecondary.actionability, 'none');
  assert.equal(dexterSecondary.primaryIncidentKey, second.incidentKey);

  const recovery = buildHealthRecoveryContract({
    observerTeam: 'reservation',
    resourceId: 'ai.ska.kiosk-monitor',
  });
  assert.equal(recovery.resourceId, first.resourceId);
  assert.equal(recovery.resolvesIncidentKey, second.incidentKey);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'health-state-namespace-'));
  const previousWorkspace = process.env.AI_AGENT_WORKSPACE;
  process.env.AI_AGENT_WORKSPACE = tempRoot;
  const hsmPath = require.resolve('../../../packages/core/lib/health-state-manager.ts');
  delete require.cache[hsmPath];
  const hsm = require(hsmPath);
  assert.equal(hsm.saveState({ reservation_key: 'one' }, 'reservation'), true);
  assert.equal(hsm.saveState({ claude_key: 'two' }, 'claude'), true);
  assert.deepEqual(hsm.loadState('reservation'), { reservation_key: 'one' });
  assert.deepEqual(hsm.loadState('claude'), { claude_key: 'two' });
  assert.notEqual(hsm.stateFileForNamespace('reservation'), hsm.stateFileForNamespace('claude'));
  const failureState: Record<string, unknown> = {};
  assert.equal(hsm.recordFailure(failureState, 'ai.ska.kiosk-monitor'), 1);
  assert.equal(hsm.recordFailure(failureState, 'ai.ska.kiosk-monitor'), 2);
  hsm.clearFailure(failureState, 'ai.ska.kiosk-monitor');
  assert.equal(hsm.recordFailure(failureState, 'ai.ska.kiosk-monitor'), 1);
  if (previousWorkspace == null) delete process.env.AI_AGENT_WORKSPACE;
  else process.env.AI_AGENT_WORKSPACE = previousWorkspace;
  fs.rmSync(tempRoot, { recursive: true, force: true });

  const nowMs = Date.parse('2026-07-20T01:00:00.000Z');
  assert.equal(staleScan._testOnly_classifyProgressState({
    progress_state: 'in_progress',
    progress_at: '2026-07-20T00:55:00.000Z',
  }, 120, nowMs).stale_status, 'in_progress');
  assert.equal(staleScan._testOnly_classifyProgressState({
    progress_state: 'retry_pending',
    progress_at: '2026-07-20T00:00:00.000Z',
    next_retry_at: '2026-07-20T01:05:00.000Z',
    progress_attempt: 1,
    progress_max_attempts: 3,
  }, 120, nowMs).stale_status, 'retry_pending');
  assert.equal(staleScan._testOnly_classifyProgressState({
    progress_state: 'in_progress',
    progress_at: '2026-07-19T20:00:00.000Z',
  }, 120, nowMs).stale_status, 'stale');
  assert.equal(staleScan._testOnly_classifyProgressState({
    progress_state: 'retry_pending',
    progress_at: '2026-07-19T20:00:00.000Z',
    next_retry_at: '2026-07-21T01:00:00.000Z',
    progress_attempt: 1,
    progress_max_attempts: 3,
  }, 120, nowMs).stale_status, 'stale', 'far-future retry must not hide a stale worker');

  const recordedEvents: Array<Record<string, any>> = [];
  const dbRuns: Array<{ sql: string; params: unknown[] }> = [];
  alarmRouteModule._testOnly_setAlarmEventLakeMocks({
    findRecentDuplicateAlarm: async () => null,
    record: async (event: Record<string, unknown>) => {
      recordedEvents.push(event);
      return 991;
    },
  });
  alarmRouteModule._testOnly_setAlarmRouteDbMocks({
    get: async () => null,
    query: async () => [],
    run: async (_schema: string, sql: string, params: unknown[] = []) => {
      dbRuns.push({ sql, params });
      return { rowCount: 1, rows: [] };
    },
  });
  try {
    const progressRes = makeRes();
    await alarmRouteModule.alarmAutoRepairProgressRoute({
      body: {
        incidentKey: second.incidentKey,
        alarmEventId: '33310150',
        state: 'retry_pending',
        attempt: 1,
        maxAttempts: 3,
        nextRetryAt: '2026-07-20T01:05:00.000Z',
        team: 'reservation',
        docPath: 'docs/auto_dev/incident.md',
      },
    }, progressRes);
    assert.equal(progressRes.statusCode, 200);
    assert.equal(recordedEvents[0]?.eventType, 'hub_alarm_auto_repair_progress');
    assert.equal(recordedEvents[0]?.metadata?.attempt, 1);
    assert.equal(recordedEvents[0]?.metadata?.next_retry_at, '2026-07-20T01:05:00.000Z');

    const recoveryRes = makeRes();
    await alarmRouteModule.alarmRoute({
      body: {
        message: 'kiosk monitor recovered',
        team: 'reservation',
        fromBot: 'ska',
        severity: 'info',
        alarmType: 'work',
        visibility: 'internal',
        actionability: 'none',
        incidentKey: `${recovery.resolvesIncidentKey}:recovery`,
        payload: {
          event_type: 'health_check_recovery',
          resource_id: recovery.resourceId,
          resolves_incident_key: recovery.resolvesIncidentKey,
        },
      },
    }, recoveryRes);
    assert.equal(recoveryRes.statusCode, 200);
    assert(dbRuns.some((entry) => entry.sql.includes('resolved_by_incident_key')
      && entry.sql.includes("metadata->>'resource_id' = $2")
      && entry.params.includes(recovery.resourceId)
      && entry.params.includes(recovery.resolvesIncidentKey)), 'recovery must close the original incident');
  } finally {
    alarmRouteModule._testOnly_resetAlarmEventLakeMocks();
    alarmRouteModule._testOnly_resetAlarmRouteDbMocks();
  }

  console.log(JSON.stringify({ ok: true, smoke: 'alarm-lifecycle-progress' }));
}

main().catch((error: Error) => {
  console.error(`[alarm-lifecycle-progress-smoke] failed: ${error.message}`);
  process.exit(1);
});
