import { callClaudeCodeOAuth } from './claude-code-oauth';
import { callGroqFallback } from './groq-fallback';
import { checkCache, saveCache } from './cache';
import type { LLMCallRequest, LLMCallResponse, AbstractModel } from './types';

// Recommender abstract atom → Claude Code 모델명
const CLAUDE_CODE_MODEL: Record<AbstractModel, 'haiku' | 'sonnet' | 'opus'> = {
  anthropic_haiku:  'haiku',
  anthropic_sonnet: 'sonnet',
  anthropic_opus:   'opus',
};

// Recommender abstract atom → Groq 폴백 모델
const GROQ_MODEL: Record<AbstractModel, string> = {
  anthropic_haiku:  'llama-3.1-8b-instant',
  anthropic_sonnet: 'llama-3.3-70b-versatile',
  anthropic_opus:   'qwen-qwq-32b',
};

export async function callWithFallback(req: LLMCallRequest): Promise<LLMCallResponse> {
  const ccModel = CLAUDE_CODE_MODEL[req.abstractModel] ?? 'sonnet';
  const groqModel = GROQ_MODEL[req.abstractModel] ?? 'llama-3.3-70b-versatile';
  const team = req.callerTeam ?? 'worker';

  // 0. Budget check
  if (process.env.HUB_BUDGET_GUARDIAN_ENABLED !== 'false') {
    try {
      const { BudgetGuardian } = require('../budget-guardian');
      const budgetCheck = BudgetGuardian.getInstance().checkAndReserve(team, 0.01);
      if (!budgetCheck.ok) {
        console.warn(`[llm/unified] 예산 차단 (${team}): ${budgetCheck.reason}`);
        return {
          ok: false,
          provider: 'failed',
          error: `budget_exceeded: ${budgetCheck.reason}`,
          durationMs: 0,
        };
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
        return {
          ok: true,
          provider: 'claude-code-oauth',
          result: cached.response,
          durationMs: 0,
          totalCostUsd: 0,
          cacheHit: true,
          cachedAt: cached.cachedAt,
        };
      }
    } catch (e: any) {
      console.warn('[llm/unified] 캐시 조회 오류 (무시):', e.message);
    }
  }

  // 2. Primary: Claude Code OAuth
  const primary = await callClaudeCodeOAuth({
    prompt: req.prompt,
    model: ccModel,
    systemPrompt: req.systemPrompt,
    jsonSchema: req.jsonSchema,
    timeoutMs: req.timeoutMs,
    maxBudgetUsd: req.maxBudgetUsd,
  });

  if (primary.ok) {
    // 3. Cache save on success
    if (req.cacheEnabled && primary.result) {
      try {
        const cacheKey = { abstractModel: req.abstractModel, prompt: req.prompt, systemPrompt: req.systemPrompt };
        const tokensIn = (primary.modelUsage as any)?.input_tokens ?? 0;
        const tokensOut = (primary.modelUsage as any)?.output_tokens ?? 0;
        await saveCache(cacheKey, primary.result, { in: tokensIn, out: tokensOut }, primary.totalCostUsd ?? 0, req.cacheType ?? 'default');
      } catch (e: any) {
        console.warn('[llm/unified] 캐시 저장 오류 (무시):', e.message);
      }
    }
    return { ...primary, provider: 'claude-code-oauth', cacheHit: false };
  }

  // 4. Groq 폴백
  console.warn(`[llm/unified] Primary 실패: ${primary.error} → Groq 폴백 (${groqModel})`);
  const fallback = await callGroqFallback({
    prompt: req.prompt,
    model: groqModel,
    systemPrompt: req.systemPrompt,
  });

  return {
    ...fallback,
    provider: fallback.ok ? 'groq' : 'failed',
    primaryError: primary.error,
    fallbackCount: 1,
    cacheHit: false,
  };
}
