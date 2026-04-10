// @ts-nocheck
'use strict';

function evaluateExperimentDesign(input = {}) {
  const issues = [];
  const recommendations = [];
  let score = 10;

  const hypothesis = String(input.hypothesis || '').trim();
  const metric = String(input.metric || '').trim();
  const baselineDefined = !!input.baseline_defined;
  const variantCount = Number(input.variant_count || 0);
  const sampleSize = Number(input.sample_size || 0);
  const hasGuardrailMetric = !!input.has_guardrail_metric;

  if (!hypothesis) {
    issues.push('missing hypothesis');
    score -= 2.5;
  }

  if (!metric) {
    issues.push('missing primary metric');
    score -= 2.0;
  }

  if (!baselineDefined) {
    issues.push('missing baseline definition');
    recommendations.push('define the current control or historical baseline');
    score -= 1.8;
  }

  if (variantCount < 2) {
    issues.push('insufficient variants');
    recommendations.push('add at least control and one treatment');
    score -= 1.4;
  }

  if (sampleSize > 0 && sampleSize < 300) {
    issues.push('sample size may be too small');
    recommendations.push('increase sample size or extend test duration');
    score -= 1.3;
  }

  if (!hasGuardrailMetric) {
    issues.push('missing guardrail metric');
    recommendations.push('add bounce-rate, error-rate, or complaint-rate guardrail');
    score -= 1.2;
  }

  score = Math.max(0, Number(score.toFixed(1)));

  return {
    passed: issues.length === 0,
    design_score: score,
    issues,
    recommendations,
  };
}

module.exports = {
  evaluateExperimentDesign,
};

