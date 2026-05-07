// @ts-nocheck

function normalizeObject(value = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function parseJsonObject(value = null) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed[0] !== '{') return null;
  try {
    return normalizeObject(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function normalizeBool(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return fallback;
}

function firstObject(...values) {
  for (const value of values) {
    const objectValue = normalizeObject(value) || parseJsonObject(value);
    if (objectValue) return objectValue;
  }
  return null;
}

function extractMonitorOverride({ agentPlan = null, eventPayload = null } = {}) {
  const payload = normalizeObject(eventPayload) || parseJsonObject(eventPayload) || {};
  const direct = firstObject(agentPlan);
  if (direct) {
    return firstObject(direct.monitor, direct.positionMonitor, direct.position_monitor, direct);
  }
  return firstObject(
    payload?.agentPlan?.monitor,
    payload?.agentPlan?.positionMonitor,
    payload?.agent_plan?.monitor,
    payload?.agent_plan?.position_monitor,
    payload?.monitorAgentPlan,
    payload?.positionMonitorAgentPlan,
  );
}

function applyBoolOverride(target, key, override, candidates, warnings) {
  for (const candidate of candidates) {
    if (override?.[candidate] !== undefined) {
      const parsed = normalizeBool(override[candidate], null);
      if (parsed === null) {
        warnings.push(`invalid_monitor_agent_plan_bool:${candidate}`);
        return target[key];
      }
      return parsed;
    }
  }
  return target[key];
}

export function buildPositionMonitorAgentPlan({
  agentPlan = null,
  eventPayload = null,
  liveIndicators = true,
  lifecycleFlags = null,
} = {}) {
  const flags = lifecycleFlags || {};
  const signalRefreshRuntimeEnabled = flags?.shouldExecuteSignalRefresh?.() === true;
  const reflexiveRuntimeEnabled = flags?.shouldApplyReflexiveMonitoring?.() === true;
  const dynamicTrailRuntimeEnabled = flags?.shouldApplyDynamicTrail?.() === true;
  const override = extractMonitorOverride({ agentPlan, eventPayload });
  const warnings = [];

  const plan = {
    source: override ? 'override' : 'default_position_monitor_plan',
    overrideRequested: Boolean(override),
    liveIndicatorsEnabled: liveIndicators !== false,
    signalRefreshEnabled: signalRefreshRuntimeEnabled,
    externalEvidenceEnabled: true,
    strategyMutationEnabled: true,
    reflexivePortfolioEnabled: reflexiveRuntimeEnabled,
    dynamicSizingEvaluationEnabled: true,
    dynamicTrailEvaluationEnabled: true,
    warnings,
  };

  if (!override) return plan;

  plan.liveIndicatorsEnabled = applyBoolOverride(plan, 'liveIndicatorsEnabled', override, [
    'liveIndicatorsEnabled',
    'liveIndicators',
    'technicalIndicatorEnabled',
    'technical_indicators_enabled',
  ], warnings);
  plan.signalRefreshEnabled = applyBoolOverride(plan, 'signalRefreshEnabled', override, [
    'signalRefreshEnabled',
    'signalRefresh',
    'refreshSignals',
    'signal_refresh_enabled',
  ], warnings);
  plan.externalEvidenceEnabled = applyBoolOverride(plan, 'externalEvidenceEnabled', override, [
    'externalEvidenceEnabled',
    'externalEvidence',
    'evidenceLedgerEnabled',
    'external_evidence_enabled',
  ], warnings);
  plan.strategyMutationEnabled = applyBoolOverride(plan, 'strategyMutationEnabled', override, [
    'strategyMutationEnabled',
    'strategyMutation',
    'mutationEnabled',
    'strategy_mutation_enabled',
  ], warnings);
  plan.dynamicSizingEvaluationEnabled = applyBoolOverride(plan, 'dynamicSizingEvaluationEnabled', override, [
    'dynamicSizingEvaluationEnabled',
    'dynamicSizingEnabled',
    'dynamicPositionSizingEnabled',
    'dynamic_sizing_enabled',
  ], warnings);

  const requestedReflexive = applyBoolOverride(plan, 'reflexivePortfolioEnabled', override, [
    'reflexivePortfolioEnabled',
    'reflexiveMonitoringEnabled',
    'portfolioReflexiveEnabled',
    'reflexive_portfolio_enabled',
  ], warnings);
  if (reflexiveRuntimeEnabled && requestedReflexive === false) {
    plan.reflexivePortfolioEnabled = true;
    warnings.push('immutable_monitor_safety_gate:reflexive_portfolio');
  } else {
    plan.reflexivePortfolioEnabled = requestedReflexive;
  }

  const requestedTrail = applyBoolOverride(plan, 'dynamicTrailEvaluationEnabled', override, [
    'dynamicTrailEvaluationEnabled',
    'dynamicTrailEnabled',
    'dynamicTrailingEnabled',
    'trailStopEnabled',
    'dynamic_trail_enabled',
  ], warnings);
  if (dynamicTrailRuntimeEnabled && requestedTrail === false) {
    plan.dynamicTrailEvaluationEnabled = true;
    warnings.push('immutable_monitor_safety_gate:dynamic_trail');
  } else {
    plan.dynamicTrailEvaluationEnabled = requestedTrail;
  }

  return plan;
}

export function buildDisabledDynamicPositionSizingSnapshot(reasonCode = 'dynamic_position_sizing_agent_plan_disabled') {
  return {
    enabled: false,
    shadowMode: true,
    reasonCode,
    mode: 'disabled_by_agent_plan',
    executionAction: 'HOLD',
    runnerHint: null,
    adjustmentRatio: 0,
    details: {
      note: 'dynamic position sizing evaluation disabled by monitor agent plan',
    },
  };
}

export function buildDisabledDynamicTrailSnapshot(reasonCode = 'dynamic_trail_agent_plan_disabled') {
  return {
    enabled: false,
    shadowMode: true,
    method: 'disabled_by_agent_plan',
    side: 'long',
    close: 0,
    atr: 0,
    stopPrice: null,
    proposedStopPrice: null,
    previousStopPrice: null,
    breached: false,
    breachReasonCode: null,
    reasonCode,
    inputs: {
      note: 'dynamic trail evaluation disabled by monitor agent plan',
    },
  };
}

export default {
  buildPositionMonitorAgentPlan,
  buildDisabledDynamicPositionSizingSnapshot,
  buildDisabledDynamicTrailSnapshot,
};
