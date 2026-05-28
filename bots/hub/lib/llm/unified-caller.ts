'use strict';

// Unified LLM Caller — Hub selector facade + Circuit Breaker + Fallback Exhaustion
// Core selector remains the SSOT; Hub-specific routing goes through src/llm-selector.ts.

const crypto = require('node:crypto');

const path = require('node:path');
const { traceLLMCall } = require(path.join(__dirname, '../langfuse-tracer'));

const { callClaudeCodeOAuth } = require('./claude-code-oauth');
const { callGroqFallback } = require('./groq-fallback');
const { callLocalOllama } = require('./local-ollama');
const {
  callOpenAiCodexOAuth,
  callGeminiOAuth,
  callGeminiCliOAuth,
  callGeminiCodeAssistOAuth,
} = require('./oauth-direct');
const { checkCache, saveCache } = require('./cache');
const { getGroqFallback } = require('../../../../packages/core/lib/llm-models');
const rag = require('../../../../packages/core/lib/rag');
const { resolveHubLlmSelection, isGeminiDisabled } = require('../../src/llm-selector');
const providerRegistry = require('./provider-registry');
const sender = require('../../../../packages/core/lib/telegram-sender');

const CLAUDE_CODE_MODEL = {
  anthropic_haiku: 'haiku',
  anthropic_sonnet: 'sonnet',
  anthropic_opus: 'opus',
};

const DEFAULT_CLAUDE_CODE_TIMEOUT_MS = 90_000;
const CLAUDE_CODE_SONNET_REPLACEMENT_ROUTE = 'openai-oauth/gpt-5.4';
const DEFAULT_OPENAI_OAUTH_RETRY_ATTEMPTS = 1;
const DEFAULT_OPENAI_OAUTH_RETRY_DELAY_MS = 750;
const MAX_OPENAI_OAUTH_RETRY_ATTEMPTS = 3;
const CLAUDE_CODE_BUDGET_FLOORS_USD = {
  haiku: 0.05,
  sonnet: 0.2,
  opus: 0.5,
};

const inFlightDedupe = new Map();

let _groqModelCache;
function _groqModel() {
  if (!_groqModelCache) {
    _groqModelCache = {
      anthropic_haiku: getGroqFallback('anthropic_haiku'),
      anthropic_sonnet: getGroqFallback('anthropic_sonnet'),
      anthropic_opus: getGroqFallback('anthropic_opus'),
    };
  }
  return _groqModelCache;
}

async function callWithFallback(req) {
  let result;
  if (_inflightDedupeEnabled(req)) {
    result = await _runWithInflightDedupe(req, () => _callWithFallbackInternal(req));
  } else {
    result = await _callWithFallbackInternal(req);
  }
  traceLLMCall(req, result, {
    agent: req.agent,
    callerTeam: req.callerTeam,
    taskType: req.taskType,
    selectorKey: req.selectorKey,
    abstractModel: req.abstractModel,
    budgetGuardStatus: req._budgetGuardStatus,
  });
  return result;
}

async function _callWithFallbackInternal(req) {
  const team = req.callerTeam || 'hub';
  const estimatedCostUsd = _estimatedCostUsd(req);
  req._estimatedCostUsd = estimatedCostUsd;

  // 0. Budget check
  if (process.env.HUB_BUDGET_GUARDIAN_ENABLED !== 'false') {
    try {
      const { BudgetGuardian } = require('../budget-guardian');
      const budgetCheck = BudgetGuardian.getInstance().checkAndReserve(team, estimatedCostUsd);
      req._budgetGuardStatus = budgetCheck.ok ? 'allowed' : 'blocked';
      if (!budgetCheck.ok) {
        console.warn(`[llm/unified] 예산 차단 (${team}): ${budgetCheck.reason}`);
        return {
          ok: false,
          provider: 'failed',
          error: `budget_exceeded: ${budgetCheck.reason}`,
          durationMs: 0,
          estimatedCostUsd,
          budgetGuardStatus: 'blocked',
        };
      }
    } catch (e) {
      console.warn('[llm/unified] BudgetGuardian 오류 (무시):', e.message);
      req._budgetGuardStatus = 'error_ignored';
    }
  } else {
    req._budgetGuardStatus = 'disabled';
  }

  // 1. Cache check
  if (req.cacheEnabled) {
    try {
      const cacheKey = _cacheKey(req);
      const cached = await checkCache(cacheKey);
      if (cached.hit) {
        console.log(`[llm/unified] 캐시 히트 (${req.abstractModel})`);
        return { ok: true, provider: 'cache', result: cached.response, durationMs: 0, totalCostUsd: 0, cacheHit: true, cachedAt: cached.cachedAt };
      }
    } catch (e) {
      console.warn('[llm/unified] 캐시 조회 오류 (무시):', e.message);
    }
  }

  // 2. Build chain from the Hub selector registry. Runtime profiles only map
  // team/purpose to selector keys; they do not own model selection.
  if (_hasAdhocChain(req) && !req.selectorKey && !_adhocChainAllowed()) {
    return {
      ok: false,
      provider: 'failed',
      durationMs: 0,
      error: 'llm_adhoc_chain_blocked',
      fallbackCount: 0,
    };
  }
  const selection = _resolveSelectorChain(req, team);
  if (selection?.chain?.length) {
    return _callWithSelectorChain(req, selection, team);
  }
  if (selection?.error) {
    return {
      ok: false,
      provider: 'failed',
      durationMs: 0,
      error: selection.error,
      fallbackCount: 0,
      selectorKey: selection.selectorKey || null,
      routeTargetKind: selection.routeTargetKind || selection.target?.kind || null,
      runtimePurpose: selection.runtimePurpose || null,
      estimatedCostUsd,
      budgetGuardStatus: req._budgetGuardStatus || null,
      providerTiers: selection.providerTiers || [],
    };
  }
  if (process.env.HUB_LLM_ALLOW_LEGACY_CHAIN === 'true') return _callLegacy(req, team);
  return {
    ok: false,
    provider: 'failed',
    durationMs: 0,
    error: 'llm_selector_chain_required',
    fallbackCount: 0,
  };
}

