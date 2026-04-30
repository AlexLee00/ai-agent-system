#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildVoyagerValidationFixture, runVoyagerSkillAutoExtractionVerify } from './voyager-skill-auto-extraction-verify.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runVoyagerSkillValidationFixtureSmoke() {
  const fixture = buildVoyagerValidationFixture({ reflexionCount: 4, minCandidates: 5 });
  assert.equal(fixture.fixtureUsed, true);
  assert.equal(fixture.naturalDataReady, false);
  assert.equal(fixture.productionSkillPromoted, false);
  assert.equal(fixture.status, 'validation_fixture_passed');

  const result = await runVoyagerSkillAutoExtractionVerify({
    validationFixture: true,
    reflexionCountOverride: 4,
    minCandidatesOverride: 5,
  });
  assert.equal(result.status, 'pending_observation');
  assert.equal(result.naturalDataReady, false);
  assert.equal(result.validationFixture.fixtureUsed, true);
  assert.equal(result.validationFixture.productionSkillPromoted, false);
  return { ok: true, fixture: result.validationFixture };
}

async function main() {
  const result = await runVoyagerSkillValidationFixtureSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('voyager-skill-validation-fixture-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ voyager-skill-validation-fixture-smoke 실패:',
  });
}
