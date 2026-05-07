// @ts-nocheck

const PHASES = ['trade_quality', 'stage_attribution', 'reflexion', 'curriculum'];
const IMMUTABLE_PHASES = new Set(['trade_quality']);

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

function firstObject(...values) {
  for (const value of values) {
    const objectValue = normalizeObject(value) || parseJsonObject(value);
    if (objectValue) return objectValue;
  }
  return null;
}

function normalizePhase(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[-\s]+/gu, '_');
  if (normalized === 'quality' || normalized === 'tradequality') return 'trade_quality';
  if (normalized === 'stage' || normalized === 'attribution') return 'stage_attribution';
  if (normalized === 'reflection') return 'reflexion';
  return normalized;
}

function normalizeList(value = null) {
  if (Array.isArray(value)) return value.map(normalizePhase).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/u)
      .map(normalizePhase)
      .filter(Boolean);
  }
  return [];
}

function extractPlan(agentPlan = null) {
  const direct = firstObject(agentPlan);
  const envPlan = firstObject(process.env.LUNA_POSTTRADE_AGENT_PLAN_JSON);
  return firstObject(
    direct?.posttradeFeedback,
    direct?.posttrade_feedback,
    direct?.posttrade,
    direct,
    envPlan?.posttradeFeedback,
    envPlan?.posttrade_feedback,
    envPlan?.posttrade,
    envPlan,
  );
}

export function buildPosttradeFeedbackAgentPlan({
  agentPlan = null,
  enabled = {},
} = {}) {
  const plan = extractPlan(agentPlan);
  const disabled = new Set(normalizeList(plan?.disabledPhases || plan?.disabled_phases));
  const enabledOnly = new Set(normalizeList(plan?.enabledPhases || plan?.enabled_phases));
  const warnings = [];
  const phases = {};

  for (const phase of PHASES) {
    const runtimeEnabled = phase === 'curriculum' ? true : Boolean(enabled?.[phase]);
    const enabledFilterActive = enabledOnly.size > 0;
    const requestedEnabled = !enabledFilterActive || enabledOnly.has(phase);
    const requestedDisabled = disabled.has(phase) || !requestedEnabled;
    const unknownEnabled = [...enabledOnly].filter((item) => !PHASES.includes(item));
    const unknownDisabled = [...disabled].filter((item) => !PHASES.includes(item));
    for (const item of unknownEnabled) warnings.push(`unknown_posttrade_phase:${item}`);
    for (const item of unknownDisabled) warnings.push(`unknown_posttrade_phase:${item}`);

    if (!runtimeEnabled) {
      phases[phase] = false;
      if (plan && requestedEnabled && enabledOnly.has(phase)) warnings.push(`runtime_disabled_phase_not_enabled:${phase}`);
      continue;
    }
    if (requestedDisabled && IMMUTABLE_PHASES.has(phase)) {
      phases[phase] = true;
      warnings.push(`immutable_posttrade_phase:${phase}`);
      continue;
    }
    phases[phase] = !requestedDisabled;
  }

  return {
    source: plan ? 'override' : 'default_posttrade_feedback_plan',
    overrideRequested: Boolean(plan),
    phases,
    warnings: [...new Set(warnings)],
  };
}

export function shouldRunPosttradePhase(plan = {}, phase) {
  const key = normalizePhase(phase);
  if (!key) return false;
  return plan?.phases?.[key] === true;
}

export default {
  buildPosttradeFeedbackAgentPlan,
  shouldRunPosttradePhase,
};
