#!/usr/bin/env tsx
import assert from 'node:assert/strict';

async function main() {
  const observer = require('../../orchestrator/lib/jay-observer.ts');

  const ok = observer.observeIncidentOutcome({
    planSteps: [{ id: 'inspect', tool: 'hub.health.query', sideEffect: 'read_only' }],
    commanderDispatch: { ok: true, claimed: 0, results: [] },
    executeResponse: { ok: true, payload: { result: [{ ok: true }] } },
  });
  assert.equal(ok.ok, true, 'successful observation should close');
  assert.equal(ok.status, 'completed', 'successful observation status mismatch');
  assert.equal(ok.evidence.execution.executedSteps, 1, 'execute evidence should be counted');

  const followUp = observer.observeIncidentOutcome({
    planSteps: [{ id: 'mutate', tool: 'repo.command.run', sideEffect: 'write' }],
    commanderDispatch: {
      ok: true,
      claimed: 1,
      results: [{ ok: false, error: 'bot_command_timeout', retrying: true }],
    },
    executeResponse: { ok: true, skipped: true, reason: 'no_read_only_steps', payload: { result: [] } },
  });
  assert.equal(followUp.ok, false, 'failed commander observation should require follow-up');
  assert.equal(followUp.status, 'needs_follow_up', 'follow-up status mismatch');
  assert.match(String(followUp.warnings[0] || ''), /commander:/, 'commander warning should be present');

  const emptyPlan = observer.observeIncidentOutcome({
    planSteps: [],
    commanderDispatch: { ok: true, claimed: 0, results: [] },
    executeResponse: { ok: true, skipped: true, reason: 'no_read_only_steps', payload: { result: [] } },
  });
  assert.equal(emptyPlan.ok, false, 'empty plan should not close as successful');
  assert.ok(emptyPlan.nextActions.length > 0, 'empty plan should propose next action');

  console.log('jay_observer_smoke_ok');
}

main().catch((error) => {
  console.error(`jay_observer_smoke_failed: ${error?.message || error}`);
  process.exit(1);
});
