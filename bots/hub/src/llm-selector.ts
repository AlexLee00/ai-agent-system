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
  'local-embedding': 4,
  'claude-code-oauth': 5,
  'claude-code': 5,
};

function isGeminiDisabled() {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env.HUB_LLM_GEMINI_DISABLED || '').trim().toLowerCase());
}

function isGeminiProvider(providerOrRoute) {
  const provider = String(providerOrRoute || '').includes('/')
    ? providerFromRoute(providerOrRoute)
    : clean(providerOrRoute);
  return provider === 'gemini-oauth'
    || provider === 'gemini-cli-oauth'
    || provider === 'gemini-codeassist-oauth'
    || provider === 'gemini';
}

function getActiveProviderTiers() {
  if (!isGeminiDisabled()) return PROVIDER_TIERS;
  const tiers = { ...PROVIDER_TIERS };
  delete tiers['gemini-cli-oauth'];
  delete tiers['gemini-codeassist-oauth'];
  return tiers;
}

function clean(value) {
  return String(value || '').trim();
}

function normalizeToken(value) {
  return clean(value).toLowerCase();
}

function normalizeTaskTypeInput(input = {}) {
  return normalizeToken(input.taskType || input.task_type || input.runtimePurpose || input.runtime_purpose || '');
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

function isChronosBacktestEmbeddingTarget(input = {}) {
  const selectorKey = normalizeToken(input.selectorKey || '');
  const taskType = normalizeTaskTypeInput(input);
  const keys = nonLlmKeys(input);
  const chronosTarget = keys.includes('luna.chronos') || keys.includes('investment.chronos');
  if (!chronosTarget) return false;
  const backtestSelector = selectorKey === 'chronos.backtest' || selectorKey === 'investment.chronos.backtest';
  const embeddingTask = taskType === 'backtest_embedding' || taskType === 'embedding';
  return backtestSelector && embeddingTask;
}

function isChronosBacktestJudgmentTarget(input = {}) {
  const taskType = normalizeTaskTypeInput(input);
  const keys = nonLlmKeys(input);
  const chronosTarget = keys.includes('luna.chronos') || keys.includes('investment.chronos');
  if (!chronosTarget) return false;
  return taskType === 'backtest_judgment';
}

function isHubNonLlmTarget(input = {}) {
  if (isChronosBacktestEmbeddingTarget(input)) return false;
  if (isChronosBacktestJudgmentTarget(input)) return false;
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
  if (normalized.startsWith('local-embedding/')) return 'local-embedding';
  if (normalized.startsWith('local/')) return 'local';
  if (normalized.startsWith('claude-code/')) return 'claude-code-oauth';
  return normalized.split('/')[0] || 'unknown';
}

function providerTier(providerOrRoute) {
  const provider = String(providerOrRoute || '').includes('/')
    ? providerFromRoute(providerOrRoute)
    : clean(providerOrRoute);
  return getActiveProviderTiers()[provider] || 99;
}

function getActiveChain(chain = []) {
  const entries = Array.isArray(chain) ? chain : [];
  if (!isGeminiDisabled()) return entries;
  return entries.filter((entry) => !isGeminiProvider(entry?.provider || routeLabel(entry)));
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
    taskType: req.taskType || req.task_type,
    task_type: req.task_type || req.taskType,
    runtimePurpose: req.runtimePurpose || req.runtime_purpose,
    runtime_purpose: req.runtime_purpose || req.runtimePurpose,
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
  const original = Array.isArray(chain) ? chain : [];
  const activeChain = getActiveChain(original);
  const enriched = enrichChain(activeChain);
  const disabledProvidersRemoved = original.length - activeChain.length;
  return {
    ok: enriched.length > 0,
    ...base,
    ...(enriched.length === 0 && original.length > 0 ? { error: 'gemini_provider_disabled' } : {}),
    chain: enriched,
    disabledProvidersRemoved,
    providerTiers: enriched.map((entry) => ({
      provider: entry.provider,
      route: entry.route,
      tier: entry.providerTier,
      fallbackIndex: entry.fallbackIndex,
    })),
  };
}

function parsePolicyEngineMode(raw = process.env.HUB_LLM_POLICY_ENGINE_MODE || 'off') {
  const normalized = normalizeToken(raw || 'off');
  if (normalized === 'shadow') return { mode: 'shadow', teams: [] };
  if (normalized.startsWith('team:')) {
    return {
      mode: 'team',
      teams: normalized.slice('team:'.length).split(',').map((item) => item.trim()).filter(Boolean),
    };
  }
  return { mode: 'off', teams: [] };
}

function normalizeShadowChain(chain = []) {
  return (Array.isArray(chain) ? chain : []).map((entry = {}) => {
    const row = {
      provider: clean(entry.provider),
      model: clean(entry.model),
    };
    const maxTokens = Number(entry.maxTokens);
    const temperature = Number(entry.temperature);
    const timeoutMs = Number(entry.timeoutMs);
    if (Number.isFinite(maxTokens)) row.maxTokens = maxTokens;
    if (Number.isFinite(temperature)) row.temperature = temperature;
    if (Number.isFinite(timeoutMs)) row.timeoutMs = timeoutMs;
    return row;
  });
}

function shadowChainsMatch(oldChain, newChain) {
  return JSON.stringify(normalizeShadowChain(oldChain)) === JSON.stringify(normalizeShadowChain(newChain));
}

function loadPolicyEngine(deps = {}) {
  return deps.policyEngine || require('../../../packages/core/lib/llm-policy-engine');
}

function policyShadowContext(selectorKey, options = {}) {
  const team = normalizeToken(options.team || options.callerTeam || String(selectorKey || '').split('.')[0]);
  const agentName = clean(options.agentName || options.agent || '');
  const taskType = normalizeToken(options.taskType || options.task_type || options.runtimePurpose || options.runtime_purpose || '');
  return {
    selectorKey: clean(selectorKey),
    team,
    callerTeam: team,
    agentName: agentName || null,
    agent: agentName || null,
    taskType: taskType || null,
    task_type: taskType || null,
    runtimePurpose: taskType || null,
    runtime_purpose: taskType || null,
    rolloutKey: options.rolloutKey || null,
    traceId: options.traceId || null,
    incidentKey: options.incidentKey || null,
  };
}

function notePolicyShadowDrop(error, deps = {}) {
  if (typeof deps.onDrop === 'function') {
    deps.onDrop(error);
    return;
  }
  if (process.env.HUB_LLM_POLICY_ENGINE_SHADOW_DEBUG === 'true') {
    console.warn(`[hub-llm-policy-shadow] dropped: ${error?.message || error}`);
  }
}

function writePolicyShadowLog(record, deps = {}) {
  const queryFn = deps.queryFn || ((sql, params) => {
    const pgPool = deps.pgPool || require('../../../packages/core/lib/pg-pool');
    return pgPool.query('public', sql, params);
  });
  return Promise.resolve(queryFn(`
    INSERT INTO hub.llm_policy_shadow_log (selector_key, ctx, match, old_chain, new_chain)
    VALUES ($1, $2::jsonb, $3, $4::jsonb, $5::jsonb)
  `, [
    record.selectorKey,
    JSON.stringify(record.ctx),
    record.match,
    JSON.stringify(record.oldChain),
    JSON.stringify(record.newChain),
  ]));
}

function selectChainWithShadow(selectorKey, options = {}, deps = {}) {
  const selectLLMChain = deps.selectLLMChain || coreSelector.selectLLMChain;
  const oldChain = selectLLMChain(selectorKey, options);
  const parsedMode = parsePolicyEngineMode(deps.mode ?? process.env.HUB_LLM_POLICY_ENGINE_MODE);
  if (parsedMode.mode !== 'shadow') return oldChain;

  try {
    const policyEngine = loadPolicyEngine(deps);
    const ctx = policyShadowContext(selectorKey, options);
    const newChain = policyEngine.resolvePolicyChain(ctx);
    const oldNormalized = normalizeShadowChain(oldChain);
    const newNormalized = normalizeShadowChain(newChain);
    const writePromise = writePolicyShadowLog({
      selectorKey,
      ctx,
      match: shadowChainsMatch(oldNormalized, newNormalized),
      oldChain: oldNormalized,
      newChain: newNormalized,
    }, deps).catch((error) => notePolicyShadowDrop(error, deps));
    if (Array.isArray(deps.shadowPromises)) deps.shadowPromises.push(writePromise);
  } catch (error) {
    notePolicyShadowDrop(error, deps);
  }

  return oldChain;
}

function resolveHubLlmSelection(req = {}, options = {}) {
  const team = normalizeToken(req.callerTeam || req.team || 'hub') || 'hub';
  const agent = clean(req.agent || '');

  if (isHubNonLlmTarget({ callerTeam: team, agent, selectorKey: req.selectorKey, taskType: normalizeTaskTypeInput(req) })) {
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
    const chain = selectChainWithShadow(selectorKey, selectorOptionsFromRequest(req, {
      team,
      callerTeam: team,
      agentName: req.agent || req.agentName,
    }));
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
    const chain = selectChainWithShadow(String(profile.selector_key), selectorOptionsFromRequest(req, {
      maxTokens: req.maxTokens ?? profile.max_tokens,
      temperature: req.temperature ?? profile.temperature,
      agentName: profile.selector_agent || agent,
      team,
      callerTeam: team,
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
    const chain = selectChainWithShadow('hub._default', selectorOptionsFromRequest(req, {
      team,
      callerTeam: team,
    }));
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
  getActiveChain,
  getActiveProviderTiers,
  isGeminiDisabled,
  isGeminiProvider,
  isHubNonLlmTarget,
  isHubLlmRouteTargetAllowed,
  providerFromRoute,
  providerTier,
  resolveHubLlmSelection,
  routeLabel,
  selectChainWithShadow,
};
