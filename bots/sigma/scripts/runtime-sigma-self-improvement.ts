import {
  buildMonthlySelfImprovementFixture,
  buildSelfImprovementPlan,
} from '../ts/lib/self-improvement-pipeline.js';

const plan = buildSelfImprovementPlan(buildMonthlySelfImprovementFixture(), { dryRun: true });

console.log(JSON.stringify({
  ...plan,
  applyBlocked: 'self_improvement_apply_not_enabled_in_operator',
}, null, 2));
