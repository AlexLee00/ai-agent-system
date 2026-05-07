// @ts-nocheck

const OPTIONAL_FEATURES = [
  'normal_to_validation_fallback',
  'validation_live_reentry_softening',
];
const IMMUTABLE_FEATURES = [
  'pre_trade_check',
  'capital_backpressure',
  'position_sizing',
  'live_fire_cap',
  'same_day_reentry_block',
];
const ALL_FEATURES = [...OPTIONAL_FEATURES, ...IMMUTABLE_FEATURES];

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

function normalizeFeature(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[-\s]+/gu, '_');
  if (normalized === 'validation_fallback' || normalized === 'normal_validation_fallback') return 'normal_to_validation_fallback';
  if (normalized === 'validation_reentry' || normalized === 'live_reentry_softening') return 'validation_live_reentry_softening';
  if (normalized === 'pretrade' || normalized === 'pre_trade') return 'pre_trade_check';
  if (normalized === 'sizing') return 'position_sizing';
  if (normalized === 'live_cap') return 'live_fire_cap';
  return normalized;
}

function normalizeList(value = null) {
  if (Array.isArray(value)) return value.map(normalizeFeature).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/u)
      .map(normalizeFeature)
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

function extractPlan(agentPlan = null) {
  const direct = firstObject(agentPlan);
  const envPlan = firstObject(process.env.LUNA_EXECUTION_AGENT_PLAN_JSON);
  return firstObject(
    direct?.execution,
    direct?.hephaestos,
    direct?.hephaestosExecution,
    direct?.hephaestos_execution,
    direct?.executionAgentPlan,
    direct?.execution_agent_plan,
    direct?.agentPlan?.execution,
    direct?.agent_plan?.execution,
    direct?.block_meta?.executionAgentPlan,
    direct?.block_meta?.execution_agent_plan,
    direct?.block_meta?.agentPlan?.execution,
    direct?.block_meta?.agent_plan?.execution,
    direct?.strategy_route?.executionAgentPlan,
    direct?.strategy_route?.execution_agent_plan,
    direct,
    envPlan?.execution,
    envPlan?.hephaestos,
    envPlan?.hephaestosExecution,
    envPlan?.hephaestos_execution,
    envPlan,
  );
}

function featureRequested(plan = {}, feature, fallback = true) {
  if (!plan) return fallback;
  const camel = feature.replace(/_([a-z])/gu, (_, ch) => ch.toUpperCase());
  const keys = [
    `${camel}Enabled`,
    `${feature}_enabled`,
    camel,
    feature,
  ];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(plan, key)) {
      return normalizeBool(plan[key], fallback);
    }
  }
  return fallback;
}

export function buildHephaestosExecutionAgentPlan({
  agentPlan = null,
  enabled = {},
} = {}) {
  const plan = extractPlan(agentPlan);
  const disabled = new Set(normalizeList(plan?.disabledFeatures || plan?.disabled_features || plan?.disabledPhases || plan?.disabled_phases));
  const enabledOnly = new Set(normalizeList(plan?.enabledFeatures || plan?.enabled_features || plan?.enabledPhases || plan?.enabled_phases));
  const warnings = [];
  const unknown = [...new Set([...disabled, ...enabledOnly].filter((item) => !ALL_FEATURES.includes(item)))];
  for (const item of unknown) warnings.push(`unknown_execution_feature:${item}`);

  const features = {};
  for (const feature of ALL_FEATURES) {
    const enabledFilterActive = enabledOnly.size > 0;
    const requestedByFilter = !enabledFilterActive || enabledOnly.has(feature);
    const requested = featureRequested(plan, feature, true) && requestedByFilter && !disabled.has(feature);

    if (IMMUTABLE_FEATURES.includes(feature)) {
      features[feature] = true;
      if (!requested) warnings.push(`immutable_execution_feature:${feature}`);
      continue;
    }

    const runtimeEnabled = enabled?.[feature] !== false;
    features[feature] = runtimeEnabled && requested;
    if (!runtimeEnabled && requested) warnings.push(`runtime_disabled_execution_feature_not_enabled:${feature}`);
  }

  return {
    source: plan ? 'override' : 'default_hephaestos_execution_plan',
    overrideRequested: Boolean(plan),
    features,
    normalToValidationFallbackEnabled: features.normal_to_validation_fallback === true,
    validationLiveReentrySofteningEnabled: features.validation_live_reentry_softening === true,
    warnings: [...new Set(warnings)],
  };
}

export function shouldRunHephaestosExecutionFeature(plan = {}, feature) {
  const key = normalizeFeature(feature);
  if (!key) return false;
  return plan?.features?.[key] === true;
}

export default {
  buildHephaestosExecutionAgentPlan,
  shouldRunHephaestosExecutionFeature,
};
