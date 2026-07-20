// @ts-nocheck
'use strict';

const GEMINI_PROVIDER_ALIASES = new Set([
  'gemini',
  'gemini-oauth',
  'gemini-cli-oauth',
  'gemini-codeassist-oauth',
  'gemini-code-assist-oauth',
  'google-gemini-cli',
]);
const RETIRED_GEMINI_SELECTOR_KEYS = Object.freeze([
  'hub.oauth.gemini_cli.expiry_probe',
  'hub.gemini.cli.adapter.smoke',
  'hub.gemini.cli.readiness.live',
  'hub.unified.oauth.gemini.smoke',
]);
const retiredGeminiSelectorKeySet = new Set(RETIRED_GEMINI_SELECTOR_KEYS);
const QUARANTINED_EXACT_LLM_ROUTES = Object.freeze({
  'groq/qwen/qwen3-32b': 'groq/openai/gpt-oss-120b',
});
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'n', 'off']);
const ENABLE_ENV_KEYS = [
  'HUB_LLM_ALLOW_GEMINI_ACTIVE_ROUTES',
  'HUB_ENABLE_GEMINI_PUBLIC_API',
  'HUB_ENABLE_GOOGLE_PUBLIC_API',
  'HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CLI',
  'HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CODEASSIST_SERVICE',
];
const warnedSources = new Set();

function normalized(value) {
  return String(value || '').trim().toLowerCase();
}

function isGeminiProvider(value) {
  const token = normalized(value);
  if (!token) return false;
  const provider = token.includes('/') ? token.split('/')[0] : token;
  return GEMINI_PROVIDER_ALIASES.has(provider)
    || /(?:^|\/)gemini(?:[-/]|$)/.test(token)
    || token.startsWith('google-gemini-cli/');
}

function isRetiredGeminiSelectorKey(value) {
  return retiredGeminiSelectorKeySet.has(normalized(value));
}

function exactLlmRoute(providerOrRoute, model = '') {
  const provider = normalized(providerOrRoute);
  const modelName = normalized(model);
  if (!modelName) return provider;
  return `${provider}/${modelName.replace(new RegExp(`^${provider}/`), '')}`;
}

function getQuarantinedLlmRouteReplacement(providerOrRoute, model = '') {
  return QUARANTINED_EXACT_LLM_ROUTES[exactLlmRoute(providerOrRoute, model)] || null;
}

function isQuarantinedExactLlmRoute(providerOrRoute, model = '') {
  return getQuarantinedLlmRouteReplacement(providerOrRoute, model) != null;
}

function replaceQuarantinedExactLlmRoute(providerOrRoute, model = '') {
  const replacement = getQuarantinedLlmRouteReplacement(providerOrRoute, model);
  if (replacement) return replacement;
  if (normalized(model)) return exactLlmRoute(providerOrRoute, model);
  return String(providerOrRoute || '').trim();
}

function getGeminiRetirementState(env = process.env) {
  const disabledRaw = normalized(env?.HUB_LLM_GEMINI_DISABLED);
  const overrideKeys = [];
  if (FALSE_VALUES.has(disabledRaw)) overrideKeys.push('HUB_LLM_GEMINI_DISABLED');
  for (const key of ENABLE_ENV_KEYS) {
    if (TRUE_VALUES.has(normalized(env?.[key]))) overrideKeys.push(key);
  }
  return {
    retired: true,
    disabled: true,
    configuredDisabled: disabledRaw === '' || TRUE_VALUES.has(disabledRaw),
    overrideRequested: overrideKeys.length > 0,
    overrideKeys,
  };
}

function warnGeminiRetirementOverride(source = 'unknown', env = process.env) {
  const state = getGeminiRetirementState(env);
  const key = String(source || 'unknown');
  if (state.overrideRequested && !warnedSources.has(key)) {
    warnedSources.add(key);
    console.warn(`[llm-retirement] Gemini re-enable settings ignored at ${key}: ${state.overrideKeys.join(',')}`);
  }
  return state;
}

function assertProviderNotRetired(providerOrRoute) {
  if (!isGeminiProvider(providerOrRoute)) return;
  const error = new Error('gemini_provider_disabled');
  error.code = 'gemini_provider_disabled';
  error.retired = true;
  throw error;
}

export {
  GEMINI_PROVIDER_ALIASES,
  QUARANTINED_EXACT_LLM_ROUTES,
  RETIRED_GEMINI_SELECTOR_KEYS,
  assertProviderNotRetired,
  getQuarantinedLlmRouteReplacement,
  getGeminiRetirementState,
  isGeminiProvider,
  isQuarantinedExactLlmRoute,
  isRetiredGeminiSelectorKey,
  replaceQuarantinedExactLlmRoute,
  warnGeminiRetirementOverride,
};

module.exports = {
  GEMINI_PROVIDER_ALIASES,
  QUARANTINED_EXACT_LLM_ROUTES,
  RETIRED_GEMINI_SELECTOR_KEYS,
  assertProviderNotRetired,
  getQuarantinedLlmRouteReplacement,
  getGeminiRetirementState,
  isGeminiProvider,
  isQuarantinedExactLlmRoute,
  isRetiredGeminiSelectorKey,
  replaceQuarantinedExactLlmRoute,
  warnGeminiRetirementOverride,
};
