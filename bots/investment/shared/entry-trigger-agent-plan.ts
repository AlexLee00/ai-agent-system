// @ts-nocheck

const OPTIONAL_PHASES = ['signal_refresh', 'derive_market_events'];
const IMMUTABLE_PHASES = ['active_evaluation'];
const ALL_PHASES = [...OPTIONAL_PHASES, ...IMMUTABLE_PHASES];

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
  if (normalized === 'refresh' || normalized === 'signal') return 'signal_refresh';
  if (normalized === 'derive' || normalized === 'market_events') return 'derive_market_events';
  if (normalized === 'active' || normalized === 'evaluation' || normalized === 'fire_evaluation') return 'active_evaluation';
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

function normalizeBool(value, fallback = true) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return fallback;
}

function envBool(key, fallback = true) {
  return normalizeBool(process.env[key], fallback);
}

function extractPlan(agentPlan = null) {
  const direct = firstObject(agentPlan);
  const envPlan = firstObject(process.env.LUNA_ENTRY_TRIGGER_AGENT_PLAN_JSON);
  return firstObject(
    direct?.entryTrigger,
    direct?.entry_trigger,
    direct?.entryTriggerWorker,
    direct?.entry_trigger_worker,
    direct,
    envPlan?.entryTrigger,
    envPlan?.entry_trigger,
    envPlan?.entryTriggerWorker,
    envPlan?.entry_trigger_worker,
    envPlan,
  );
}

function phaseRequested(plan = {}, phase, fallback = true) {
  if (!plan) return fallback;
  const camel = phase.replace(/_([a-z])/gu, (_, ch) => ch.toUpperCase());
  const keys = [
    `${camel}Enabled`,
    `${phase}_enabled`,
    camel,
    phase,
  ];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(plan, key)) {
      return normalizeBool(plan[key], fallback);
    }
  }
  return fallback;
}

export function buildEntryTriggerAgentPlan({
  agentPlan = null,
  runtime = {},
} = {}) {
  const plan = extractPlan(agentPlan);
  const disabled = new Set(normalizeList(plan?.disabledPhases || plan?.disabled_phases));
  const enabledOnly = new Set(normalizeList(plan?.enabledPhases || plan?.enabled_phases));
  const warnings = [];
  const unknown = [...new Set([...disabled, ...enabledOnly].filter((item) => !ALL_PHASES.includes(item)))];
  for (const item of unknown) warnings.push(`unknown_entry_trigger_phase:${item}`);

  const signalRefreshRuntime = runtime.signalRefreshEnabled ?? envBool('LUNA_ENTRY_TRIGGER_SIGNAL_REFRESH_ENABLED', true);
  const deriveRequested = runtime.deriveMarketEventsRequested === true;
  const activeRuntime = runtime.entryTriggerEnabled !== false;

  const phases = {};
  for (const phase of ALL_PHASES) {
    const enabledFilterActive = enabledOnly.size > 0;
    const requestedByFilter = !enabledFilterActive || enabledOnly.has(phase);
    const requested = phaseRequested(plan, phase, true) && requestedByFilter && !disabled.has(phase);

    if (phase === 'signal_refresh') {
      phases[phase] = signalRefreshRuntime === true && requested;
      if (signalRefreshRuntime !== true && requested) warnings.push('runtime_disabled_phase_not_enabled:signal_refresh');
      continue;
    }
    if (phase === 'derive_market_events') {
      phases[phase] = deriveRequested === true && requested;
      if (deriveRequested !== true && requested && enabledOnly.has(phase)) warnings.push('derive_market_events_requires_runtime_request');
      continue;
    }
    if (phase === 'active_evaluation') {
      phases[phase] = activeRuntime === true;
      if (activeRuntime === true && !requested) warnings.push('immutable_entry_trigger_phase:active_evaluation');
      if (activeRuntime !== true && requested) warnings.push('runtime_disabled_phase_not_enabled:active_evaluation');
    }
  }

  return {
    source: plan ? 'override' : 'default_entry_trigger_worker_plan',
    overrideRequested: Boolean(plan),
    phases,
    signalRefreshEnabled: phases.signal_refresh === true,
    deriveMarketEventsEnabled: phases.derive_market_events === true,
    activeEvaluationEnabled: phases.active_evaluation === true,
    warnings: [...new Set(warnings)],
  };
}

export function shouldRunEntryTriggerPhase(plan = {}, phase) {
  const key = normalizePhase(phase);
  if (!key) return false;
  return plan?.phases?.[key] === true;
}

export default {
  buildEntryTriggerAgentPlan,
  shouldRunEntryTriggerPhase,
};
