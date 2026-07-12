#!/usr/bin/env node
// @ts-nocheck
'use strict';

const Module = require('node:module');

const mockState = {
  claudeCalls: [],
  openaiCalls: [],
  groqCalls: [],
  localCalls: [],
  budgetUsage: [],
  reset() {
    this.claudeCalls = [];
    this.openaiCalls = [];
    this.groqCalls = [];
    this.localCalls = [];
    this.budgetUsage = [];
  },
};

installRuntimeMocks();

const selector = require('../src/llm-selector.ts');
const unified = require('../lib/llm/unified-caller.ts');

const t = unified._testOnly;

function installMockModule(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  const mockModule = new Module(resolved, module);
  mockModule.filename = resolved;
  mockModule.loaded = true;
  mockModule.exports = exports;
  require.cache[resolved] = mockModule;
}

function installRuntimeMocks() {
  installMockModule('../../../packages/core/lib/token-budget.ts', {
    resolveTokenBudget: (req = {}) => ({
      ok: true,
      profile: { name: 'strict-repair-repro' },
      profileName: 'strict-repair-repro',
      callerTeam: req.callerTeam || 'blog',
      agent: req.agent || 'pos',
      taskType: req.taskType || 'lecture_post_repair',
      selectorKey: req.selectorKey || null,
      inputTokens: 64,
      maxOutputTokens: Math.min(Number(req.maxTokens || 256) || 256, 256),
      estimatedTotalTokens: 320,
      estimatedCostUsd: 0.001,
      budgetCostUsd: 1,
      timeoutMs: 120,
      perAttemptTimeoutMs: 120,
      fallbackAttempts: 3,
      promptHash: 'mock-prompt',
      requestFingerprint: 'mock-fingerprint',
    }),
    applyTokenBudgetToFallbackChain: (chain = [], budget = {}) => chain.slice(0, Math.max(1, budget.fallbackAttempts || 1)).map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      return {
        ...entry,
        maxTokens: Math.min(Number(entry.maxTokens || budget.maxOutputTokens || 256), Number(budget.maxOutputTokens || 256)),
        timeoutMs: Math.min(Number(entry.timeoutMs || budget.perAttemptTimeoutMs || 120), Number(budget.perAttemptTimeoutMs || 120)),
      };
    }),
    estimateCostUsd: () => 0.001,
    recordTokenBudgetUsage: async (entry) => {
      mockState.budgetUsage.push(entry);
    },
  });
  installMockModule('../../../packages/core/lib/telegram-sender.js', {
    sendCritical: async () => ({ ok: true, mocked: true }),
  });
  installMockModule('../lib/llm/claude-code-oauth.ts', {
    callClaudeCodeOAuth: async (req = {}) => {
      mockState.claudeCalls.push({ model: req.model || null, timeoutMs: req.timeoutMs || null });
      await sleep(80);
      return { ok: false, provider: 'failed', durationMs: 80, error: 'mock_sonnet_timeout' };
    },
  });
  installMockModule('../lib/llm/oauth-direct.ts', {
    callOpenAiCodexOAuth: async (req = {}) => {
      mockState.openaiCalls.push({ model: req.model || null, timeoutMs: req.timeoutMs || null });
      return { ok: true, provider: 'openai-oauth', result: 'mock openai fallback', durationMs: 5 };
    },
    callGeminiOAuth: async () => ({ ok: false, provider: 'failed', durationMs: 0, error: 'mock_gemini_not_expected' }),
    callGeminiCliOAuth: async () => ({ ok: false, provider: 'failed', durationMs: 0, error: 'mock_gemini_not_expected' }),
    callGeminiCodeAssistOAuth: async () => ({ ok: false, provider: 'failed', durationMs: 0, error: 'mock_gemini_not_expected' }),
  });
  installMockModule('../lib/llm/groq-fallback.ts', {
    callGroqFallback: async (req = {}) => {
      mockState.groqCalls.push({ model: req.model || null });
      return { ok: false, provider: 'failed', durationMs: 0, error: 'mock_groq_not_expected' };
    },
  });
  installMockModule('../lib/llm/local-ollama.ts', {
    callLocalOllama: async (req = {}) => {
      mockState.localCalls.push({ model: req.model || null });
      return { ok: false, provider: 'failed', durationMs: 0, error: 'mock_local_not_expected' };
    },
  });
}