function _inflightDedupeEnabled(req) {
  if (_flagDisabled('HUB_LLM_INFLIGHT_DEDUPE_ENABLED')) return false;
  return typeof req?.prompt === 'string' && req.prompt.length > 0;
}

function _inflightDedupeKey(req) {
  const payload = {
    callerTeam: req?.callerTeam || 'hub',
    agent: req?.agent || null,
    selectorKey: req?.selectorKey || null,
    taskType: req?.taskType || null,
    abstractModel: req?.abstractModel || null,
    systemPrompt: req?.systemPrompt || '',
    prompt: req?.prompt || '',
    jsonSchema: req?.jsonSchema || null,
    maxTokens: req?.maxTokens ?? null,
    temperature: req?.temperature ?? null,
    timeoutMs: req?.timeoutMs ?? null,
    maxBudgetUsd: req?.maxBudgetUsd ?? null,
    chain: req?.chain || null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function _runWithInflightDedupe(req, executor) {
  const key = _inflightDedupeKey(req);
  const existing = inFlightDedupe.get(key);
  if (existing) {
    const started = Date.now();
    const resp = await existing;
    return {
      ...resp,
      dedupeHit: true,
      dedupeProvider: resp.provider,
      durationMs: Date.now() - started,
      totalCostUsd: 0,
    };
  }

  const promise = Promise.resolve().then(executor);
  inFlightDedupe.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlightDedupe.delete(key);
  }
}

function _resolveSelectorChain(req, team) {
  try {
    const selection = resolveHubLlmSelection(req, { allowAdhocChain: _adhocChainAllowed() });
    if (selection?.chain?.length) return _applySelectorAvoidProviders(req, selection);
    if (selection?.error === 'llm_adhoc_chain_blocked') return null;
    return selection?.error ? selection : null;
  } catch (e) {
    console.warn(`[llm/unified] selector chain 해석 실패 (${team}/${req.agent || req.selectorKey || 'unknown'}): ${e.message}`);
  }
  return null;
}

function _hasAdhocChain(req) {
  return Array.isArray(req?.chain) && req.chain.length > 0;
}

function _adhocChainAllowed() {
  return _truthyEnv('HUB_LLM_ALLOW_ADHOC_CHAIN');
}

function _applySelectorAvoidProviders(req, selectorChain) {
  const avoidProviders = Array.isArray(req?.avoidProviders)
    ? req.avoidProviders.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    : [];
  if (!avoidProviders.length || !Array.isArray(selectorChain?.chain)) return selectorChain;

  const avoid = new Set(avoidProviders);
  const preferred = [];
  const avoided = [];
  for (const entry of selectorChain.chain) {
    const provider = String(entry?.provider || _routeToProvider(_chainEntryToRoute(entry))).trim().toLowerCase();
    if (avoid.has(provider)) avoided.push(entry);
    else preferred.push(entry);
  }
  if (!preferred.length) return { ...selectorChain, avoidedProviders: avoidProviders };
  return { ...selectorChain, chain: preferred.concat(avoided), avoidedProviders: avoidProviders };
}

async function _callWithSelectorChain(req, selectorChain, team) {
  const chainTimeout = req.timeoutMs || 30_000;
  const attempts = [];

  for (const entry of selectorChain.chain) {
    const route = _chainEntryToRoute(entry);
    const selectedRoute = _normalizeRoute(route, req.abstractModel);
    const result = await _callRoute(route, req, entry.timeoutMs || chainTimeout, entry);
    if (result.ok) {
      if (req.cacheEnabled && result.result) _saveCache(req, result).catch(() => {});
      return {
        ...result,
        provider: _routeToProvider(selectedRoute),
        selected_route: selectedRoute,
        selectorKey: selectorChain.selectorKey,
        runtimeProfile: selectorChain.runtimeProfile || null,
        runtimePurpose: selectorChain.runtimePurpose || null,
        routeTargetKind: selectorChain.routeTargetKind || selectorChain.target?.kind || null,
        providerTiers: selectorChain.providerTiers || [],
        estimatedCostUsd: req._estimatedCostUsd || null,
        budgetGuardStatus: req._budgetGuardStatus || null,
        avoidedProviders: selectorChain.avoidedProviders || [],
        fallbackCount: attempts.length,
        attempted_providers: attempts.map(a => a.provider),
      };
    }
    attempts.push({ provider: selectedRoute, error: result.error || 'unknown', durationMs: result.durationMs });
    console.warn(`[llm/unified] ${selectorChain.selectorKey}:${selectedRoute} 실패 (${result.error}) → 다음 시도`);
  }

  const safeFallback = _safeFallbackForSelectorExhaustion(req, selectorChain, attempts, team);
  if (safeFallback) return safeFallback;
  if (!_shouldSuppressFallbackExhaustionAlarm(req, selectorChain)) {
    await _notifyFallbackExhaustion(req, attempts, team);
  }
  return {
    ok: false,
    provider: 'failed',
    durationMs: attempts.reduce((s, a) => s + a.durationMs, 0),
    error: `fallback_exhausted: ${(attempts[attempts.length - 1] || {}).error || 'unknown'}`,
    attempted_providers: attempts.map(a => a.provider),
    avoidedProviders: selectorChain.avoidedProviders || [],
    fallbackCount: attempts.length,
    selectorKey: selectorChain.selectorKey,
    runtimeProfile: selectorChain.runtimeProfile || null,
    runtimePurpose: selectorChain.runtimePurpose || null,
    routeTargetKind: selectorChain.routeTargetKind || selectorChain.target?.kind || null,
    providerTiers: selectorChain.providerTiers || [],
    estimatedCostUsd: req._estimatedCostUsd || null,
    budgetGuardStatus: req._budgetGuardStatus || null,
  };
}

async function _callWithProfileChain(req, profile, team) {
  const chain = [
    ...(profile.primary_routes || []),
    ...(profile.fallback_routes || []),
  ].filter(_isProviderSupported);

  const chainTimeout = profile.timeout_ms || req.timeoutMs || 30_000;
  const attempts = [];

  for (const route of chain) {
    const selectedRoute = _normalizeRoute(route, req.abstractModel);
    const result = await _callRoute(route, req, chainTimeout);
    if (result.ok) {
      if (req.cacheEnabled && result.result) _saveCache(req, result).catch(() => {});
      return {
        ...result,
        provider: _routeToProvider(selectedRoute),
        selected_route: selectedRoute,
        fallbackCount: attempts.length,
        attempted_providers: attempts.map(a => a.provider),
      };
    }
    attempts.push({ provider: selectedRoute, error: result.error || 'unknown', durationMs: result.durationMs });
    console.warn(`[llm/unified] ${selectedRoute} 실패 (${result.error}) → 다음 시도`);
  }

  if (!_shouldSuppressFallbackExhaustionAlarm(req, null)) {
    await _notifyFallbackExhaustion(req, attempts, team);
  }
  return {
    ok: false, provider: 'failed',
    durationMs: attempts.reduce((s, a) => s + a.durationMs, 0),
    error: `fallback_exhausted: ${(attempts[attempts.length - 1] || {}).error || 'unknown'}`,
    attempted_providers: attempts.map(a => a.provider),
    fallbackCount: attempts.length,
  };
}

async function _callLegacy(req, _team) {
  const ccModel = CLAUDE_CODE_MODEL[req.abstractModel] || 'haiku';
  const groqModel = _groqModel()[req.abstractModel] || getGroqFallback('anthropic_haiku');

  const primary = await callClaudeCodeOAuth({
    prompt: req.prompt,
    model: ccModel,
    systemPrompt: req.systemPrompt,
    jsonSchema: req.jsonSchema,
    timeoutMs: resolveClaudeCodeTimeoutMs(req.timeoutMs, ccModel),
    maxBudgetUsd: resolveClaudeCodeMaxBudgetUsd(req.maxBudgetUsd, ccModel),
  });
  if (primary.ok) {
    if (req.cacheEnabled && primary.result) _saveCache(req, primary).catch(() => {});
    return { ...primary, provider: 'claude-code-oauth', cacheHit: false };
  }

  console.warn(`[llm/unified] Primary 실패: ${primary.error} → Groq 폴백 (${groqModel})`);
  const fallback = await callGroqFallback({ prompt: req.prompt, model: groqModel, systemPrompt: req.systemPrompt });
  return { ...fallback, provider: fallback.ok ? 'groq' : 'failed', primaryError: primary.error, fallbackCount: 1, cacheHit: false };
}

async function _callRoute(route, req, timeoutMs, chainEntry = {}) {
  const normalizedRoute = _normalizeRoute(route, req.abstractModel);
  const provider = _routeToProvider(normalizedRoute);
  const circuitKey = _providerCircuitKey(provider, normalizedRoute);
  const started = Date.now();

  if (_isGeminiProvider(provider) && isGeminiDisabled()) {
    return { ok: false, provider: 'failed', error: 'gemini_provider_disabled', durationMs: 0 };
  }

  if (_providerCircuitEnabled(provider) && !providerRegistry.canCall(circuitKey)) {
    return {
      ok: false,
      provider: 'failed',
      durationMs: 0,
      error: `provider_circuit_open:${circuitKey}`,
    };
  }

  const result = await _callRouteUnchecked(normalizedRoute, req, timeoutMs, chainEntry);
  const latencyMs = Number(result.durationMs || 0) || (Date.now() - started);
  if (_providerCircuitEnabled(provider)) {
    if (result.ok) {
      providerRegistry.recordSuccess(circuitKey, latencyMs);
    } else {
      providerRegistry.recordFailure(circuitKey, result.error || 'provider_failed', latencyMs);
    }
  }
  return result;
}

async function _callRouteUnchecked(normalizedRoute, req, timeoutMs, chainEntry = {}) {

  if (normalizedRoute.startsWith('claude-code/')) {
    const model = normalizedRoute.split('/')[1];
    return callClaudeCodeOAuth({
      prompt: req.prompt,
      model,
      systemPrompt: req.systemPrompt,
      jsonSchema: req.jsonSchema,
      timeoutMs: resolveClaudeCodeTimeoutMs(timeoutMs, model),
      maxBudgetUsd: resolveClaudeCodeMaxBudgetUsd(req.maxBudgetUsd, model),
    });
  }
  if (normalizedRoute.startsWith('groq/')) {
    const model = normalizedRoute.slice('groq/'.length);
    return callGroqFallback({
      prompt: req.prompt,
      model,
      systemPrompt: req.systemPrompt,
      jsonSchema: req.jsonSchema,
      jsonSchemaName: chainEntry.jsonSchemaName,
      strictJsonSchema: chainEntry.strictJsonSchema,
      responseFormat: chainEntry.responseFormat,
      reasoningEffort: chainEntry.reasoningEffort,
      reasoningFormat: chainEntry.reasoningFormat,
      includeReasoning: chainEntry.includeReasoning,
      seed: chainEntry.seed,
      serviceTier: chainEntry.serviceTier,
      maxTokens: chainEntry.maxTokens,
      temperature: chainEntry.temperature,
    });
  }
  if (normalizedRoute.startsWith('local/')) {
    const model = normalizedRoute.slice('local/'.length);
    return callLocalOllama({ prompt: req.prompt, model, systemPrompt: req.systemPrompt, timeoutMs });
  }
  if (normalizedRoute.startsWith('local-embedding/')) {
    const model = normalizedRoute.slice('local-embedding/'.length);
    return _callLocalEmbeddingOnly(req, model);
  }
  if (normalizedRoute.startsWith('openai-oauth/')) {
    return _callOpenAiCodexOAuthWithRetry({
      prompt: req.prompt,
      model: normalizedRoute.slice('openai-oauth/'.length),
      systemPrompt: req.systemPrompt,
      maxTokens: chainEntry.maxTokens,
      temperature: chainEntry.temperature,
      timeoutMs,
      retryAttempts: chainEntry.retryAttempts,
    });
  }
  if (normalizedRoute.startsWith('gemini-oauth/')
    || normalizedRoute.startsWith('gemini-cli-oauth/')
    || normalizedRoute.startsWith('gemini-codeassist-oauth/')) {
    if (_isGeminiProvider(_routeToProvider(normalizedRoute)) && isGeminiDisabled()) {
      return { ok: false, provider: 'failed', error: 'gemini_provider_disabled', durationMs: 0 };
    }
    if (normalizedRoute.startsWith('gemini-codeassist-oauth/')) {
      return callGeminiCodeAssistOAuth({
        prompt: req.prompt,
        model: normalizedRoute.slice('gemini-codeassist-oauth/'.length),
        systemPrompt: req.systemPrompt,
        maxTokens: chainEntry.maxTokens,
        temperature: chainEntry.temperature,
        timeoutMs,
      });
    }
    return callGeminiCliOAuth({
      prompt: req.prompt,
      model: normalizedRoute.startsWith('gemini-oauth/')
        ? normalizedRoute.slice('gemini-oauth/'.length)
        : normalizedRoute.slice('gemini-cli-oauth/'.length),
      systemPrompt: req.systemPrompt,
      maxTokens: chainEntry.maxTokens,
      temperature: chainEntry.temperature,
      timeoutMs,
    });
  }
  return { ok: false, provider: 'failed', error: `unsupported_provider:${normalizedRoute}`, durationMs: 0 };
}

async function _callOpenAiCodexOAuthWithRetry(input) {
  const started = Date.now();
  const retryAttempts = input?.retryAttempts == null
    ? _openAiOAuthRetryAttempts()
    : _boundedIntegerValue(input.retryAttempts, DEFAULT_OPENAI_OAUTH_RETRY_ATTEMPTS, 0, MAX_OPENAI_OAUTH_RETRY_ATTEMPTS);
  const retryErrors = [];

  for (let attempt = 0; ; attempt += 1) {
    const result = await callOpenAiCodexOAuth(input);
    if (result.ok) {
      return {
        ...result,
        durationMs: Date.now() - started,
        retryCount: attempt,
        retryErrors: retryErrors.length ? retryErrors : undefined,
      };
    }

    const error = String(result.error || 'provider_failed');
    const shouldRetry = attempt < retryAttempts && _isRetryableOpenAiOAuthError(error);
    if (!shouldRetry) {
      return {
        ...result,
        durationMs: Date.now() - started,
        retryCount: attempt,
        retryErrors: retryErrors.length ? retryErrors.concat(error) : undefined,
      };
    }

    retryErrors.push(error);
    console.warn(`[llm/unified] OpenAI OAuth 일시 오류 (${error}) → 재시도 ${attempt + 1}/${retryAttempts}`);
    await _sleep(_openAiOAuthRetryDelayMs(attempt));
  }
}

function _isRetryableOpenAiOAuthError(error) {
  return /openai_codex_oauth_timeout_or_abort/i.test(String(error || ''));
}

function _openAiOAuthRetryAttempts() {
  return _boundedIntegerEnv(
    'HUB_OPENAI_OAUTH_RETRY_ATTEMPTS',
    DEFAULT_OPENAI_OAUTH_RETRY_ATTEMPTS,
    0,
    MAX_OPENAI_OAUTH_RETRY_ATTEMPTS,
  );
}

function _openAiOAuthRetryDelayMs(attempt) {
  const baseDelayMs = _boundedIntegerEnv(
    'HUB_OPENAI_OAUTH_RETRY_DELAY_MS',
    DEFAULT_OPENAI_OAUTH_RETRY_DELAY_MS,
    0,
    30_000,
  );
  return baseDelayMs * Math.max(1, Number(attempt || 0) + 1);
}

function _sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function _callLocalEmbeddingOnly(req, model) {
  const started = Date.now();
  try {
    const text = String(req.prompt || req.systemPrompt || 'backtest').slice(0, 8000);
    const embeddings = await rag.createEmbeddingBatch([text]);
    const vector = embeddings?.[0] || [];
    const dimensions = Array.isArray(vector) ? vector.length : 0;
    const digest = crypto.createHash('sha256')
      .update(JSON.stringify(Array.isArray(vector) ? vector.slice(0, 16) : []))
      .digest('hex')
      .slice(0, 16);
    return {
      ok: true,
      provider: 'local-embedding',
      result: JSON.stringify({ mode: 'embedding_only', model, dimensions, embedding_hash: digest }),
      durationMs: Date.now() - started,
      modelUsage: { [model]: { input_texts: 1, dimensions } },
      embeddingOnly: true,
    };
  } catch (error) {
    return {
      ok: false,
      provider: 'failed',
      error: `local_embedding_failed:${error?.message || error}`,
      durationMs: Date.now() - started,
    };
  }
}

function _isGeminiProvider(provider) {
  return provider === 'gemini-oauth'
    || provider === 'gemini-cli-oauth'
    || provider === 'gemini-codeassist-oauth'
    || provider === 'gemini';
}

function _providerCircuitEnabled(provider) {
  if (process.env.HUB_LLM_PROVIDER_CIRCUIT_ENABLED === 'false') return false;
  return Boolean(provider && provider !== 'failed');
}

function _providerCircuitKey(provider, normalizedRoute) {
  if (provider === 'groq' && String(normalizedRoute || '').startsWith('groq/')) {
    return String(normalizedRoute);
  }
  return provider;
}

function _chainEntryToRoute(entry) {
  const provider = String(entry?.provider || '').trim();
  const model = String(entry?.model || '').trim();
  if (!provider || !model) return model || provider;
  if (provider === 'anthropic') {
    const family = model.includes('haiku') ? 'haiku' : model.includes('opus') ? 'opus' : 'sonnet';
    return `claude-code/${family}`;
  }
  if (provider === 'claude-code') return model.startsWith('claude-code/') ? model : `claude-code/${model}`;
  if (provider === 'groq') return model.startsWith('groq/') ? model : `groq/${model}`;
  if (provider === 'local-embedding') return model.startsWith('local-embedding/') ? model : `local-embedding/${model}`;
  if (provider === 'openai-oauth') return model.startsWith('openai-oauth/') ? model : `openai-oauth/${model}`;
  if (provider === 'openai') {
    const normalizedModel = model.replace(/^openai\//, '').replace(/^openai-oauth\//, '');
    return `openai-oauth/${normalizedModel}`;
  }
  if (provider === 'gemini-oauth') {
    return model.startsWith('gemini-cli-oauth/')
      ? model
      : `gemini-cli-oauth/${model.replace(/^google-gemini-cli\//, '').replace(/^gemini-oauth\//, '').replace(/^gemini\//, '')}`;
  }
  if (provider === 'gemini-cli-oauth') {
    return model.startsWith('gemini-cli-oauth/')
      ? model
      : `gemini-cli-oauth/${model.replace(/^google-gemini-cli\//, '').replace(/^gemini-oauth\//, '').replace(/^gemini\//, '')}`;
  }
  if (provider === 'gemini-codeassist-oauth' || provider === 'gemini-code-assist-oauth') {
    return model.startsWith('gemini-codeassist-oauth/')
      ? model
      : `gemini-codeassist-oauth/${model.replace(/^gemini-code-assist-oauth\//, '').replace(/^gemini-oauth\//, '')}`;
  }
  if (provider === 'gemini') {
    const normalizedModel = model
      .replace(/^google-gemini-cli\//, '')
      .replace(/^gemini\//, '')
      .replace(/^gemini-oauth\//, '');
    return `gemini-cli-oauth/${normalizedModel}`;
  }
  return model.includes('/') ? model : `${provider}/${model}`;
}

function _isProviderSupported(route) {
  return route.startsWith('claude-code/')
    || route.startsWith('groq/')
    || route.startsWith('local-embedding/')
    || route.startsWith('local/')
    || route.startsWith('openai-oauth/')
    || route.startsWith('openai/')
    || route.startsWith('gemini-codeassist-oauth/')
    || route.startsWith('gemini-code-assist-oauth/')
    || route.startsWith('gemini-cli-oauth/')
    || route.startsWith('gemini-oauth/')
    || route.startsWith('google-gemini-cli/')
    || route.startsWith('gemini/');
}

function _routeToProvider(route) {
  const normalizedRoute = _normalizeRoute(route);
  if (normalizedRoute.startsWith('claude-code/')) return 'claude-code-oauth';
  if (normalizedRoute.startsWith('groq/')) return 'groq';
  if (normalizedRoute.startsWith('local/')) return 'local';
  if (normalizedRoute.startsWith('local-embedding/')) return 'local-embedding';
  if (normalizedRoute.startsWith('openai-oauth/')) return 'openai-oauth';
  if (normalizedRoute.startsWith('openai/')) return 'openai-oauth';
  if (normalizedRoute.startsWith('gemini-codeassist-oauth/')) return 'gemini-codeassist-oauth';
  if (normalizedRoute.startsWith('gemini-cli-oauth/')) return 'gemini-cli-oauth';
  if (normalizedRoute.startsWith('gemini-oauth/')) return 'gemini-cli-oauth';
  if (normalizedRoute.startsWith('google-gemini-cli/') || normalizedRoute.startsWith('gemini/')) return 'gemini-cli-oauth';
  return route;
}

function _normalizeRoute(route, abstractModel = 'anthropic_haiku') {
  const sonnetReplacement = _claudeCodeSonnetReplacementRoute(route);
  if (sonnetReplacement) return sonnetReplacement;

  const staleGroqRoutes = new Set([
    'groq/llama-4-scout-17b-16e-instruct',
  ]);

  if (staleGroqRoutes.has(route)) {
    const replacement = 'groq/meta-llama/llama-4-scout-17b-16e-instruct';
    console.warn(`[llm/unified] stale groq route 정규화: ${route} -> ${replacement}`);
    return replacement;
  }

  if (route.startsWith('openai/')) {
    return `openai-oauth/${route.slice('openai/'.length)}`;
  }
  if (route.startsWith('google-gemini-cli/')) {
    return `gemini-cli-oauth/${route.slice('google-gemini-cli/'.length)}`;
  }
  if (route.startsWith('gemini-cli/')) {
    return `gemini-cli-oauth/${route.slice('gemini-cli/'.length)}`;
  }
  if (route.startsWith('gemini-code-assist-oauth/')) {
    return `gemini-codeassist-oauth/${route.slice('gemini-code-assist-oauth/'.length)}`;
  }
  if (route.startsWith('gemini/')) {
    return `gemini-cli-oauth/${route.slice('gemini/'.length)}`;
  }

  return route;
}

function _truthyEnv(name) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function _timeGateActive(name) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return false;
  const expiresAt = Date.parse(raw);
  return Number.isFinite(expiresAt) && Date.now() < expiresAt;
}

function _claudeCodeSonnetReplacementRoute(route) {
  const normalizedRoute = String(route || '').trim();
  if (!normalizedRoute.startsWith('claude-code/')) return null;
  const claudeCodeDisabled = _truthyEnv('LLM_CLAUDE_CODE_DISABLED') || _timeGateActive('LLM_CLAUDE_CODE_DISABLED_UNTIL');
  const sonnetDisabled = normalizedRoute === 'claude-code/sonnet'
    && (_truthyEnv('LLM_CLAUDE_CODE_SONNET_DISABLED') || _timeGateActive('LLM_FORCE_OPENAI_OAUTH_UNTIL'));
  if (!claudeCodeDisabled && !sonnetDisabled) return null;
  const replacement = String(process.env.LLM_CLAUDE_CODE_SONNET_REPLACEMENT || CLAUDE_CODE_SONNET_REPLACEMENT_ROUTE).trim();
  return replacement || CLAUDE_CODE_SONNET_REPLACEMENT_ROUTE;
}

function _flagDisabled(name) {
  return ['0', 'false', 'no', 'n', 'off'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function _positiveNumber(value, fallback = null) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
}

function _boundedIntegerEnv(name, fallback, min, max) {
  const raw = process.env[name];
  return _boundedIntegerValue(raw == null || raw === '' ? fallback : raw, fallback, min, max);
}

function _boundedIntegerValue(value, fallback, min, max) {
  const parsed = Number(value);
  const numeric = Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
  return Math.min(max, Math.max(min, numeric));
}

function _estimatedCostUsd(req) {
  const explicit = _positiveNumber(req?.estimatedCostUsd ?? req?.estimated_cost_usd, null);
  if (explicit !== null) return explicit;
  return _positiveNumber(process.env.HUB_LLM_DEFAULT_ESTIMATED_COST_USD, 0.01);
}

function _claudeCodeFamily(model) {
  const value = String(model || '').toLowerCase();
  if (value.includes('opus')) return 'opus';
  if (value.includes('haiku')) return 'haiku';
  return 'sonnet';
}

function _claudeCodeTimeoutFloorMs(model) {
  const family = _claudeCodeFamily(model);
  const envSpecific = process.env[`HUB_CLAUDE_CODE_${family.toUpperCase()}_TIMEOUT_MS`];
  return _positiveNumber(
    envSpecific,
    _positiveNumber(
      process.env.HUB_CLAUDE_CODE_TIMEOUT_MS || process.env.CLAUDE_CODE_TIMEOUT_MS,
      DEFAULT_CLAUDE_CODE_TIMEOUT_MS,
    ),
  );
}

function _claudeCodeBudgetFloorUsd(model) {
  const family = _claudeCodeFamily(model);
  const envSpecific = process.env[`HUB_CLAUDE_CODE_${family.toUpperCase()}_MIN_BUDGET_USD`];
  return _positiveNumber(
    envSpecific,
    _positiveNumber(
      process.env.HUB_CLAUDE_CODE_MIN_BUDGET_USD,
      CLAUDE_CODE_BUDGET_FLOORS_USD[family],
    ),
  );
}

function resolveClaudeCodeTimeoutMs(requestedTimeoutMs, model = 'sonnet') {
  const requested = _positiveNumber(requestedTimeoutMs, null);
  const floor = _claudeCodeTimeoutFloorMs(model);
  return Math.max(requested || floor, floor);
}

function resolveClaudeCodeMaxBudgetUsd(requestedBudgetUsd, model = 'sonnet') {
  if (_flagDisabled('HUB_CLAUDE_CODE_BUDGET_FLOOR_ENABLED')) return requestedBudgetUsd;
  const requested = _positiveNumber(requestedBudgetUsd, null);
  if (requested === null) return requestedBudgetUsd;
  return Math.max(requested, _claudeCodeBudgetFloorUsd(model));
}

async function _saveCache(req, resp) {
  try {
    const cacheKey = _cacheKey(req);
    const tokensIn = (resp.modelUsage && resp.modelUsage.input_tokens) || 0;
    const tokensOut = (resp.modelUsage && resp.modelUsage.output_tokens) || 0;
    await saveCache(cacheKey, resp.result, { in: tokensIn, out: tokensOut }, resp.totalCostUsd || 0, req.cacheType || 'default');
  } catch {}
}

function _cacheKey(req) {
  return {
    abstractModel: req.abstractModel,
    callerTeam: req.callerTeam || 'hub',
    agent: req.agent || null,
    taskType: req.taskType || null,
    selectorKey: req.selectorKey || null,
    prompt: req.prompt,
    systemPrompt: req.systemPrompt,
    jsonSchema: req.jsonSchema || null,
    maxTokens: req.maxTokens ?? null,
    temperature: req.temperature ?? null,
  };
}

function _shouldSuppressFallbackExhaustionAlarm(req, selectorChain) {
  if (req?.suppressFallbackExhaustionAlarm === true) return true;
  const selectorKey = String(req?.selectorKey || selectorChain?.selectorKey || '').trim().toLowerCase();
  const callerTeam = String(req?.callerTeam || '').trim().toLowerCase();
  const agent = String(req?.agent || '').trim().toLowerCase();
  if (selectorKey === 'elsa.chat.answer' || (callerTeam === 'elsa' && ['chat', 'rag', 'vision', 'voice'].includes(agent))) return true;
  if (selectorKey === 'hub.alarm.classifier' || selectorKey.startsWith('hub.alarm.interpreter.')) return true;
  if (selectorKey.startsWith('hub.') && (selectorKey.endsWith('.smoke') || selectorKey.includes('.smoke.'))) return true;
  if (selectorKey.startsWith('hub.') && (selectorKey.includes('.probe') || selectorKey.includes('expiry_probe'))) return true;
  return false;
}

function _safeFallbackForSelectorExhaustion(req, selectorChain, attempts, team) {
  if (_flagDisabled('HUB_ELSA_CHAT_SAFE_FALLBACK_ENABLED')) return null;
  const selectorKey = String(req?.selectorKey || selectorChain?.selectorKey || '').trim().toLowerCase();
  const callerTeam = String(req?.callerTeam || team || '').trim().toLowerCase();
  const agent = String(req?.agent || '').trim().toLowerCase();
  const isElsaChat = selectorKey === 'elsa.chat.answer' || (callerTeam === 'elsa' && ['chat', 'rag', 'vision', 'voice'].includes(agent));
  if (!isElsaChat) return null;
  if (req?.jsonSchema) return null;

  const lastErr = (attempts[attempts.length - 1] || {}).error || 'unknown';
  return {
    ok: true,
    provider: 'safe-fallback',
    selected_route: 'safe-fallback/elsa-chat-answer',
    result: '현재 답변 생성 경로가 일시적으로 불안정합니다. 요청은 접수되었고, 잠시 후 다시 시도해 주세요.',
    durationMs: attempts.reduce((sum, attempt) => sum + Number(attempt.durationMs || 0), 0),
    degraded: true,
    safeFallback: true,
    degradedReason: 'selector_chain_exhausted',
    suppressedError: `fallback_exhausted: ${lastErr}`,
    fallbackExhaustionSuppressed: true,
    attempted_providers: attempts.map((attempt) => attempt.provider),
    avoidedProviders: selectorChain?.avoidedProviders || [],
    fallbackCount: attempts.length,
    selectorKey: selectorChain?.selectorKey || req?.selectorKey || null,
    runtimeProfile: selectorChain?.runtimeProfile || null,
    runtimePurpose: selectorChain?.runtimePurpose || null,
    routeTargetKind: selectorChain?.routeTargetKind || selectorChain?.target?.kind || null,
    providerTiers: selectorChain?.providerTiers || [],
    estimatedCostUsd: req?._estimatedCostUsd || null,
    budgetGuardStatus: req?._budgetGuardStatus || null,
  };
}

async function _notifyFallbackExhaustion(req, attempts, team) {
  const tried = attempts.map(a => a.provider).join(' → ');
  const lastErr = (attempts[attempts.length - 1] || {}).error || 'unknown';
  const msg = `🚨 Fallback Exhaustion\n팀: ${team} / 에이전트: ${req.agent || 'default'}\n시도: ${tried}\n최종 에러: ${lastErr}`;
  console.error('[llm/unified]', msg);
  await sender.sendCritical('general', msg).catch(() => {});
}

module.exports = {
  callWithFallback,
  resolveClaudeCodeTimeoutMs,
  resolveClaudeCodeMaxBudgetUsd,
  _testOnly: {
    _inflightDedupeKey,
    _runWithInflightDedupe,
    _inflightDedupeSize: () => inFlightDedupe.size,
    _normalizeRoute,
    _isGeminiProvider,
    _providerCircuitKey,
    _resolveSelectorChain,
    _adhocChainAllowed,
    _callOpenAiCodexOAuthWithRetry,
    _isRetryableOpenAiOAuthError,
    _openAiOAuthRetryAttempts,
    _openAiOAuthRetryDelayMs,
    _shouldSuppressFallbackExhaustionAlarm,
    _safeFallbackForSelectorExhaustion,
  },
};
