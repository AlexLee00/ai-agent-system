#!/usr/bin/env tsx

const assert = require('node:assert/strict');
const {
  buildChaosPlan,
  runFixtureChaosDrill,
} = require('../lib/stage-c/resilience');

function main(): void {
  const plan = buildChaosPlan();
  assert.equal(plan.ok, true, 'Stage C chaos plan must be ready');
  assert.equal(plan.defaultMode, 'fixture_only');
  assert.equal(plan.liveChaosGate, '--apply --confirm=hub-stage-c-chaos');
  assert(plan.prohibitedActions.some((action: string) => action.includes('PROTECTED')), 'chaos plan must protect launchd services');

  const fixture = runFixtureChaosDrill();
  assert.equal(fixture.ok, true, 'fixture chaos drill must pass');
  assert(fixture.scenarios.length >= 4, 'fixture chaos drill must cover core failure modes');
  for (const scenario of fixture.scenarios) {
    assert.equal(scenario.providerCallMade, false, `fixture scenario must not call providers: ${scenario.name}`);
    assert.equal(scenario.protectedServiceMutation, false, `fixture scenario must not mutate protected services: ${scenario.name}`);
    assert.equal(scenario.secretMutation, false, `fixture scenario must not mutate secrets: ${scenario.name}`);
  }

  console.log(JSON.stringify({
    ok: true,
    stage: 'hub_stage_c',
    fixture_scenarios: fixture.scenarios.map((scenario: { name: string }) => scenario.name),
    live_chaos_gate: plan.liveChaosGate,
  }, null, 2));
}

main();
