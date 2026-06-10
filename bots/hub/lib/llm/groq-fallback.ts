import { loadGroqAccounts, pickGroqApiKey, blacklistGroqKey } from './secrets-loader';
import type { LLMCallResponse } from './types';

export interface GroqRequest {
  prompt: string;
  model?: 'llama-3.3-70b-versatile' | 'llama-3.1-8b-instant' | 'qwen/qwen3-32b' | string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  jsonSchema?: Record<string, unknown>;
  jsonSchemaName?: string;
  strictJsonSchema?: boolean;
  responseFormat?: 'text' | 'json_object' | 'json_schema';
  reasoningEffort?: 'none' | 'default' | 'low' | 'medium' | 'high';
  reasoningFormat?: 'hidden' | 'raw' | 'parsed';
  includeReasoning?: boolean;
  seed?: number;
  serviceTier?: 'auto' | 'on_demand' | 'flex' | 'performance';
}

// Groq Developer Tier 가격 (per token), 공식 model page 기준.
const GROQ_PRICING: Record<string, { input: number; output: number }> = {
  'llama-3.1-8b-instant':                         { input: 5.0e-8, output: 8.0e-8 },
  'llama-3.3-70b-versatile':                      { input: 5.9e-7, output: 7.9e-7 },
  'meta-llama/llama-4-scout-17b-16e-instruct':    { input: 1.1e-7, output: 3.4e-7 },
  'llama-4-scout-17b-16e-instruct':               { input: 1.1e-7, output: 3.4e-7 },
  'qwen/qwen3-32b':                               { input: 2.9e-7, output: 5.9e-7 },
  'qwen-qwq-32b':                                 { input: 2.9e-7, output: 5.9e-7 },
  'openai/gpt-oss-20b':                           { input: 7.5e-8, output: 3.0e-7 },
  'openai/gpt-oss-120b':                          { input: 1.5e-7, output: 6.0e-7 },
};

const DEFAULT_GROQ_RETRY_AFTER_MS = 60_000;
const MAX_GROQ_RETRY_AFTER_MS = 30 * 60_000;
const DEFAULT_GROQ_MAX_COMPLETION_TOKENS = 4096;
const DEFAULT_GROQ_MAX_TOTAL_TOKENS = 12_000;

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

function readHeader(resp: Response, name: string): string | null {
  const value = resp.headers.get(name);
  return value === null ? null : value;
}

function hasHeaderValue(entry: readonly [string, string | null]): entry is readonly [string, string] {
  return entry[1] !== null;
}

function extractRateLimitHeaders(resp: Response): Record<string, string> {
  const entries = [
    'retry-after',
    'x-ratelimit-limit-requests',
    'x-ratelimit-limit-tokens',
    'x-ratelimit-remaining-requests',
    'x-ratelimit-remaining-tokens',
    'x-ratelimit-reset-requests',
    'x-ratelimit-reset-tokens',
  ];
  return Object.fromEntries(
    entries
      .map((name) => [name, readHeader(resp, name)] as const)
      .filter(hasHeaderValue),
  );
}

function normalizeTemperature(value: number | undefined): number {
  const temperature = Number(value ?? 0.3);
  if (!Number.isFinite(temperature)) return 0.3;
  // Groq/OpenAI compatibility converts 0 to 1e-8; keep our payload explicit.
  if (temperature <= 0) return 1e-8;
  return Math.min(temperature, 2);
}

function resolveGroqMaxAttempts(): number {
  const configured = Number(process.env.HUB_GROQ_MAX_KEY_ATTEMPTS || process.env.HUB_GROQ_MAX_KEY_RETRIES || '');
  if (Number.isFinite(configured) && configured > 0) return Math.max(1, Math.min(Math.floor(configured), 25));
  if (process.env.GROQ_API_KEY) return 1;
  // See secrets-loader.ts for the operational basis: Groq's official limit
  // model is org-level, but the deployed key set was measured as independent
  // buckets. Default to trying the configured pool; set
  // HUB_GROQ_ACCOUNT_POOL_ENABLED=false to force a single primary key.
  if (['0', 'false', 'no', 'n', 'off'].includes(String(process.env.HUB_GROQ_ACCOUNT_POOL_ENABLED || '').trim().toLowerCase())) return 1;
  return Math.max(1, Math.min(loadGroqAccounts().length || 1, 25));
}

