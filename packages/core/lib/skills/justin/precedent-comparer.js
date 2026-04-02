'use strict';

function comparePrecedents(items = []) {
  const list = Array.isArray(items) ? items : [];
  const commonPoints = [];
  const differences = [];

  if (list.length < 2) {
    return {
      common_points: [],
      differences: [],
      decision_impact: 'insufficient_cases',
    };
  }

  const baseIssues = new Set(list[0].issues || []);
  const baseOutcome = list[0].outcome;

  for (const issue of baseIssues) {
    if (list.every((item) => Array.isArray(item.issues) && item.issues.includes(issue))) {
      commonPoints.push(issue);
    }
  }

  for (const item of list.slice(1)) {
    if (item.outcome !== baseOutcome) {
      differences.push({
        type: 'outcome',
        left: baseOutcome,
        right: item.outcome,
      });
    }
  }

  let decisionImpact = 'low';
  if (differences.length >= 2) decisionImpact = 'high';
  else if (differences.length === 1) decisionImpact = 'medium';

  return {
    common_points: commonPoints,
    differences,
    decision_impact: decisionImpact,
  };
}

module.exports = {
  comparePrecedents,
};

