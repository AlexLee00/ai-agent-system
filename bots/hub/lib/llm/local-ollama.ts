'use strict';

// Local Ollama HTTP caller with Circuit Breaker + empty-response detection
// Default timeout 30s. Uses fetch (no axios). Calls /v1/chat/completions (OpenAI compat).

const registry = require('./provider-registry');

const DEFAULT_TIMEOUT_MS = positiveInteger(process.env.HUB_LLM_LOCAL_TIMEOUT_MS, 30_000);
const COLD_START_TIMEOUT_MS = positiveInteger(process.env.HUB_LLM_LOCAL_COLD_START_TIMEOUT_MS, 180_000);
const COLD_RETRY_ENABLED = String(process.env.HUB_LLM_LOCAL_COLD_RETRY_ENABLED ?? 'true') !== 'false';
const MIN_RESPONSE_LENGTH = 3;

type LocalOllamaRequest = {
  model: string;
  prompt: string;
  baseUrl?: string;
  timeoutMs?: number;
  systemPrompt?: string;
};

type LocalOllamaAttempt = {
  ok: boolean;
  result?: string;
  error?: string;
  failureReason?: string;
  durationMs: number;
  totalCostUsd?: number;
};

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function getBaseUrl(baseUrl?: string): string {
  return baseUrl || process.env.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:11434';
}

function resolveRequestTimeoutMs(timeoutMs?: number): { timeoutMs: number; explicit: boolean } {
  const parsed = Number(timeoutMs);
  if (Number.isFinite(parsed) && parsed > 0) {
    return { timeoutMs: Math.floor(parsed), explicit: true };
  }
  return { timeoutMs: DEFAULT_TIMEOUT_MS, explicit: false };
}

function shouldRetryColdStart(first: LocalOllamaAttempt, timeoutMs: number, explicitTimeout: boolean): boolean {
  if (!COLD_RETRY_ENABLED) return false;
  if (first.ok || first.failureReason !== 'timeout') return false;
  return !explicitTimeout || timeoutMs <= DEFAULT_TIMEOUT_MS;
}

async function attemptLocalOllama(req: LocalOllamaRequest, baseUrl: string, timeoutMs: number): Promise<LocalOllamaAttempt> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const messages = [];
    if (req.systemPrompt) messages.push({ role: 'system', content: req.systemPrompt });
    messages.push({ role: 'user', content: req.prompt });

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: req.model, messages, stream: false }),
      signal: controller.signal,
    });

    const latency = Date.now() - start;

    if (!res.ok) {
      const reason = res.status >= 500 ? 'http_5xx' : 'http_4xx';
      return { ok: false, error: `${reason}:${res.status}`, failureReason: reason, durationMs: latency };
    }

    const json: any = await res.json();
    const text = (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';

    if (!text || text.trim().length < MIN_RESPONSE_LENGTH) {
      return { ok: false, error: `empty_response (len=${text.length})`, failureReason: 'empty_response', durationMs: latency };
    }

    return { ok: true, result: text, durationMs: latency, totalCostUsd: 0 };
  } catch (err) {
    const latency = Date.now() - start;
    const error = err as { name?: string; code?: string; message?: string };
    const reason = (error && error.name === 'AbortError') ? 'timeout'
      : (error && error.code === 'ECONNREFUSED') ? 'network' : 'unknown';
    return { ok: false, error: `${reason}:${(error && error.message) || 'unknown'}`, failureReason: reason, durationMs: latency };
  } finally {
    clearTimeout(timer);
  }
}

async function callLocalOllama(req: LocalOllamaRequest) {
  const providerKey = `local/${req.model}`;
  const baseUrl = getBaseUrl(req.baseUrl);
  const { timeoutMs, explicit: explicitTimeout } = resolveRequestTimeoutMs(req.timeoutMs);

  if (!registry.canCall(providerKey)) {
    return { ok: false, provider: 'failed', error: `circuit_open:${providerKey}`, durationMs: 0 };
  }

  const first = await attemptLocalOllama(req, baseUrl, timeoutMs);
  if (first.ok) {
    registry.recordSuccess(providerKey, first.durationMs);
    return { ok: true, provider: 'failed', result: first.result, durationMs: first.durationMs, totalCostUsd: 0 };
  }

  if (shouldRetryColdStart(first, timeoutMs, explicitTimeout)) {
    const second = await attemptLocalOllama(req, baseUrl, COLD_START_TIMEOUT_MS);
    const totalDurationMs = first.durationMs + second.durationMs;
    if (second.ok) {
      registry.recordSuccess(providerKey, totalDurationMs);
      return {
        ok: true,
        provider: 'failed',
        result: second.result,
        durationMs: totalDurationMs,
        totalCostUsd: 0,
        coldStartRetried: true,
      };
    }
    registry.recordFailure(providerKey, second.failureReason, totalDurationMs);
    return {
      ok: false,
      provider: 'failed',
      error: second.error,
      durationMs: totalDurationMs,
      coldStartRetried: true,
    };
  }

  registry.recordFailure(providerKey, first.failureReason, first.durationMs);
  return { ok: false, provider: 'failed', error: first.error, durationMs: first.durationMs };
}

module.exports = { callLocalOllama };
