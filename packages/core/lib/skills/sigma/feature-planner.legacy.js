'use strict';

function planFeatures(input = {}) {
  const candidates = Array.isArray(input.candidates) ? input.candidates : [];
  const prioritized = [];
  const highRisk = [];
  const quickWins = [];

  for (const candidate of candidates) {
    const name = String(candidate.name || 'feature');
    const effort = Number(candidate.effort || 5);
    const signal = Number(candidate.signal || 0);
    const leakageRisk = !!candidate.leakage_risk;
    const score = Number((signal * 2 - effort - (leakageRisk ? 2 : 0)).toFixed(1));

    const item = { name, score, effort, signal, leakage_risk: leakageRisk };
    prioritized.push(item);

    if (leakageRisk) highRisk.push(name);
    if (!leakageRisk && effort <= 3 && signal >= 3) quickWins.push(name);
  }

  prioritized.sort((a, b) => b.score - a.score);

  return {
    prioritized_features: prioritized,
    high_risk_features: highRisk,
    quick_wins: quickWins,
  };
}

module.exports = {
  planFeatures,
};

