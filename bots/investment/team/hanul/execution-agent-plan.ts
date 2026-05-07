// @ts-nocheck

const OPTIONAL_FEATURES = [
  'responsibility_execution_sizing',
];

const IMMUTABLE_FEATURES = [
  'nemesis_approval',
  'pre_trade_check',
  'risk_check',
  'sizing_floor',
  'fill_verification',
  'pending_reconcile',
  'position_mode_conflict',
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
  if (normalized === 'responsibility_sizing' || normalized === 'execution_tone') return 'responsibility_execution_sizing';
  if (normalized === 'nemesis') return 'nemesis_approval';
  if (normalized === 'pretrade' || normalized === 'pre_trade') return 'pre_trade_check';
  if (normalized === 'risk') return 'risk_check';
  if (normalized === 'floor') return 'sizing_floor';
  if (normalized === 'fill') return 'fill_verification';
  if (normalized === 'reconcile') return 'pending_reconcile';
  if (normalized === 'mode_conflict') return 'position_mode_conflict';
  if (normalized === 'same_day') return 'same_day_reentry_block';
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

function normalizeMarket(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (['kr', 'krx', 'domestic', 'kis'].includes(normalized)) return 'domestic';
  if (['us', 'usa', 'overseas', 'kis_overseas'].includes(normalized)) return 'overseas';
  return normalized || null;
}

function extractPlan(agentPlan = null, market = null) {
  const direct = firstObject(agentPlan);
  const envPlan = firstObject(
    process.env.LUNA_HANUL_EXECUTION_AGENT_PLAN_JSON,
    process.env.LUNA_KIS_EXECUTION_AGENT_PLAN_JSON,
  );
  const marketKey = normalizeMarket(market);
  const nested = firstObject(
    direct?.hanul,
    direct?.kis,
    direct?.kisExecution,
    direct?.kis_execution,
    direct?.hanulExecution,
    direct?.hanul_execution,
    direct?.execution?.hanul,
    direct?.execution?.kis,
    direct?.agentPlan?.execution?.hanul,
    direct?.agentPlan?.execution?.kis,
    direct?.agent_plan?.execution?.hanul,
    direct?.agent_plan?.execution?.kis,
    marketKey ? direct?.execution?.[marketKey] : null,
    marketKey ? direct?.agentPlan?.execution?.[marketKey] : null,
    marketKey ? direct?.agent_plan?.execution?.[marketKey] : null,
    envPlan?.hanul,
    envPlan?.kis,
    marketKey ? envPlan?.[marketKey] : null,
  );
  return firstObject(nested, direct?.execution, direct?.agentPlan?.execution, direct?.agent_plan?.execution);
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

function normalizeSafeSizingMultiplier(value = null, warnings = []) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!(parsed > 0)) {
    warnings.push('invalid_hanul_entry_sizing_multiplier');
    return null;
  }
  if (parsed > 1) {
    warnings.push('hanul_entry_sizing_multiplier_clamped_to_1');
    return 1;
  }
  if (parsed < 0.25) {
    warnings.push('hanul_entry_sizing_multiplier_clamped_to_0.25');
    return 0.25;
  }
  return Number(parsed.toFixed(4));
}

export function buildHanulExecutionAgentPlan({
  agentPlan = null,
  market = null,
  enabled = {},
} = {}) {
  const plan = extractPlan(agentPlan, market);
  const disabled = new Set(normalizeList(plan?.disabledFeatures || plan?.disabled_features || plan?.disabledPhases || plan?.disabled_phases));
  const enabledOnly = new Set(normalizeList(plan?.enabledFeatures || plan?.enabled_features || plan?.enabledPhases || plan?.enabled_phases));
  const warnings = [];
  const unknown = [...new Set([...disabled, ...enabledOnly].filter((item) => !ALL_FEATURES.includes(item)))];
  for (const item of unknown) warnings.push(`unknown_hanul_execution_feature:${item}`);

  const features = {};
  for (const feature of ALL_FEATURES) {
    const enabledFilterActive = enabledOnly.size > 0;
    const requestedByFilter = !enabledFilterActive || enabledOnly.has(feature);
    const requested = featureRequested(plan, feature, true) && requestedByFilter && !disabled.has(feature);

    if (IMMUTABLE_FEATURES.includes(feature)) {
      features[feature] = true;
      if (!requested) warnings.push(`immutable_hanul_execution_feature:${feature}`);
      continue;
    }

    const runtimeEnabled = enabled?.[feature] !== false;
    features[feature] = runtimeEnabled && requested;
    if (!runtimeEnabled && requested) warnings.push(`runtime_disabled_hanul_execution_feature:${feature}`);
  }

  const requestedMultiplier = plan?.entrySizingMultiplier ?? plan?.entry_sizing_multiplier ?? null;
  const entrySizingMultiplier = features.responsibility_execution_sizing
    ? normalizeSafeSizingMultiplier(requestedMultiplier, warnings)
    : null;

  return {
    source: plan ? 'override' : 'default_hanul_execution_plan',
    overrideRequested: Boolean(plan),
    market: normalizeMarket(market),
    features,
    responsibilityExecutionSizingEnabled: features.responsibility_execution_sizing === true,
    entrySizingMultiplier,
    warnings: [...new Set(warnings)],
  };
}

export function shouldRunHanulExecutionFeature(plan = {}, feature) {
  const key = normalizeFeature(feature);
  if (!key) return false;
  return plan?.features?.[key] === true;
}

export default {
  buildHanulExecutionAgentPlan,
  shouldRunHanulExecutionFeature,
};
