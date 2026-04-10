'use strict';

function evaluateCausalRisk(input = {}) {
  const claim = String(input.claim || '').trim();
  const correlation = Number(input.correlation || 0);
  const controls = Array.isArray(input.controls) ? input.controls.filter(Boolean) : [];
  const confounders = Array.isArray(input.confounders) ? input.confounders.filter(Boolean) : [];
  const sampleSize = Number(input.sample_size || 0);

  const flags = [];
  const recommendations = [];
  let riskScore = 2;

  if (!claim) {
    flags.push('missing causal claim');
    riskScore += 2.5;
  }

  if (Math.abs(correlation) >= 0.5 && controls.length === 0) {
    flags.push('strong correlation without controls');
    recommendations.push('add baseline controls before causal interpretation');
    riskScore += 2.0;
  }

  if (confounders.length === 0) {
    flags.push('missing confounder review');
    recommendations.push('review potential confounders such as timing, topic mix, or channel changes');
    riskScore += 1.8;
  }

  if (sampleSize > 0 && sampleSize < 300) {
    flags.push('small sample for causal claim');
    recommendations.push('increase sample size before causal conclusion');
    riskScore += 1.3;
  }

  let causalRisk = 'low';
  if (riskScore >= 6) causalRisk = 'high';
  else if (riskScore >= 4) causalRisk = 'medium';

  return {
    causal_risk: causalRisk,
    flags,
    recommendations: [...new Set(recommendations)],
  };
}

module.exports = {
  evaluateCausalRisk,
};

