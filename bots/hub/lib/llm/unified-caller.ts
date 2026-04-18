import { callClaudeCodeOAuth } from './claude-code-oauth';
import { callGroqFallback } from './groq-fallback';
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

  // 1차: Claude Code OAuth
  const primary = await callClaudeCodeOAuth({
    prompt: req.prompt,
    model: ccModel,
    systemPrompt: req.systemPrompt,
    jsonSchema: req.jsonSchema,
    timeoutMs: req.timeoutMs,
    maxBudgetUsd: req.maxBudgetUsd,
  });

  if (primary.ok) {
    return { ...primary, provider: 'claude-code-oauth' };
  }

  // 2차: Groq 폴백
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
  };
}
