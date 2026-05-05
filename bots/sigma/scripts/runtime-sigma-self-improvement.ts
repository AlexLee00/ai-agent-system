import {
  buildMonthlySelfImprovementFixture,
  runSelfImprovementPipeline,
} from '../ts/lib/self-improvement-pipeline.js';

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

const dryRun = hasArg('--dry-run')
  || (!hasArg('--apply') && !['supervised', 'autonomous'].includes(String(process.env.SIGMA_SELF_IMPROVEMENT_APPLY_MODE || '').trim().toLowerCase()));

const plan = await runSelfImprovementPipeline(buildMonthlySelfImprovementFixture(), { dryRun });

console.log(JSON.stringify({
  ...plan,
  applyBlocked: plan.applyGate.applyBlocked,
}, null, 2));
