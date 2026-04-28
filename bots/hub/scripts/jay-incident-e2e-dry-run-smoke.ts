#!/usr/bin/env tsx
import assert from 'node:assert/strict';

function installRuntimeMocks() {
  const controlClientPath = require.resolve('../../orchestrator/lib/jay-control-plan-client.ts');
  const commanderDispatcherPath = require.resolve('../lib/control/commander-dispatcher.ts');

  require.cache[controlClientPath] = {
    id: controlClientPath,
    filename: controlClientPath,
    loaded: true,
    exports: {
      createControlPlanDraft: async (input) => ({
        ok: true,
        payload: {
          ok: true,
          run_id: `jay_e2e_dry_run_${Date.now()}`,
          plan: {
            team: input?.team || 'general',
            requiresApproval: false,
            risk: 'low',
            steps: [
              {
                id: 'inspect_hub_health',
                tool: 'hub.health.query',
                sideEffect: 'read_only',
                args: { dryRun: true },
                notes: 'Jay E2E dry-run read-only health inspection',
              },
            ],
          },
          approval: { required: false },
        },
      }),
      executeControlPlan: async () => ({
        ok: true,
        payload: {
          ok: true,
          result: [{ ok: true, stepId: 'inspect_hub_health', dryRun: true }],
        },
      }),
      submitControlCallback: async () => ({ ok: true }),
      requestWithRetry: async () => ({ ok: true }),
    },
  };

  require.cache[commanderDispatcherPath] = {
    id: commanderDispatcherPath,
    filename: commanderDispatcherPath,
    loaded: true,
    exports: {
      ensureCommanderDispatchTables: async () => undefined,
      queueCommanderTask: async () => ({ ok: true, task: { id: 'mock_task' } }),
      dispatchCommanderQueue: async () => ({ ok: true, claimed: 0, results: [] }),
    },
  };
}

async function main() {
  const previousTelegram = process.env.JAY_3TIER_TELEGRAM;
  const previousSkill = process.env.JAY_SKILL_EXTRACTION;
  process.env.JAY_3TIER_TELEGRAM = 'false';
  process.env.JAY_SKILL_EXTRACTION = 'false';

  try {
    installRuntimeMocks();
    const incidentStore = require('../../orchestrator/lib/jay-incident-store.ts');
    const runtime = require('../../orchestrator/src/jay-runtime.ts');

    await incidentStore.ensureIncidentTables();
    const incidentKey = `jay:e2e-dry-run:${Date.now()}`;
    const created = await incidentStore.createIncident({
      incidentKey,
      source: 'jay-e2e-dry-run-smoke',
      team: 'luna',
      intent: 'dry_run_health_check',
      message: 'Jay E2E dry-run should plan, execute read-only work, observe, and complete.',
      args: {
        goal: 'Run a read-only Jay orchestration dry-run without live Hub mutation.',
        dedupeWindow: String(Date.now()),
      },
      priority: 'normal',
    });
    assert.equal(created?.ok, true, 'incident should be created');

    const planning = await incidentStore.updateIncidentStatus({
      incidentKey,
      status: 'planning',
      attemptsDelta: 1,
    });
    assert.equal(planning?.ok, true, 'fresh dry-run incident should move to planning');
    assert.equal(planning?.incident?.incidentKey, incidentKey, 'dry-run should only process its own incident');

    const flags = {
      commanderEnabled: true,
      hubPlanIntegration: true,
      incidentStoreEnabled: true,
      commanderDispatch: true,
      teamBusEnabled: true,
      threeTierTelegram: false,
      skillExtraction: false,
      incidentLoopIntervalMs: 1,
      commanderDispatchLimit: 1,
    };
    const result = await runtime.processIncident(planning.incident, flags);
    assert.equal(result?.ok, true, `processIncident failed: ${result?.error || 'unknown'}`);
    assert.equal(result?.planStepCount, 1, 'read-only plan should contain one step');

    const stored = await incidentStore.getIncidentByKey(incidentKey);
    assert.equal(stored?.status, 'completed', 'incident should complete');
    assert.ok(stored?.runId, 'incident should persist run id');
    assert.equal(
      await incidentStore.hasIncidentEvent({ incidentKey, eventType: 'jay_observe_outcome' }),
      true,
      'observation event should be persisted',
    );
    console.log('jay_incident_e2e_dry_run_smoke_ok');
  } finally {
    if (previousTelegram == null) delete process.env.JAY_3TIER_TELEGRAM;
    else process.env.JAY_3TIER_TELEGRAM = previousTelegram;
    if (previousSkill == null) delete process.env.JAY_SKILL_EXTRACTION;
    else process.env.JAY_SKILL_EXTRACTION = previousSkill;
  }
}

main().catch((error) => {
  console.error(`jay_incident_e2e_dry_run_smoke_failed: ${error?.message || error}`);
  process.exit(1);
});
