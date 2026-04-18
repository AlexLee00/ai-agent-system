import { pickGroqApiKey, blacklistGroqKey } from './secrets-loader';
import type { LLMCallResponse } from './types';

export interface GroqRequest {
  prompt: string;
  model?: 'llama-3.3-70b-versatile' | 'llama-3.1-8b-instant' | 'qwen-qwq-32b' | string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

// Groq Developer Tier 가격 (per token)
const GROQ_PRICING: Record<string, { input: number; output: number }> = {
  'llama-3.1-8b-instant':    { input: 5.0e-8, output: 8.0e-8 },
  'llama-3.3-70b-versatile': { input: 5.9e-7, output: 7.9e-7 },
  'qwen-qwq-32b':            { input: 2.9e-7, output: 3.9e-7 },
};

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = GROQ_PRICING[model];
  if (!pricing) return 0;
  return promptTokens * pricing.input + completionTokens * pricing.output;
}

async function doGroqCall(
  req: GroqRequest,
  apiKey: string,
  retryCount = 0,
): Promise<LLMCallResponse> {
  const started = Date.now();
  const model = req.model ?? 'llama-3.3-70b-versatile';

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          ...(req.systemPrompt ? [{ role: 'system', content: req.systemPrompt }] : []),
          { role: 'user', content: req.prompt },
        ],
        max_tokens: req.maxTokens ?? 1024,
        temperature: req.temperature ?? 0.3,
      }),
    });

    const durationMs = Date.now() - started;

    if (resp.status === 429 && retryCount < 3) {
      blacklistGroqKey(apiKey);
      const nextKey = pickGroqApiKey();
      if (nextKey && nextKey !== apiKey) {
        return doGroqCall(req, nextKey, retryCount + 1);
      }
      return { ok: false, provider: 'failed', durationMs, error: `Groq 429: 전체 계정 풀 소진` };
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { ok: false, provider: 'failed', durationMs, error: `Groq ${resp.status}: ${body.slice(0, 300)}` };
    }

    const data = await resp.json() as any;
    const content: string = data?.choices?.[0]?.message?.content ?? '';
    const usage = data?.usage ?? {};
    const totalCostUsd = estimateCost(model, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0);

    return {
      ok: true,
      provider: 'groq',
      result: content,
      durationMs,
      apiDurationMs: durationMs,
      totalCostUsd,
      modelUsage: { [model]: usage },
    };
  } catch (err) {
    return {
      ok: false,
      provider: 'failed',
      durationMs: Date.now() - started,
      error: `Groq fetch error: ${(err as Error).message}`,
    };
  }
}

export async function callGroqFallback(req: GroqRequest): Promise<LLMCallResponse> {
  const apiKey = pickGroqApiKey();
  if (!apiKey) {
    return { ok: false, provider: 'failed', durationMs: 0, error: 'Groq 계정 풀 비어있음 (env+secrets 모두)' };
  }
  return doGroqCall(req, apiKey);
}
