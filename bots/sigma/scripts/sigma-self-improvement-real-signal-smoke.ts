import assert from 'node:assert/strict';
import {
  buildSelfImprovementPlan,
  buildMonthlySelfImprovementFixture,
} from '../ts/lib/self-improvement-pipeline.js';
import {
  buildFixtureLibraryRecords,
  buildSelfImprovementSignalsFromRecords,
} from '../ts/lib/library-data-source.js';

const emptyPlan = buildSelfImprovementPlan([]);
assert.equal(emptyPlan.ok, true);
assert.equal(emptyPlan.skillCandidates.length, 0);
assert.equal(emptyPlan.fineTuneCandidate.ready, false);

const realSignals = buildSelfImprovementSignalsFromRecords(buildFixtureLibraryRecords());
assert.ok(realSignals.length > 0);
const realPlan = buildSelfImprovementPlan(realSignals);
assert.equal(realPlan.ok, true);
assert.equal(realPlan.dryRun, true);

const fixturePlan = buildSelfImprovementPlan(buildMonthlySelfImprovementFixture());
assert.ok(fixturePlan.skillCandidates.length >= 2);
assert.equal(fixturePlan.skillCandidates.every((candidate) => candidate.promoted === false), true);

console.log(JSON.stringify({
  ok: true,
  status: 'sigma_self_improvement_real_signal_smoke_passed',
  realSignals: realSignals.length,
  fixtureSkillCandidates: fixturePlan.skillCandidates.length,
  productionPromotion: false,
}, null, 2));