function resolveGroqMaxCompletionTokens(): number {
  const configured = Number(process.env.HUB_GROQ_MAX_COMPLETION_TOKENS || process.env.LLM_GROQ_MAX_COMPLETION_TOKENS || '');
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  return DEFAULT_GROQ_MAX_COMPLETION_TOKENS;
}

function resolveGroqMaxTotalTokens(): number {
  const configured = Number(process.env.HUB_GROQ_MAX_TOTAL_TOKENS || process.env.LLM_GROQ_MAX_TOTAL_TOKENS || '');
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  return DEFAULT_GROQ_MAX_TOTAL_TOKENS;
}

function estimateTextTokens(value: string | undefined): number {
  const text = String(value || '');
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function resolveGroqTokenGuard(req: GroqRequest): {
  ok: boolean;
  promptTokens: number;
  requestedCompletionTokens: number;
  estimatedTotalTokens: number;
  maxCompletionTokens: number;
  maxTotalTokens: number;
  reason?: string;
} {
  const promptTokens = estimateTextTokens(req.systemPrompt) + estimateTextTokens(req.prompt);
  const requestedCompletionTokens = Number.isFinite(Number(req.maxTokens)) ? Math.max(0, Math.floor(Number(req.maxTokens))) : 1024;
  const estimatedTotalTokens = promptTokens + requestedCompletionTokens;
  const maxCompletionTokens = resolveGroqMaxCompletionTokens();
  const maxTotalTokens = resolveGroqMaxTotalTokens();
  if (requestedCompletionTokens > maxCompletionTokens) {
    return { ok: false, promptTokens, requestedCompletionTokens, estimatedTotalTokens, maxCompletionTokens, maxTotalTokens, reason: 'completion_token_limit' };
  }
  if (estimatedTotalTokens > maxTotalTokens) {
    return { ok: false, promptTokens, requestedCompletionTokens, estimatedTotalTokens, maxCompletionTokens, maxTotalTokens, reason: 'total_token_pressure' };
  }
  return { ok: true, promptTokens, requestedCompletionTokens, estimatedTotalTokens, maxCompletionTokens, maxTotalTokens };
}

function resolveServiceTier(req: GroqRequest): string | undefined {
  const raw = String(req.serviceTier || process.env.HUB_GROQ_SERVICE_TIER || '').trim();
  if (!raw) return undefined;
  return ['auto', 'on_demand', 'flex', 'performance'].includes(raw) ? raw : undefined;
}

function isGptOssModel(model: string): boolean {
  return model === 'openai/gpt-oss-20b' || model === 'openai/gpt-oss-120b';
}

function isQwenReasoningModel(model: string): boolean {
  return model === 'qwen/qwen3-32b' || model === 'qwen3-32b' || model === 'qwen-qwq-32b';
}

function isStructuredOutputModel(model: string): boolean {
  return isGptOssModel(model)
    || model === 'openai/gpt-oss-safeguard-20b'
    || model === 'meta-llama/llama-4-scout-17b-16e-instruct';
}

function resolveReasoningEffort(req: GroqRequest, model: string): string | undefined {
  if (req.reasoningEffort) return req.reasoningEffort;
  if (isGptOssModel(model)) return 'low';
  if (isQwenReasoningModel(model)) return 'none';
  return undefined;
}

function buildResponseFormat(req: GroqRequest, model: string): Record<string, unknown> | undefined {
  if (req.jsonSchema && isStructuredOutputModel(model)) {
    return {
      type: 'json_schema',
      json_schema: {
        name: req.jsonSchemaName || 'hub_response',
        strict: Boolean(req.strictJsonSchema),
        schema: req.jsonSchema,
      },
    };
  }
  if (req.responseFormat === 'json_object' || (req.jsonSchema && !isStructuredOutputModel(model))) {
    return { type: 'json_object' };
  }
  return undefined;
}

function buildGroqRequestBody(req: GroqRequest, model: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      ...(req.systemPrompt ? [{ role: 'system', content: req.systemPrompt }] : []),
      { role: 'user', content: req.prompt },
    ],
    max_completion_tokens: req.maxTokens ?? 1024,
    temperature: normalizeTemperature(req.temperature),
  };

  const serviceTier = resolveServiceTier(req);
  if (serviceTier) body.service_tier = serviceTier;

  const responseFormat = buildResponseFormat(req, model);
  if (responseFormat) body.response_format = responseFormat;

  const reasoningEffort = resolveReasoningEffort(req, model);
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  if (req.reasoningFormat) body.reasoning_format = req.reasoningFormat;
  if (typeof req.includeReasoning === 'boolean') body.include_reasoning = req.includeReasoning;
  if (Number.isInteger(req.seed)) body.seed = req.seed;

  return body;
}

