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

  // 2. Build chain from runtime-profiles or legacy 2-step
  const profile = req.agent ? selectRuntimeProfile(team, req.agent) : null;
  const hasChain = !!(profile && ((profile.primary_routes && profile.primary_routes.length) || (profile.fallback_routes && profile.fallback_routes.length)));

  if (hasChain) {
    return _callWithProfileChain(req, profile, team);
  }
  return _callLegacy(req, team);
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

async function _callRoute(route, req, timeoutMs) {
  if (route.startsWith('claude-code/')) {
    const model = route.split('/')[1];
    return callClaudeCodeOAuth({ prompt: req.prompt, model, systemPrompt: req.systemPrompt, jsonSchema: req.jsonSchema, timeoutMs, maxBudgetUsd: req.maxBudgetUsd });
  }
  if (route.startsWith('groq/')) {
    const model = route.slice('groq/'.length);
    return callGroqFallback({ prompt: req.prompt, model, systemPrompt: req.systemPrompt });
  }
  if (route.startsWith('local/')) {
    const model = route.slice('local/'.length);
    return callLocalOllama({ prompt: req.prompt, model, systemPrompt: req.systemPrompt, timeoutMs });
  }
  return { ok: false, provider: 'failed', error: `unsupported_provider:${route}`, durationMs: 0 };
}

function _isProviderSupported(route) {
  return route.startsWith('claude-code/') || route.startsWith('groq/') || route.startsWith('local/');
}

function _routeToProvider(route) {
  if (route.startsWith('claude-code/')) return 'claude-code-oauth';
  if (route.startsWith('groq/')) return 'groq';
  return route;
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
