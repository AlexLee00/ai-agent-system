// @ts-nocheck
/**
 * Responsibility/execution-plan sizing policy.
 *
 * Pure helper extracted from Hephaestos so mission-tone sizing changes can be
 * smoke-tested without invoking broker or DB code.
 */

function normalizeResponsibilityPlan(plan = null) {
  return plan && typeof plan === 'object' ? plan : {};
}

function normalizeExecutionPlan(plan = null) {
  return plan && typeof plan === 'object' ? plan : {};
}

export function applyResponsibilityExecutionSizing(amount, {
  action = 'BUY',
  confidence = 0,
  responsibilityPlan = null,
  executionPlan = null,
} = {}) {
  const numericAmount = Number(amount || 0);
  if (!(numericAmount > 0) || action !== 'BUY') {
    return { amount: numericAmount, multiplier: 1, reason: null };
  }

  const plan = normalizeResponsibilityPlan(responsibilityPlan);
  const execPlan = normalizeExecutionPlan(executionPlan);
  const ownerMode = String(plan.ownerMode || '').trim().toLowerCase();
  const riskMission = String(plan.riskMission || '').trim().toLowerCase();
  const executionMission = String(plan.executionMission || '').trim().toLowerCase();
  const watchMission = String(plan.watchMission || '').trim().toLowerCase();
  let multiplier = 1;
  const reasons = [];

  if (ownerMode === 'capital_preservation') {
    multiplier *= 0.95;
    reasons.push('owner capital_preservation');
  } else if (ownerMode === 'balanced_rotation') {
    multiplier *= 0.98;
    reasons.push('owner balanced_rotation');
  } else if (ownerMode === 'opportunity_capture' && Number(confidence || 0) >= 0.74) {
    multiplier *= 1.03;
    reasons.push('owner opportunity_capture');
  }

  if (riskMission === 'strict_risk_gate') {
    multiplier *= 0.9;
    reasons.push('risk strict_risk_gate');
  } else if (riskMission === 'soft_sizing_preference') {
    multiplier *= 0.97;
    reasons.push('risk soft_sizing_preference');
  }

  if (executionMission === 'execution_safeguard' || executionMission === 'precision_execution') {
    multiplier *= 0.95;
    reasons.push(`execution ${executionMission}`);
  }

  if (watchMission === 'risk_sentinel') {
    multiplier *= 0.98;
    reasons.push('watch risk_sentinel');
  }

  const entrySizingMultiplier = Number(execPlan.entrySizingMultiplier || 1);
  if (entrySizingMultiplier > 0 && entrySizingMultiplier !== 1) {
    multiplier *= entrySizingMultiplier;
    reasons.push(`executionPlan entry x${entrySizingMultiplier}`);
  }

  const normalizedMultiplier = Number(multiplier.toFixed(4));
  return {
    amount: numericAmount * normalizedMultiplier,
    multiplier: normalizedMultiplier,
    reason: reasons.length > 0 ? reasons.join(' + ') : null,
  };
}
