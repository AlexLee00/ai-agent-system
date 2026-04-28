#!/usr/bin/env tsx
import assert from 'node:assert/strict';

async function main() {
  const contract = require('../../../packages/core/lib/commander-contract.ts');
  const commanderRegistry = require('../../orchestrator/lib/commanders/index.ts');

  const teams = commanderRegistry.listCommanderTeams();
  assert.equal(Array.isArray(teams), true, 'teams should be array');
  assert.equal(teams.length >= 8, true, 'expected 8 team adapters');

  const sampleTask = {
    incidentKey: `contract-smoke:${Date.now()}`,
    team: 'luna',
    stepId: 'step-1',
    goal: 'contract check',
    payload: { smoke: true },
  };

  const taskValidation = contract.validateCommanderTask(sampleTask);
  assert.equal(taskValidation?.ok, true, 'task validation should pass');
  const progressValidation = contract.validateCommanderProgress({
    incidentKey: sampleTask.incidentKey,
    team: sampleTask.team,
    stepId: sampleTask.stepId,
    status: 'running',
  });
  assert.equal(progressValidation?.ok, true, 'progress validation should pass');
  const finalValidation = contract.validateCommanderFinalSummary({
    incidentKey: sampleTask.incidentKey,
    team: sampleTask.team,
    status: 'completed',
    summary: 'done',
  });
  assert.equal(finalValidation?.ok, true, 'final summary validation should pass');
  const rejectValidation = contract.validateCommanderReject({
    incidentKey: sampleTask.incidentKey,
    team: sampleTask.team,
    reason: 'not_applicable',
  });
  assert.equal(rejectValidation?.ok, true, 'reject validation should pass');

  for (const team of teams) {
    const adapter = commanderRegistry.getCommanderAdapter(team);
    const check = contract.validateCommanderAdapter(adapter, team);
    assert.equal(check?.ok, true, `adapter contract invalid for team=${team}`);
  }

  console.log('commander_contract_adherence_smoke_ok');
}

main().catch((error) => {
  console.error(`commander_contract_adherence_smoke_failed: ${error?.message || error}`);
  process.exit(1);
});