function route(entry, abstractModel = 'anthropic_sonnet') {
  return t._normalizeRoute(chainEntryToRoute(entry), abstractModel);
}

function provider(entry, abstractModel = 'anthropic_sonnet') {
  return routeToProvider(route(entry, abstractModel));
}

function chainEntryToRoute(entry) {
  if (typeof entry === 'string') return entry;
  const rawProvider = String(entry?.provider || '').trim();
  const model = String(entry?.model || '').trim();
  if (!rawProvider || !model) return model || rawProvider;
  if (rawProvider === 'anthropic') return `claude-code/${model.includes('opus') ? 'opus' : model.includes('haiku') ? 'haiku' : 'sonnet'}`;
  if (rawProvider === 'claude-code') return model.startsWith('claude-code/') ? model : `claude-code/${model}`;
  if (rawProvider === 'openai-oauth') return model.startsWith('openai-oauth/') ? model : `openai-oauth/${model}`;
  if (rawProvider === 'openai') return `openai-oauth/${model.replace(/^openai\//, '').replace(/^openai-oauth\//, '')}`;
  if (rawProvider === 'groq') return model.startsWith('groq/') ? model : `groq/${model}`;
  if (rawProvider === 'local-embedding') return model.startsWith('local-embedding/') ? model : `local-embedding/${model}`;
  if (rawProvider === 'local') return model.startsWith('local/') ? model : `local/${model}`;
  if (rawProvider === 'gemini-cli-oauth') return model.startsWith('gemini-cli-oauth/') ? model : `gemini-cli-oauth/${model}`;
  if (rawProvider === 'gemini-codeassist-oauth') return model.startsWith('gemini-codeassist-oauth/') ? model : `gemini-codeassist-oauth/${model}`;
  return model.includes('/') ? model : `${rawProvider}/${model}`;
}

function routeToProvider(normalizedRoute) {
  if (normalizedRoute.startsWith('claude-code/')) return 'claude-code-oauth';
  if (normalizedRoute.startsWith('openai-oauth/') || normalizedRoute.startsWith('openai/')) return 'openai-oauth';
  if (normalizedRoute.startsWith('groq/')) return 'groq';
  if (normalizedRoute.startsWith('local-embedding/')) return 'local-embedding';
  if (normalizedRoute.startsWith('local/')) return 'local';
  if (normalizedRoute.startsWith('gemini-codeassist-oauth/')) return 'gemini-codeassist-oauth';
  if (normalizedRoute.startsWith('gemini-cli-oauth/') || normalizedRoute.startsWith('gemini-oauth/') || normalizedRoute.startsWith('gemini/')) return 'gemini-cli-oauth';
  return normalizedRoute;
}

function summarizeSelection(req) {
  const rawSelection = selector.resolveHubLlmSelection(req, { shadowDeps: { mode: 'off' } });
  const strictSelection = t._applyStrictProviderFamily(req, rawSelection);
  const resolvedSelection = t._resolveSelectorChain(req, req.callerTeam || 'hub');
  const budgetedChain = Array.isArray(resolvedSelection?.chain) ? resolvedSelection.chain : [];
  const resilience = t._buildResilienceFallbackPlan(budgetedChain, resolvedSelection || {}, req);
  return {
    taskType: req.taskType,
    selectorKey: resolvedSelection?.selectorKey || rawSelection?.selectorKey || req.selectorKey || null,
    reqStrictProviderFamily: req.strictProviderFamily || null,
    reqSnakeStrictProviderFamily: req.strict_provider_family || null,
    resolveSelectorChainCalled: true,
    rawError: rawSelection?.error || null,
    rawProviders: (rawSelection?.chain || []).map((entry) => provider(entry, req.abstractModel)),
    rawRoutes: (rawSelection?.chain || []).map((entry) => route(entry, req.abstractModel)),
    strictAppliedError: strictSelection?.error || null,
    strictAppliedProviderFamily: strictSelection?.strictProviderFamily || null,
    strictAppliedFilteredCount: strictSelection?.strictProviderFamilyFilteredCount || 0,
    strictAppliedProviders: (strictSelection?.chain || []).map((entry) => provider(entry, req.abstractModel)),
    strictAppliedRoutes: (strictSelection?.chain || []).map((entry) => route(entry, req.abstractModel)),
    selectionError: resolvedSelection?.error || null,
    selectionStrictProviderFamily: resolvedSelection?.strictProviderFamily || null,
    strictProviderFamilyFilteredCount: resolvedSelection?.strictProviderFamilyFilteredCount || 0,
    selectionProviders: budgetedChain.map((entry) => provider(entry, req.abstractModel)),
    selectionRoutes: budgetedChain.map((entry) => route(entry, req.abstractModel)),
    resilienceMode: resilience.mode,
    resilienceProviders: (resilience.chain || []).map((entry) => provider(entry, req.abstractModel)),
    resilienceRoutes: resilience.routes || [],
  };
}

