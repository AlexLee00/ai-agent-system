import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const sigmaRoot = path.join(repoRoot, 'bots/sigma');
const tsxBin = path.join(repoRoot, 'node_modules/.bin/tsx');

const output = execFileSync(tsxBin, [
  'scripts/runtime-sigma-self-improvement.ts',
  '--apply',
  '--fixture',
], {
  cwd: sigmaRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    SIGMA_SELF_IMPROVEMENT_ENABLED: 'true',
    SIGMA_VOYAGER_SKILL_AUTO_EXTRACTION: 'true',
    SIGMA_SELF_IMPROVEMENT_APPLY_MODE: 'supervised',
  },
});
const result = JSON.parse(output);
assert.equal(result.applyBlocked, 'confirm_required:sigma-self-improvement-apply');
assert.equal(result.dryRun, true);
assert.equal(result.appliedSkills.length, 0);
assert.equal(result.skillCountBefore, result.skillCountAfter);

const dryRunOverrideOutput = execFileSync(tsxBin, [
  'scripts/runtime-sigma-self-improvement.ts',
  '--dry-run',
  '--apply',
  '--confirm=sigma-self-improvement-apply',
  '--fixture',
], {
  cwd: sigmaRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    SIGMA_SELF_IMPROVEMENT_ENABLED: 'true',
    SIGMA_VOYAGER_SKILL_AUTO_EXTRACTION: 'true',
    SIGMA_SELF_IMPROVEMENT_APPLY_MODE: 'supervised',
  },
});
const dryRunOverride = JSON.parse(dryRunOverrideOutput);
assert.equal(dryRunOverride.dryRun, true);
assert.equal(dryRunOverride.applyBlocked, 'self_improvement_dry_run');
assert.equal(dryRunOverride.skillCountBefore, dryRunOverride.skillCountAfter);

console.log(JSON.stringify({
  ok: true,
  status: 'sigma_self_improvement_confirm_gate_smoke_passed',
  applyBlocked: result.applyBlocked,
  skillCountBefore: result.skillCountBefore,
  skillCountAfter: result.skillCountAfter,
}, null, 2));
