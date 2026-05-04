'use strict';

const { getJayOrchestrationConfig } = require('./runtime-config.ts');

function normalizeText(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function normalizeBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(text)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(text)) return false;
  return fallback;
}

function normalizeNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function getJayGrowthPolicy(env = process.env, config = getJayOrchestrationConfig()) {
  const enabled = normalizeBoolean(
    env.JAY_GROWTH_ENABLED ?? config.growthEnabled,
    false,
  );
  const disabledReason = normalizeText(
    env.JAY_GROWTH_DISABLED_REASON ?? config.growthDisabledReason,
    'master_decision:growth_pod_not_cutover',
  );
  return {
    serviceLabel: 'ai.jay.growth',
    enabled,
    disabledReason: enabled ? '' : disabledReason,
    decisionOwner: normalizeText(
      env.JAY_GROWTH_DECISION_OWNER ?? config.growthDecisionOwner,
      'master',
    ),
  };
}

function getJayBudgetPolicy(env = process.env, config = getJayOrchestrationConfig()) {
  return {
    dailyBudgetUsd: normalizeNumber(
      env.JAY_LLM_DAILY_BUDGET_USD ?? config.llmDailyBudgetUsd,
      5.0,
    ),
    source: env.JAY_LLM_DAILY_BUDGET_USD ? 'env' : 'runtime_config_default',
  };
}

module.exports = {
  getJayBudgetPolicy,
  getJayGrowthPolicy,
  _testOnly: {
    normalizeBoolean,
    normalizeNumber,
    normalizeText,
  },
};
