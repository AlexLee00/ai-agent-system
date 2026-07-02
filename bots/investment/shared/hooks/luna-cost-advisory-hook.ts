// @ts-nocheck

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function buildLunaCostAdvisory({
  request = {},
  dailyUsage = {},
  budgetUsd = 0,
  warnRatio = 0.8,
} = {}) {
  const callCostUsd = n(request.estimatedCostUsd ?? request.costUsd, 0);
  const spentUsd = n(dailyUsage.spentUsd ?? dailyUsage.costUsd, 0);
  const projectedUsd = spentUsd + callCostUsd;
  const budget = n(budgetUsd, 0);
  const ratio = budget > 0 ? projectedUsd / budget : 0;
  const budgetPressure = budget > 0 && ratio >= n(warnRatio, 0.8);
  return {
    ok: true,
    advisoryOnly: true,
    liveMutation: false,
    source: 'luna_cost_advisory_hook',
    callerTeam: request.callerTeam || 'investment',
    taskType: request.taskType || request.runtimePurpose || null,
    callCostUsd,
    spentUsd,
    projectedUsd,
    budgetUsd: budget,
    budgetPressure,
    severity: budgetPressure && ratio >= 1 ? 'high' : budgetPressure ? 'medium' : 'low',
    message: budgetPressure
      ? `Luna LLM cost advisory: projected ${projectedUsd.toFixed(4)} / ${budget.toFixed(4)} USD`
      : 'Luna LLM cost within advisory budget',
  };
}

export function buildLunaCostLogRow(advisory = {}) {
  return {
    event_type: 'luna_llm_cost_advisory',
    payload: {
      advisoryOnly: true,
      liveMutation: false,
      callerTeam: advisory.callerTeam || 'investment',
      taskType: advisory.taskType || null,
      callCostUsd: advisory.callCostUsd || 0,
      projectedUsd: advisory.projectedUsd || 0,
      budgetUsd: advisory.budgetUsd || 0,
      budgetPressure: advisory.budgetPressure === true,
      severity: advisory.severity || 'low',
      message: advisory.message || null,
    },
  };
}

export default {
  buildLunaCostAdvisory,
  buildLunaCostLogRow,
};