function withLocalEnv(patch, fn) {
  const previous = {};
  for (const key of Object.keys(patch)) {
    previous[key] = process.env[key];
    if (patch[key] == null) delete process.env[key];
    else process.env[key] = patch[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(patch)) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

async function withLocalEnvAsync(patch, fn) {
  const previous = {};
  for (const key of Object.keys(patch)) {
    previous[key] = process.env[key];
    if (patch[key] == null) delete process.env[key];
    else process.env[key] = patch[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(patch)) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

async function runConcurrentDedupeScenarios(repairReq) {
  return withLocalEnvAsync({
    HUB_BUDGET_GUARDIAN_ENABLED: 'false',
    HUB_LLM_INFLIGHT_DEDUPE_ENABLED: 'true',
  }, async () => {
    t._clearRateLimitCooldowns?.();
    mockState.reset();
    const strictPairResponses = await Promise.all([
      unified.callWithFallback({ ...repairReq }),
      unified.callWithFallback({ ...repairReq }),
    ]);
    const strictPairCalls = summarizeMockCalls();

    t._clearRateLimitCooldowns?.();
    mockState.reset();
    const mixedResponses = await Promise.all([
      unified.callWithFallback({ ...repairReq, strictProviderFamily: undefined }),
      unified.callWithFallback({ ...repairReq }),
    ]);
    const mixedCalls = summarizeMockCalls();

    return {
      strictPair: {
        responses: strictPairResponses.map(summarizeResponse),
        calls: strictPairCalls,
        openAiLeak: strictPairResponses.some(responseLeaksOpenAi) || strictPairCalls.openai > 0,
      },
      mixedStrictVsUnrestricted: {
        responses: mixedResponses.map(summarizeResponse),
        calls: mixedCalls,
        strictResponseOpenAiLeak: responseLeaksOpenAi(mixedResponses[1]),
        unrestrictedResponseUsesOpenAi: responseLeaksOpenAi(mixedResponses[0]),
      },
    };
  });
}

function summarizeMockCalls() {
  return {
    claude: mockState.claudeCalls.length,
    openai: mockState.openaiCalls.length,
    groq: mockState.groqCalls.length,
    local: mockState.localCalls.length,
    budgetUsage: mockState.budgetUsage.length,
  };
}

function summarizeResponse(resp = {}) {
  return {
    ok: resp.ok === true,
    provider: resp.provider || null,
    routingLogProvider: resp.dedupeHit ? 'dedupe' : (resp.provider || null),
    dedupeHit: resp.dedupeHit === true,
    dedupeProvider: resp.dedupeProvider || null,
    selectedRoute: resp.selected_route || null,
    strictProviderFamily: resp.strictProviderFamily || null,
    fallbackCount: Number(resp.fallbackCount || 0),
    fallbackUsed: resp.fallbackUsed === true,
    attemptedProviders: Array.isArray(resp.attempted_providers) ? resp.attempted_providers : [],
    fallbackChain: Array.isArray(resp.fallbackChain) ? resp.fallbackChain : [],
    error: resp.error || null,
  };
}

function responseLeaksOpenAi(resp = {}) {
  const attempted = Array.isArray(resp.attempted_providers) ? resp.attempted_providers : [];
  const fallbackChain = Array.isArray(resp.fallbackChain) ? resp.fallbackChain : [];
  return String(resp.provider || '') === 'openai-oauth'
    || String(resp.dedupeProvider || '') === 'openai-oauth'
    || String(resp.selected_route || '').startsWith('openai-oauth/')
    || attempted.some((item) => String(item || '').startsWith('openai-oauth/'))
    || fallbackChain.some((item) => String(item || '').startsWith('openai-oauth/'));
}

async function main() {
  const common = {
    callerTeam: 'blog',
    agent: 'pos',
    selectorKey: 'blog.pos.writer',
    abstractModel: 'anthropic_sonnet',
    strictProviderFamily: 'anthropic',
    prompt: 'repair strict repro prompt',
    systemPrompt: 'strict repro',
    maxTokens: 256,
    timeoutMs: 1,
  };
  const repairReq = {
    ...common,
    taskType: 'lecture_post_repair',
  };
  const chunkedReq = {
    ...common,
    taskType: 'lecture_post_chunked',
  };

  const baselineRepair = summarizeSelection(repairReq);
  const baselineChunked = summarizeSelection(chunkedReq);
  const forceOpenAiUntil = new Date(Date.now() + 60 * 60_000).toISOString();
  const forcedRepair = withLocalEnv({
    LLM_FORCE_OPENAI_OAUTH_UNTIL: forceOpenAiUntil,
  }, () => summarizeSelection(repairReq));
  const disabledRepair = withLocalEnv({
    LLM_CLAUDE_CODE_SONNET_DISABLED: 'true',
  }, () => summarizeSelection(repairReq));
  const snakeCaseNegativeControl = summarizeSelection({
    ...repairReq,
    strictProviderFamily: undefined,
    strict_provider_family: 'anthropic',
  });
  const concurrentDedupe = await runConcurrentDedupeScenarios(repairReq);

  const result = {
    ok: false,
    causeConfirmed: false,
    confirmedCause: null,
    blockedReason: null,
    baselineRepair,
    baselineChunked,
    forcedRepair,
    disabledRepair,
    snakeCaseNegativeControl,
    concurrentDedupe,
  };

  const baselineOpenAiLeak = hasOpenAiAfterStrict(baselineRepair);
  const forcedOpenAiLeak = hasOpenAiAfterStrict(forcedRepair);
  const disabledOpenAiLeak = hasOpenAiAfterStrict(disabledRepair);
  const strictResponseOpenAiLeak = baselineOpenAiLeak || forcedOpenAiLeak || disabledOpenAiLeak;
  const concurrentStrictOpenAiLeak = concurrentDedupe.strictPair.openAiLeak
    || concurrentDedupe.mixedStrictVsUnrestricted.strictResponseOpenAiLeak;
  const strictIntegrityOk = strictResponseOpenAiLeak === false && concurrentStrictOpenAiLeak === false;

  if (baselineOpenAiLeak) {
    result.causeConfirmed = true;
    result.confirmedCause = 'strict_filter_did_not_remove_selector_openai_fallback';
  } else if (forcedOpenAiLeak) {
    result.causeConfirmed = true;
    result.confirmedCause = 'strict_chain_later_normalized_to_openai_replacement';
  } else if (disabledOpenAiLeak) {
    result.causeConfirmed = true;
    result.confirmedCause = 'sonnet_disabled_guard_reintroduced_openai_after_strict_filter';
  } else if (concurrentStrictOpenAiLeak) {
    result.causeConfirmed = true;
    result.confirmedCause = 'inflight_dedupe_shared_openai_result_with_strict_repair_request';
  } else {
    result.blockedReason = 'strict_repair_openai_leak_not_reproduced_in_single_or_concurrent_dedupe_paths';
  }

  result.strictResponseOpenAiLeak = strictResponseOpenAiLeak;
  result.concurrentStrictOpenAiLeak = concurrentStrictOpenAiLeak;
  result.unrestrictedResponseUsesOpenAi = concurrentDedupe.mixedStrictVsUnrestricted.unrestrictedResponseUsesOpenAi;
  result.ok = strictIntegrityOk;
  console.log(JSON.stringify(result, null, 2));
  if (!strictIntegrityOk) process.exitCode = 1;
}

function hasOpenAiAfterStrict(summary) {
  return summary.selectionProviders.includes('openai-oauth')
    || summary.resilienceProviders.includes('openai-oauth');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
