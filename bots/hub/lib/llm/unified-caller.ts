'use strict';

// Unified LLM Caller — Runtime-profile chain + Circuit Breaker + Fallback Exhaustion
// Priority: claude-code/ → groq/ → local/ (based on team/agent profile)
// Legacy (no team/agent): Claude Code → Groq 2-step

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
const { selectRuntimeProfile } = require('../runtime-profiles');
const { getGroqFallback } = require('../../../../packages/core/lib/llm-models');
const { describeAgentModel, selectLLMChain } = require('../../../../packages/core/lib/llm-model-selector');
const providerRegistry = require('./provider-registry');
const sender = require('../../../../packages/core/lib/telegram-sender');

const CLAUDE_CODE_MODEL = {
  anthropic_haiku: 'haiku',
  anthropic_sonnet: 'sonnet',
  anthropic_opus: 'opus',
};

const DEFAULT_CLAUDE_CODE_TIMEOUT_MS = 90_000;
const CLAUDE_CODE_BUDGET_FLOORS_USD = {
  haiku: 0.05,
  sonnet: 0.2,
  opus: 0.5,
};

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
  const team = req.callerTeam || 'hub';

  // 0. Budget check
  if (process.env.HUB_BUDGET_GUARDIAN_ENABLED !== 'false') {
    try {
      const { BudgetGuardian } = require('../budget-guardian');
      const budgetCheck = BudgetGuardian.getInstance().checkAndReserve(team, 0.01);
      if (!budgetCheck.ok) {
        console.warn(`[llm/unified] 예산 차단 (${team}): ${budgetCheck.reason}`);
        return { ok: false, provider: 'failed', error: `budget_exceeded: ${budgetCheck.reason}`, durationMs: 0 };
      }
    } catch (e) {
      console.warn('[llm/unified] BudgetGuardian 오류 (무시):', e.message);
    }
  }

  // 1. Cache check
  if (req.cacheEnabled) {
    try {
      const cacheKey = { abstractModel: req.abstractModel, prompt: req.prompt, systemPrompt: req.systemPrompt };
      const cached = await checkCache(cacheKey);
      if (cached.hit) {
        console.log(`[llm/unified] 캐시 히트 (${req.abstractModel})`);
        return { ok: true, provider: 'claude-code-oauth', result: cached.response, durationMs: 0, totalCostUsd: 0, cacheHit: true, cachedAt: cached.cachedAt };
      }
    } catch (e) {
      console.warn('[llm/unified] 캐시 조회 오류 (무시):', e.message);
    }
  }

  // 2. Build chain from the Hub selector registry, runtime-profiles, or legacy 2-step.
  const selectorChain = _resolveSelectorChain(req, team);
  if (selectorChain) {
    return _callWithSelectorChain(req, selectorChain, team);
  }

  const profile = req.agent ? selectRuntimeProfile(team, req.agent) : null;
  const hasChain = !!(profile && ((profile.primary_routes && profile.primary_routes.length) || (profile.fallback_routes && profile.fallback_routes.length)));

  if (hasChain) {
    return _callWithProfileChain(req, profile, team);
  }
  return _callLegacy(req, team);
}

function _resolveSelectorChain(req, team) {
  try {
    if (Array.isArray(req.chain) && req.chain.length > 0) {
      return { selectorKey: req.selectorKey || 'hub.adhoc.chain', chain: req.chain };
    }
    if (req.selectorKey) {
      const chain = selectLLMChain(String(req.selectorKey), {
        maxTokens: req.maxTokens,
        agentName: req.agent,
        preferredApi: req.preferredApi,
        groqModel: req.groqModel,
        configuredProviders: req.configuredProviders,
      });
      return chain && chain.length ? { selectorKey: String(req.selectorKey), chain } : null;
    }
    if (req.agent) {
      const resolved = describeAgentModel(team, String(req.agent));
      if (resolved?.selected && Array.isArray(resolved.chain) && resolved.chain.length > 0) {
        return { selectorKey: resolved.selectorKey, chain: resolved.chain };
      }
    }
  } catch (e) {
    console.warn(`[llm/unified] selector chain 해석 실패 (${team}/${req.agent || req.selectorKey || 'unknown'}): ${e.message}`);
  }
  return null;
}

