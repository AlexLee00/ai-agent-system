// @ts-nocheck
'use strict';

function buildReplicationPlan(input = {}) {
  const claim = String(input.claim || '').trim();
  const steps = Array.isArray(input.steps) ? input.steps.filter(Boolean) : [];
  const dependencies = Array.isArray(input.dependencies) ? input.dependencies.filter(Boolean) : [];
  const expectedOutput = String(input.expected_output || '').trim();

  const missingRequirements = [];
  const checklist = [];
  let score = 10;

  if (!claim) {
    missingRequirements.push('claim');
    score -= 2.5;
  }

  if (steps.length < 3) {
    missingRequirements.push('step detail');
    score -= 1.8;
  }

  if (!dependencies.length) {
    missingRequirements.push('dependencies');
    score -= 1.6;
  }

  if (!expectedOutput) {
    missingRequirements.push('expected output');
    score -= 1.4;
  }

  if (!steps.some((step) => /seed|random/i.test(step))) {
    missingRequirements.push('seed control');
    score -= 0.8;
  }

  if (!steps.some((step) => /baseline|compare|comparison/i.test(step))) {
    missingRequirements.push('baseline comparison');
    score -= 0.8;
  }

  checklist.push('prepare identical benchmark input');
  checklist.push('fix random seed');
  checklist.push('compare baseline and candidate on same metric');
  if (dependencies.length) checklist.push(`verify dependencies: ${dependencies.join(', ')}`);
  if (expectedOutput) checklist.push(`capture expected output: ${expectedOutput}`);

  score = Math.max(0, Number(score.toFixed(1)));

  let verdict = 'ready';
  if (score < 8.5) verdict = 'needs_detail';
  if (score < 6.5) verdict = 'not_reproducible_yet';

  return {
    reproducibility_score: score,
    missing_requirements: missingRequirements,
    checklist,
    verdict,
  };
}

module.exports = {
  buildReplicationPlan,
};

