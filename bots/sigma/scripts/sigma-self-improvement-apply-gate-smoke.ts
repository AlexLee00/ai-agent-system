import assert from 'node:assert/strict';
import {
  buildMonthlySelfImprovementFixture,
  buildSelfImprovementPlan,
  toPosttradeSkillPayload,
} from '../ts/lib/self-improvement-pipeline.js';

const PRESERVED_KEYS = [
  'SIGMA_SELF_IMPROVEMENT_ENABLED',
  'SIGMA_VOYAGER_SKILL_AUTO_EXTRACTION',
  'SIGMA_FINE_TUNING_NOTIFY_ENABLED',
  'SIGMA_SELF_IMPROVEMENT_APPLY_MODE',
  'SIGMA_LIBRARY_AUTONOMY_MODE',
] as const;

const preserved = new Map<string, string | undefined>();
for (const key of PRESERVED_KEYS) preserved.set(key, process.env[key]);

try {
  process.env.SIGMA_SELF_IMPROVEMENT_ENABLED = 'true';
  process.env.SIGMA_VOYAGER_SKILL_AUTO_EXTRACTION = 'true';
  process.env.SIGMA_FINE_TUNING_NOTIFY_ENABLED = 'true';
  process.env.SIGMA_LIBRARY_AUTONOMY_MODE = 'autonomous';

  process.env.SIGMA_SELF_IMPROVEMENT_APPLY_MODE = 'shadow';
  const shadow = buildSelfImprovementPlan(buildMonthlySelfImprovementFixture(), { dryRun: false });
  assert.equal(shadow.applyGate.mode, 'shadow');
  assert.equal(shadow.applyGate.applyAllowed, false);
  assert.equal(shadow.applyGate.applyBlocked, 'self_improvement_apply_not_enabled_in_operator');

  process.env.SIGMA_SELF_IMPROVEMENT_APPLY_MODE = 'supervised';
  const supervised = buildSelfImprovementPlan(buildMonthlySelfImprovementFixture(), { dryRun: false });
  assert.equal(supervised.applyGate.mode, 'supervised');
  assert.equal(supervised.applyGate.applyAllowed, true);
  assert.equal(supervised.applyGate.applyBlocked, null);
  assert.equal(supervised.skillCandidates.length, 2);
  assert.equal(supervised.activation.operatorApplyEnabled, true);
  assert.equal(supervised.activation.voyagerApplyEnabled, true);

  const payloads = supervised.skillCandidates.map(toPosttradeSkillPayload);
  assert.deepEqual(
    payloads.map((payload) => payload.patternKey).sort(),
    [
      'sigma:sigma:librarian:avoid:dataset_export_without_lineage',
      'sigma:sigma:librarian:success:cross_team_memory_prefix',
    ],
  );
  assert.ok(payloads.every((payload) => payload.metadata.source === 'sigma_self_improvement'));

  const dryRun = buildSelfImprovementPlan(buildMonthlySelfImprovementFixture(), { dryRun: true });
  assert.equal(dryRun.applyGate.applyAllowed, false);
  assert.equal(dryRun.applyGate.applyBlocked, 'self_improvement_dry_run');

  console.log(JSON.stringify({
    ok: true,
    status: 'sigma_self_improvement_apply_gate_smoke_passed',
    supervisedApplyAllowed: supervised.applyGate.applyAllowed,
    skillCandidates: supervised.skillCandidates.length,
    payloadPatternKeys: payloads.map((payload) => payload.patternKey).sort(),
  }, null, 2));
} finally {
  for (const [key, value] of preserved) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}