async function _callWithSelectorChain(req, selectorChain, team) {
  const chainTimeout = req.timeoutMs || 30_000;
  const attempts = [];

  for (const entry of selectorChain.chain) {
    const route = _chainEntryToRoute(entry);
    const result = await _callRoute(route, req, entry.timeoutMs || chainTimeout, entry);
    if (result.ok) {
      if (req.cacheEnabled && result.result) _saveCache(req, result).catch(() => {});
      return {
        ...result,
        provider: _routeToProvider(route),
        selected_route: route,
        selectorKey: selectorChain.selectorKey,
        fallbackCount: attempts.length,
        attempted_providers: attempts.map(a => a.provider),
      };
    }
    attempts.push({ provider: route, error: result.error || 'unknown', durationMs: result.durationMs });
    console.warn(`[llm/unified] ${selectorChain.selectorKey}:${route} 실패 (${result.error}) → 다음 시도`);
  }

  await _notifyFallbackExhaustion(req, attempts, team);
  return {
    ok: false,
    provider: 'failed',
    durationMs: attempts.reduce((s, a) => s + a.durationMs, 0),
    error: `fallback_exhausted: ${(attempts[attempts.length - 1] || {}).error || 'unknown'}`,
    attempted_providers: attempts.map(a => a.provider),
    fallbackCount: attempts.length,
    selectorKey: selectorChain.selectorKey,
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
    const result = await _callRoute(route, req, chainTimeout);
    if (result.ok) {
      if (req.cacheEnabled && result.result) _saveCache(req, result).catch(() => {});
      return { ...result, provider: _routeToProvider(route), fallbackCount: attempts.length, attempted_providers: attempts.map(a => a.provider) };
    }
    attempts.push({ provider: route, error: result.error || 'unknown', durationMs: result.durationMs });
    console.warn(`[llm/unified] ${route} 실패 (${result.error}) → 다음 시도`);
  }

  await _notifyFallbackExhaustion(req, attempts, team);
  return {
    ok: false, provider: 'failed',
    durationMs: attempts.reduce((s, a) => s + a.durationMs, 0),
    error: `fallback_exhausted: ${(attempts[attempts.length - 1] || {}).error || 'unknown'}`,
    attempted_providers: attempts.map(a => a.provider),
    fallbackCount: attempts.length,
  };
}

async function _callLegacy(req, _team) {
  const ccModel = CLAUDE_CODE_MODEL[req.abstractModel] || 'sonnet';
  const groqModel = _groqModel()[req.abstractModel] || 'llama-3.3-70b-versatile';

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
  const started = Date.now();

  if (_providerCircuitEnabled(provider) && !providerRegistry.canCall(provider)) {
    return {
      ok: false,
      provider: 'failed',
      durationMs: 0,
      error: `provider_circuit_open:${provider}`,
    };
  }

  const result = await _callRouteUnchecked(normalizedRoute, req, timeoutMs, chainEntry);
  const latencyMs = Number(result.durationMs || 0) || (Date.now() - started);
  if (_providerCircuitEnabled(provider)) {
    if (result.ok) {
      providerRegistry.recordSuccess(provider, latencyMs);
    } else {
      providerRegistry.recordFailure(provider, result.error || 'provider_failed', latencyMs);
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
      maxTokens: chainEntry.maxTokens,
      temperature: chainEntry.temperature,
    });
  }
  if (normalizedRoute.startsWith('local/')) {
    const model = normalizedRoute.slice('local/'.length);
    return callLocalOllama({ prompt: req.prompt, model, systemPrompt: req.systemPrompt, timeoutMs });
  }
  if (normalizedRoute.startsWith('openai-oauth/')) {
    return callOpenAiCodexOAuth({
      prompt: req.prompt,
      model: normalizedRoute.slice('openai-oauth/'.length),
      systemPrompt: req.systemPrompt,
      maxTokens: chainEntry.maxTokens,
      temperature: chainEntry.temperature,
      timeoutMs,
    });
  }
  if (normalizedRoute.startsWith('gemini-oauth/')) {
    return callGeminiOAuth({
      prompt: req.prompt,
      model: normalizedRoute.slice('gemini-oauth/'.length),
      systemPrompt: req.systemPrompt,
      maxTokens: chainEntry.maxTokens,
      temperature: chainEntry.temperature,
      timeoutMs,
    });
  }
  if (normalizedRoute.startsWith('gemini-cli-oauth/')) {
    return callGeminiCliOAuth({
      prompt: req.prompt,
      model: normalizedRoute.slice('gemini-cli-oauth/'.length),
      systemPrompt: req.systemPrompt,
      maxTokens: chainEntry.maxTokens,
      temperature: chainEntry.temperature,
      timeoutMs,
    });
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
  return { ok: false, provider: 'failed', error: `unsupported_provider:${normalizedRoute}`, durationMs: 0 };
}

