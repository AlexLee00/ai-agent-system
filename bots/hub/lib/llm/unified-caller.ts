import { callClaudeCodeOAuth } from './claude-code-oauth';
import { callGroqFallback } from './groq-fallback';
import { callLocalOllama } from './local-ollama';
import { checkCache, saveCache } from './cache';
import { selectRuntimeProfile } from '../runtime-profiles';
import { getGroqFallback } from '../../../../packages/core/lib/llm-models';
import type { LLMCallRequest, LLMCallResponse, AbstractModel } from './types';

const sender = require('../../../../packages/core/lib/telegram-sender');

// Recommender abstract atom → Claude Code OAuth 모델 단축명
const CLAUDE_CODE_MODEL: Record<AbstractModel, 'haiku' | 'sonnet' | 'opus'> = {
  anthropic_haiku:  'haiku',
  anthropic_sonnet: 'sonnet',
  anthropic_opus:   'opus',
};

// llm-models.json SSoT → Groq 폴백 모델 동적 참조
const GROQ_MODEL: Record<AbstractModel, string> = {
  anthropic_haiku:  getGroqFallback('anthropic_haiku'),
  anthropic_sonnet: getGroqFallback('anthropic_sonnet'),
  anthropic_opus:   getGroqFallback('anthropic_opus'),
};

export async function callWithFallback(req: LLMCallRequest): Promise<LLMCallResponse> {
  const team = req.callerTeam ?? 'worker';

  // 0. Budget check
  if (process.env.HUB_BUDGET_GUARDIAN_ENABLED !== 'false') {
    try {
      const { BudgetGuardian } = require('../budget-guardian');
      const budgetCheck = BudgetGuardian.getInstance().checkAndReserve(team, 0.01);
      if (!budgetCheck.ok) {
        console.warn(`[llm/unified] 예산 차단 (${team}): ${budgetCheck.reason}`);
        return { ok: false, provider: 'failed', error: `budget_exceeded: ${budgetCheck.reason}`, durationMs: 0 };
      }
    } catch (e: any) {
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
    } catch (e: any) {
      console.warn('[llm/unified] 캐시 조회 오류 (무시):', e.message);
    }
  }

  // 2. Build fallback chain from runtime-profiles (team + agent) or legacy 2-step
  const profile = req.agent ? selectRuntimeProfile(team, req.agent) : null;
  const useProfileChain = !!(profile?.primary_routes?.length || profile?.fallback_routes?.length);

  if (useProfileChain) {
    return _callWithProfileChain(req, profile!, team);
  }

  return _callLegacy(req, team);
}

async function _callWithProfileChain(req: LLMCallRequest, profile: any, team: string): Promise<LLMCallResponse> {
  const chain: string[] = [
    ...(profile.primary_routes ?? []),
    ...(profile.fallback_routes ?? []),
  ].filter((r: string) => _isProviderSupported(r));

  const isCritical = profile.critical === true;
  const chainTimeout = profile.timeout_ms ?? req.timeoutMs ?? 30_000;

  const attempts: Array<{ provider: string; error: string; durationMs: number }> = [];

  for (const route of chain) {
    const result = await _callRoute(route, req, chainTimeout);
    if (result.ok) {
      if (req.cacheEnabled && result.result) {
        _saveCache(req, result).catch(() => {});
      }
      return { ...result, provider: _routeToProvider(route) as any, fallbackCount: attempts.length, attempted_providers: attempts.map(a => a.provider) as any };
    }
    attempts.push({ provider: route, error: result.error ?? 'unknown', durationMs: result.durationMs });

    // Critical chain: first failure → immediately try next (no circuit wait)
    if (isCritical) {
      console.warn(`[llm/unified] critical chain ${route} 실패 → 즉시 다음 (${result.error})`);
    } else {
      console.warn(`[llm/unified] ${route} 실패 (${result.error}) → 다음 시도`);
    }
  }

  // Fallback exhausted
  await _notifyFallbackExhaustion(req, attempts, team);
  return {
    ok: false, provider: 'failed', durationMs: attempts.reduce((s, a) => s + a.durationMs, 0),
    error: `fallback_exhausted: ${attempts.at(-1)?.error ?? 'unknown'}`,
    attempted_providers: attempts.map(a => a.provider) as any,
    fallbackCount: attempts.length,
  };
}

async function _callLegacy(req: LLMCallRequest, team: string): Promise<LLMCallResponse> {
  const ccModel = CLAUDE_CODE_MODEL[req.abstractModel] ?? 'sonnet';
  const groqModel = GROQ_MODEL[req.abstractModel] ?? 'llama-3.3-70b-versatile';

  // Primary: Claude Code OAuth
  const primary = await callClaudeCodeOAuth({ prompt: req.prompt, model: ccModel, systemPrompt: req.systemPrompt, jsonSchema: req.jsonSchema, timeoutMs: req.timeoutMs, maxBudgetUsd: req.maxBudgetUsd });
  if (primary.ok) {
    if (req.cacheEnabled && primary.result) _saveCache(req, primary).catch(() => {});
    return { ...primary, provider: 'claude-code-oauth', cacheHit: false };
  }

  // Fallback: Groq
  console.warn(`[llm/unified] Primary 실패: ${primary.error} → Groq 폴백 (${groqModel})`);
  const fallback = await callGroqFallback({ prompt: req.prompt, model: groqModel, systemPrompt: req.systemPrompt });
  return { ...fallback, provider: fallback.ok ? 'groq' : 'failed', primaryError: primary.error, fallbackCount: 1, cacheHit: false };
}

async function _callRoute(route: string, req: LLMCallRequest, timeoutMs: number): Promise<LLMCallResponse> {
  if (route.startsWith('claude-code/')) {
    const model = route.split('/')[1] as 'haiku' | 'sonnet' | 'opus';
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

function _isProviderSupported(route: string): boolean {
  return route.startsWith('claude-code/') || route.startsWith('groq/') || route.startsWith('local/');
}

function _routeToProvider(route: string): string {
  if (route.startsWith('claude-code/')) return 'claude-code-oauth';
  if (route.startsWith('groq/')) return 'groq';
  if (route.startsWith('local/')) return route;
  return route;
}

async function _saveCache(req: LLMCallRequest, resp: LLMCallResponse): Promise<void> {
  try {
    const { saveCache } = require('./cache');
    const cacheKey = { abstractModel: req.abstractModel, prompt: req.prompt, systemPrompt: req.systemPrompt };
    const tokensIn = (resp.modelUsage as any)?.input_tokens ?? 0;
    const tokensOut = (resp.modelUsage as any)?.output_tokens ?? 0;
    await saveCache(cacheKey, resp.result!, { in: tokensIn, out: tokensOut }, resp.totalCostUsd ?? 0, req.cacheType ?? 'default');
  } catch {}
}

async function _notifyFallbackExhaustion(req: LLMCallRequest, attempts: any[], team: string): Promise<void> {
  const tried = attempts.map((a: any) => a.provider).join(' → ');
  const lastErr = attempts.at(-1)?.error ?? 'unknown';
  const msg = `🚨 Fallback Exhaustion\n팀: ${team} / 에이전트: ${req.agent ?? 'default'}\n시도: ${tried}\n최종 에러: ${lastErr}`;
  console.error('[llm/unified]', msg);
  await sender.sendCritical('general', msg).catch(() => {});
}
