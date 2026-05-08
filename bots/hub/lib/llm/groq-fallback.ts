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

const DEFAULT_GROQ_RETRY_AFTER_MS = 60_000;
const MAX_GROQ_RETRY_AFTER_MS = 30 * 60_000;

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = GROQ_PRICING[model];
  if (!pricing) return 0;
  return promptTokens * pricing.input + completionTokens * pricing.output;
}

function parseDurationMs(value: string): number | null {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  const directSeconds = Number(raw);
  if (Number.isFinite(directSeconds) && directSeconds > 0) return directSeconds * 1000;

  let totalMs = 0;
  const pattern = /(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const unit = match[2];
    if (unit.startsWith('ms') || unit.startsWith('millisecond')) totalMs += amount;
    else if (unit.startsWith('s') || unit.startsWith('sec')) totalMs += amount * 1000;
    else if (unit.startsWith('m') || unit.startsWith('min')) totalMs += amount * 60_000;
    else if (unit.startsWith('h') || unit.startsWith('hr') || unit.startsWith('hour')) totalMs += amount * 3_600_000;
  }
  return totalMs > 0 ? totalMs : null;
}

function resolveGroqRetryAfterMs(resp: Response, body: string): number {
  const headerMs = parseDurationMs(resp.headers.get('retry-after') || '');
  const messageMs = parseDurationMs(String(body || '').match(/try again in ([^."}]+)/i)?.[1] || '');
  const parsed = headerMs || messageMs || DEFAULT_GROQ_RETRY_AFTER_MS;
  return Math.min(Math.max(parsed, DEFAULT_GROQ_RETRY_AFTER_MS), MAX_GROQ_RETRY_AFTER_MS);
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
      const body = await resp.text().catch(() => '');
      const retryAfterMs = resolveGroqRetryAfterMs(resp, body);
      blacklistGroqKey(apiKey, retryAfterMs);
      const nextKey = pickGroqApiKey();
      if (nextKey && nextKey !== apiKey) {
        return doGroqCall(req, nextKey, retryCount + 1);
      }
      return {
        ok: false,
        provider: 'failed',
        durationMs,
        retryAfterMs,
        error: `Groq 429: ${body.slice(0, 300) || '전체 계정 풀 rate-limited'}`,
      } as LLMCallResponse & { retryAfterMs: number };
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
    return {
      ok: false,
      provider: 'failed',
      durationMs: 0,
      retryAfterMs: DEFAULT_GROQ_RETRY_AFTER_MS,
      error: 'Groq 계정 풀 비어있음 또는 rate-limit cooldown 중',
    } as LLMCallResponse & { retryAfterMs: number };
  }
  return doGroqCall(req, apiKey);
}

export const _testOnly = {
  parseDurationMs,
  resolveGroqRetryAfterMs,
};