function _providerCircuitEnabled(provider) {
  if (process.env.HUB_LLM_PROVIDER_CIRCUIT_ENABLED === 'false') return false;
  return Boolean(provider && provider !== 'failed');
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
  if (provider === 'openai-oauth') return model.startsWith('openai-oauth/') ? model : `openai-oauth/${model}`;
  if (provider === 'openai') {
    const normalizedModel = model.replace(/^openai\//, '').replace(/^openai-oauth\//, '');
    return `openai-oauth/${normalizedModel}`;
  }
  if (provider === 'gemini-oauth') return model.startsWith('gemini-oauth/') ? model : `gemini-oauth/${model}`;
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
    return `gemini-oauth/${normalizedModel}`;
  }
  return model.includes('/') ? model : `${provider}/${model}`;
}

function _isProviderSupported(route) {
  return route.startsWith('claude-code/')
    || route.startsWith('groq/')
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
  if (normalizedRoute.startsWith('openai-oauth/')) return 'openai-oauth';
  if (normalizedRoute.startsWith('openai/')) return 'openai-oauth';
  if (normalizedRoute.startsWith('gemini-codeassist-oauth/')) return 'gemini-codeassist-oauth';
  if (normalizedRoute.startsWith('gemini-cli-oauth/')) return 'gemini-cli-oauth';
  if (normalizedRoute.startsWith('gemini-oauth/')) return 'gemini-oauth';
  if (normalizedRoute.startsWith('google-gemini-cli/') || normalizedRoute.startsWith('gemini/')) return 'gemini-oauth';
  return route;
}

function _normalizeRoute(route, abstractModel = 'anthropic_sonnet') {
  const staleGroqRoutes = new Set([
    'groq/llama-4-scout-17b-16e-instruct',
    'groq/meta-llama/llama-4-scout-17b-16e-instruct',
  ]);

  if (staleGroqRoutes.has(route)) {
    const replacement = `groq/${getGroqFallback(abstractModel)}`;
    console.warn(`[llm/unified] stale groq route 정규화: ${route} -> ${replacement}`);
    return replacement;
  }

  if (route.startsWith('openai/')) {
    return `openai-oauth/${route.slice('openai/'.length)}`;
  }
  if (route.startsWith('google-gemini-cli/')) {
    return `gemini-oauth/${route.slice('google-gemini-cli/'.length)}`;
  }
  if (route.startsWith('gemini-cli/')) {
    return `gemini-cli-oauth/${route.slice('gemini-cli/'.length)}`;
  }
  if (route.startsWith('gemini-code-assist-oauth/')) {
    return `gemini-codeassist-oauth/${route.slice('gemini-code-assist-oauth/'.length)}`;
  }
  if (route.startsWith('gemini/')) {
    return `gemini-oauth/${route.slice('gemini/'.length)}`;
  }

  return route;
}

function _flagDisabled(name) {
  return ['0', 'false', 'no', 'n', 'off'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function _positiveNumber(value, fallback = null) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
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
    const cacheKey = { abstractModel: req.abstractModel, prompt: req.prompt, systemPrompt: req.systemPrompt };
    const tokensIn = (resp.modelUsage && resp.modelUsage.input_tokens) || 0;
    const tokensOut = (resp.modelUsage && resp.modelUsage.output_tokens) || 0;
    await saveCache(cacheKey, resp.result, { in: tokensIn, out: tokensOut }, resp.totalCostUsd || 0, req.cacheType || 'default');
  } catch {}
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
};
