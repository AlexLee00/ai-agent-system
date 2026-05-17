// @ts-nocheck
'use strict';

// Hub LLM selector facade.
// Core remains the route decision SSOT; this file is the Hub-facing entrypoint
// that adds seed/runtime-purpose semantics and Hub-specific non-LLM guards.

const coreSelector = require('../../../packages/core/lib/llm-model-selector');
const { selectRuntimeProfile } = require('../lib/runtime-profiles');

const NON_LLM_TARGETS = new Set([
  'blog.publ',
  'blog.maestro',
  'luna.chronos',
  'investment.chronos',
  'luna.sweeper',
  'investment.sweeper',
  'jay.steward',
  'orchestrator.steward',
]);

const PROVIDER_TIERS = {
  'openai-oauth': 1,
  groq: 2,
  'gemini-cli-oauth': 3,
  'gemini-codeassist-oauth': 3,
  local: 4,
  'claude-code-oauth': 5,
  'claude-code': 5,
};

function clean(value) {
  return String(value || '').trim();
}

function normalizeToken(value) {
  return clean(value).toLowerCase();
}

function canonicalTeam(team) {
  const normalized = normalizeToken(team);
  if (normalized === 'luna') return 'investment';
  if (normalized === 'jay') return 'orchestrator';
  return normalized;
}

function nonLlmKeys(input = {}) {
  const team = normalizeToken(input.callerTeam || input.team || String(input.selectorKey || '').split('.')[0]);
  const agent = normalizeToken(input.agent || input.runtimeAgent || '');
  const canonical = canonicalTeam(team);
  return [
    `${team}.${agent}`,
    `${canonical}.${agent}`,
  ].filter((key) => !key.endsWith('.'));
}

function isHubNonLlmTarget(input = {}) {
  return nonLlmKeys(input).some((key) => NON_LLM_TARGETS.has(key));
}

function routeLabel(entry) {
  const provider = clean(entry?.provider);
  const model = clean(entry?.model);
  if (!provider || !model) return model || provider || '';
  return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
}

function providerFromRoute(route) {
  const normalized = clean(route);
  if (normalized.startsWith('openai-oauth/') || normalized.startsWith('openai/')) return 'openai-oauth';
  if (normalized.startsWith('groq/')) return 'groq';
  if (normalized.startsWith('gemini-cli-oauth/')) return 'gemini-cli-oauth';
  if (normalized.startsWith('gemini-oauth/') || normalized.startsWith('gemini/')) return 'gemini-cli-oauth';
  if (normalized.startsWith('gemini-codeassist-oauth/')) return 'gemini-codeassist-oauth';
  if (normalized.startsWith('local/')) return 'local';
  if (normalized.startsWith('claude-code/')) return 'claude-code-oauth';
  return normalized.split('/')[0] || 'unknown';
}

function providerTier(providerOrRoute) {
  const provider = String(providerOrRoute || '').includes('/')
    ? providerFromRoute(providerOrRoute)
    : clean(providerOrRoute);
  return PROVIDER_TIERS[provider] || 99;
}

function enrichChain(chain = []) {
  return (Array.isArray(chain) ? chain : []).map((entry, index) => {
    const route = routeLabel(entry);
    const provider = providerFromRoute(route);
    return {
      ...entry,
      route,
      provider,
      providerTier: providerTier(provider),
      fallbackIndex: index,
    };
  });
}

function selectorOptionsFromRequest(req = {}, extra = {}) {
  return {
    maxTokens: req.maxTokens,
    temperature: req.temperature,
    agentName: req.agent,
    preferredApi: req.preferredApi,
    groqModel: req.groqModel,
    configuredProviders: req.configuredProviders,
    policyOverride: req.policyOverride,
    rolloutKey: req.traceId || req.requestId || req.incidentKey,
    traceId: req.traceId || req.requestId,
    incidentKey: req.incidentKey,
    ...extra,
  };
}

function requestRuntimePurpose(req = {}, fallback = null) {
  return clean(req.runtimePurpose || req.runtime_purpose || req.taskType || req.task_type || req.agent || fallback);
}

function resolveRuntimeProfile(req = {}, team) {
  const purpose = requestRuntimePurpose(req, 'default').toLowerCase() || 'default';
  const profile = selectRuntimeProfile(team, purpose);
  if (profile) return { profile, purpose };
  if (purpose !== 'default') {
    const fallback = selectRuntimeProfile(team, 'default');
    if (fallback) return { profile: fallback, purpose: 'default' };
  }
  return { profile: null, purpose };
}

function selectionResult(base, chain) {
  const enriched = enrichChain(chain);
  return {
    ok: enriched.length > 0,
    ...base,
    chain: enriched,
    providerTiers: enriched.map((entry) => ({
      provider: entry.provider,
      route: entry.route,
      tier: entry.providerTier,
      fallbackIndex: entry.fallbackIndex,
    })),
  };
}

