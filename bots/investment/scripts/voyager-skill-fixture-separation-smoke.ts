#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { runVoyagerSkillAutoExtractionVerify } from './voyager-skill-auto-extraction-verify.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runVoyagerSkillFixtureSeparationSmoke() {
  const pending = await runVoyagerSkillAutoExtractionVerify({
    validationFixture: true,
    reflexionCountOverride: 4,
    minCandidatesOverride: 5,
  });
  assert.equal(pending.status, 'pending_observation');
  assert.equal(pending.naturalDataReady, false);
  assert.equal(pending.validationFixture.fixtureUsed, true);
  assert.equal(pending.validationFixture.productionSkillPromoted, false);

  const ready = await runVoyagerSkillAutoExtractionVerify({
    validationFixture: true,
    reflexionCountOverride: 5,
    minCandidatesOverride: 5,
  });
  assert.equal(ready.status, 'ready_for_extraction');
  assert.equal(ready.naturalDataReady, true);
  assert.equal(ready.validationFixture.fixtureUsed, true);
  assert.equal(ready.validationFixture.productionSkillPromoted, false);
  return { ok: true, pending: pending.validationFixture, ready: ready.validationFixture };
}

async function main() {
  const result = await runVoyagerSkillFixtureSeparationSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('voyager-skill-fixture-separation-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ voyager-skill-fixture-separation-smoke 실패:',
  });
}
