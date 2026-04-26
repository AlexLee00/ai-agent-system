'use strict';

// Unified LLM Caller — Runtime-profile chain + Circuit Breaker + Fallback Exhaustion
// Priority: claude-code/ → groq/ → local/ (based on team/agent profile)
// Legacy (no team/agent): Claude Code → Groq 2-step

const { callClaudeCodeOAuth } = require('./claude-code-oauth');
const { callGroqFallback } = require('./groq-fallback');
const { callLocalOllama } = require('./local-ollama');
const { checkCache, saveCache } = require('./cache');
const { selectRuntimeProfile } = require('../runtime-profiles');
const { getGroqFallback } = require('../../../../packages/core/lib/llm-models');
const { callWithFallback: callCoreWithFallback } = require('../../../../packages/core/lib/llm-fallback');
const { describeAgentModel, selectLLMChain } = require('../../../../packages/core/lib/llm-model-selector');
const sender = require('../../../../packages/core/lib/telegram-sender');

const CLAUDE_CODE_MODEL = {
  anthropic_haiku: 'haiku',
  anthropic_sonnet: 'sonnet',
  anthropic_opus: 'opus',
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
  const team = req.callerTeam || 'worker';

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

  const primary = await callClaudeCodeOAuth({ prompt: req.prompt, model: ccModel, systemPrompt: req.systemPrompt, jsonSchema: req.jsonSchema, timeoutMs: req.timeoutMs, maxBudgetUsd: req.maxBudgetUsd });
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

  if (normalizedRoute.startsWith('claude-code/')) {
    const model = normalizedRoute.split('/')[1];
    return callClaudeCodeOAuth({ prompt: req.prompt, model, systemPrompt: req.systemPrompt, jsonSchema: req.jsonSchema, timeoutMs, maxBudgetUsd: req.maxBudgetUsd });
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
  if (
    normalizedRoute.startsWith('openai-oauth/')
    || normalizedRoute.startsWith('openai/')
    || normalizedRoute.startsWith('google-gemini-cli/')
    || normalizedRoute.startsWith('gemini/')
  ) {
    return _callViaCoreFallback(normalizedRoute, req, timeoutMs, chainEntry);
  }
  return { ok: false, provider: 'failed', error: `unsupported_provider:${route}`, durationMs: 0 };
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
  if (provider === 'openai') return model.startsWith('openai/') ? model : `openai/${model}`;
  if (provider === 'gemini') return model.startsWith('google-gemini-cli/') || model.startsWith('gemini/') ? model : `gemini/${model}`;
  return model.includes('/') ? model : `${provider}/${model}`;
}

function _isProviderSupported(route) {
  return route.startsWith('claude-code/')
    || route.startsWith('groq/')
    || route.startsWith('local/')
    || route.startsWith('openai-oauth/')
    || route.startsWith('openai/')
    || route.startsWith('google-gemini-cli/')
    || route.startsWith('gemini/');
}

function _routeToProvider(route) {
  const normalizedRoute = _normalizeRoute(route);
  if (normalizedRoute.startsWith('claude-code/')) return 'claude-code-oauth';
  if (normalizedRoute.startsWith('groq/')) return 'groq';
  if (normalizedRoute.startsWith('openai-oauth/')) return 'openai-oauth';
  if (normalizedRoute.startsWith('openai/')) return 'openai';
  if (normalizedRoute.startsWith('google-gemini-cli/') || normalizedRoute.startsWith('gemini/')) return 'gemini';
  return route;
}

function _normalizeRoute(route, abstractModel = 'anthropic_sonnet') {
  const staleGroqRoutes = new Set([
    'groq/llama-4-scout-17b-16e-instruct',
    'groq/meta-llama/llama-4-scout-17b-16e-instruct',
    'groq/qwen/qwen3-32b',
  ]);

  if (staleGroqRoutes.has(route)) {
    const replacement = `groq/${getGroqFallback(abstractModel)}`;
    console.warn(`[llm/unified] stale groq route 정규화: ${route} -> ${replacement}`);
    return replacement;
  }

  return route;
}

async function _callViaCoreFallback(route, req, timeoutMs, chainEntry = {}) {
  const provider = _routeToProvider(route);
  const model = route.startsWith('gemini/') ? route.slice('gemini/'.length) : route;
  const started = Date.now();

  try {
    const result = await callCoreWithFallback({
      chain: [{
        provider,
        model,
        maxTokens: chainEntry.maxTokens || 1024,
        temperature: chainEntry.temperature ?? 0.3,
        timeoutMs,
      }],
      systemPrompt: req.systemPrompt || '',
      userPrompt: req.prompt,
      timeoutMs,
      team: req.callerTeam || 'worker',
      purpose: req.taskType || 'default',
      logMeta: {
        team: req.callerTeam || 'worker',
        bot: req.agent || 'hub-unified',
        requestType: req.taskType || 'hub_call',
        selectorKey: req.agent || 'hub-unified',
        purpose: req.taskType || 'default',
      },
    });

    return {
      ok: true,
      provider,
      result: result.text,
      durationMs: Date.now() - started,
      apiDurationMs: Date.now() - started,
      cacheHit: false,
    };
  } catch (e) {
    return {
      ok: false,
      provider: 'failed',
      durationMs: Date.now() - started,
      error: e && e.message ? e.message : `provider_failed:${route}`,
    };
  }
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

module.exports = { callWithFallback };