function resolveHubLlmSelection(req = {}, options = {}) {
  const team = normalizeToken(req.callerTeam || req.team || 'hub') || 'hub';
  const agent = clean(req.agent || '');

  if (isHubNonLlmTarget({ callerTeam: team, agent, selectorKey: req.selectorKey })) {
    return {
      ok: false,
      error: 'llm_non_llm_target_blocked',
      nonLlm: true,
      target: coreSelector.classifyLlmRouteTarget(team, agent, req.selectorKey || null),
      chain: [],
      providerTiers: [],
    };
  }

  const targetPolicy = coreSelector.isLlmRouteTargetAllowed({
    callerTeam: team,
    agent,
    selectorKey: req.selectorKey || null,
  });
  if (!targetPolicy.ok) {
    return {
      ok: false,
      error: targetPolicy.error,
      target: targetPolicy.target,
      chain: [],
      providerTiers: [],
    };
  }

  if (req.selectorKey) {
    const selectorKey = String(req.selectorKey);
    const chain = coreSelector.selectLLMChain(selectorKey, selectorOptionsFromRequest(req));
    return selectionResult({
      selectorKey,
      runtimeProfile: null,
      runtimePurpose: requestRuntimePurpose(req, selectorKey) || null,
      routeTargetKind: targetPolicy.target.kind,
      target: targetPolicy.target,
      source: 'selector_key',
    }, chain);
  }

  if (Array.isArray(req.chain) && req.chain.length > 0) {
    if (!options.allowAdhocChain) {
      return {
        ok: false,
        error: 'llm_adhoc_chain_blocked',
        target: targetPolicy.target,
        chain: [],
        providerTiers: [],
      };
    }
    return selectionResult({
      selectorKey: 'hub.adhoc.chain',
      runtimeProfile: null,
      runtimePurpose: requestRuntimePurpose(req, 'adhoc_chain') || null,
      routeTargetKind: targetPolicy.target.kind,
      target: targetPolicy.target,
      source: 'adhoc_chain',
    }, req.chain);
  }

  if (agent) {
    const described = coreSelector.describeAgentModel(team, agent);
    if (described?.selected && Array.isArray(described.chain) && described.chain.length > 0) {
      return selectionResult({
        selectorKey: described.selectorKey,
        runtimeProfile: null,
        runtimePurpose: requestRuntimePurpose(req, described.selectorKey) || null,
        routeTargetKind: targetPolicy.target.kind,
        target: targetPolicy.target,
        source: 'agent_registry',
      }, described.chain);
    }
  }

  const { profile, purpose } = resolveRuntimeProfile(req, team);
  if (profile?.selector_key) {
    const chain = coreSelector.selectLLMChain(String(profile.selector_key), selectorOptionsFromRequest(req, {
      maxTokens: req.maxTokens ?? profile.max_tokens,
      temperature: req.temperature ?? profile.temperature,
      agentName: profile.selector_agent || agent,
      ...(profile.selector_options || {}),
    }));
    return selectionResult({
      selectorKey: String(profile.selector_key),
      runtimeProfile: `${team}.${purpose}`,
      runtimePurpose: purpose,
      routeTargetKind: targetPolicy.target.kind,
      target: targetPolicy.target,
      source: 'runtime_profile',
    }, chain);
  }

  if (!req.selectorKey && !agent) {
    const chain = coreSelector.selectLLMChain('hub._default', selectorOptionsFromRequest(req));
    return selectionResult({
      selectorKey: 'hub._default',
      runtimeProfile: 'hub.default',
      runtimePurpose: 'default',
      routeTargetKind: targetPolicy.target.kind,
      target: targetPolicy.target,
      source: 'hub_default',
    }, chain);
  }

  return {
    ok: false,
    error: 'llm_selector_chain_required',
    target: targetPolicy.target,
    chain: [],
    providerTiers: [],
  };
}

function isHubLlmRouteTargetAllowed(input = {}) {
  if (isHubNonLlmTarget(input)) {
    return {
      ok: false,
      target: coreSelector.classifyLlmRouteTarget(
        input.callerTeam || input.team || String(input.selectorKey || '').split('.')[0],
        input.agent || '',
        input.selectorKey || null,
      ),
      error: 'llm_non_llm_target_blocked',
    };
  }
  return coreSelector.isLlmRouteTargetAllowed(input);
}

module.exports = {
  ...coreSelector,
  NON_LLM_TARGETS,
  PROVIDER_TIERS,
  enrichChain,
  isHubNonLlmTarget,
  isHubLlmRouteTargetAllowed,
  providerFromRoute,
  providerTier,
  resolveHubLlmSelection,
  routeLabel,
};