async function doGroqCall(
  req: GroqRequest,
  apiKey: string,
  attempt = 1,
  maxAttempts = resolveGroqMaxAttempts(),
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
      body: JSON.stringify(buildGroqRequestBody(req, model)),
    });

    const durationMs = Date.now() - started;
    const rateLimit = extractRateLimitHeaders(resp);

    if (resp.status === 429) {
      const body = await resp.text().catch(() => '');
      const retryAfterMs = resolveGroqRetryAfterMs(resp, body);
      blacklistGroqKey(apiKey, retryAfterMs);
      if (attempt < maxAttempts) {
        const nextKey = pickGroqApiKey();
        if (nextKey && nextKey !== apiKey) {
          return doGroqCall(req, nextKey, attempt + 1, maxAttempts);
        }
      }
      return {
        ok: false,
        provider: 'failed',
        durationMs,
        retryAfterMs,
        rateLimit,
        error: `Groq 429: ${body.slice(0, 300) || '전체 계정 풀 rate-limited'}`,
      } as LLMCallResponse & { retryAfterMs: number; rateLimit: Record<string, string> };
    }

    if (resp.status === 498) {
      const body = await resp.text().catch(() => '');
      return {
        ok: false,
        provider: 'failed',
        durationMs,
        retryAfterMs: 5_000,
        rateLimit,
        error: `Groq 498 capacity_exceeded: ${body.slice(0, 300)}`,
      } as LLMCallResponse & { retryAfterMs: number; rateLimit: Record<string, string> };
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { ok: false, provider: 'failed', durationMs, rateLimit, error: `Groq ${resp.status}: ${body.slice(0, 300)}` } as LLMCallResponse & { rateLimit: Record<string, string> };
    }

    const data = await resp.json() as any;
    const content: string = data?.choices?.[0]?.message?.content ?? '';
    const usage = data?.usage ?? {};
    const totalCostUsd = estimateCost(model, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0);
    let structuredOutput: unknown;
    if (req.jsonSchema && content) {
      try { structuredOutput = JSON.parse(content); } catch {}
    }

    return {
      ok: true,
      provider: 'groq',
      result: content,
      structuredOutput,
      durationMs,
      apiDurationMs: durationMs,
      totalCostUsd,
      modelUsage: { [model]: usage },
      rateLimit,
    } as LLMCallResponse & { rateLimit: Record<string, string> };
  } catch (err) {
    if (attempt < maxAttempts) {
      const nextKey = pickGroqApiKey();
      if (nextKey && nextKey !== apiKey) {
        return doGroqCall(req, nextKey, attempt + 1, maxAttempts);
      }
    }
    return {
      ok: false,
      provider: 'failed',
      durationMs: Date.now() - started,
      error: `Groq fetch error: ${(err as Error).message}`,
    };
  }
}

export async function callGroqFallback(req: GroqRequest): Promise<LLMCallResponse> {
  const tokenGuard = resolveGroqTokenGuard(req);
  if (!tokenGuard.ok) {
    return {
      ok: false,
      provider: 'failed',
      durationMs: 0,
      retryAfterMs: 0,
      error: `groq_token_pressure_guard:${tokenGuard.reason}`,
      tokenGuard,
    } as LLMCallResponse & { retryAfterMs: number; tokenGuard: typeof tokenGuard };
  }
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
  buildGroqRequestBody,
  resolveGroqMaxAttempts,
  resolveGroqMaxCompletionTokens,
  resolveGroqMaxTotalTokens,
  resolveGroqTokenGuard,
};
