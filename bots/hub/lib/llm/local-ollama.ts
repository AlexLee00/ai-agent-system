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
  signal?: AbortSignal;
  attemptDeadlineAt?: number;
};

type LocalOllamaAttempt = {
  ok: boolean;
  result?: string;
  error?: string;
  failureReason?: string;
  durationMs: number;
  totalCostUsd?: number;
  upstreamStatus?: number;
  retryAfterMs?: number;
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

function parseRetryAfterMs(res: Response): number | undefined {
  const raw = String(res.headers.get('retry-after') || '').trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const retryAt = Date.parse(raw);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.max(0, retryAt - Date.now()) || undefined;
}

async function attemptLocalOllama(req: LocalOllamaRequest, baseUrl: string, timeoutMs: number): Promise<LocalOllamaAttempt> {
  const start = Date.now();
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(req.signal?.reason);
  if (req.signal?.aborted) abortFromParent();
  else req.signal?.addEventListener('abort', abortFromParent, { once: true });
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
      const retryAfterMs = parseRetryAfterMs(res);
      return {
        ok: false,
        error: `${reason}:${res.status}`,
        failureReason: reason,
        durationMs: latency,
        upstreamStatus: res.status,
        ...(retryAfterMs ? { retryAfterMs } : {}),
      };
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
    const reason = (error && error.name === 'AbortError') ? (req.signal?.aborted ? 'aborted' : 'timeout')
      : (error && error.code === 'ECONNREFUSED') ? 'network' : 'unknown';
    return { ok: false, error: `${reason}:${(error && error.message) || 'unknown'}`, failureReason: reason, durationMs: latency };
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', abortFromParent);
  }
}

async function callLocalOllama(req: LocalOllamaRequest) {
  const providerKey = `local/${req.model}`;
  const baseUrl = getBaseUrl(req.baseUrl);
  const { timeoutMs, explicit: explicitTimeout } = resolveRequestTimeoutMs(req.timeoutMs);
  const attemptDeadlineAt = Number(req.attemptDeadlineAt || 0);
  const hasAttemptDeadline = Boolean(
    req.signal
    && Number.isFinite(attemptDeadlineAt)
    && attemptDeadlineAt > Date.now(),
  );
  const remainingAttemptMs = () => hasAttemptDeadline
    ? Math.max(0, Math.floor(attemptDeadlineAt - Date.now()))
    : timeoutMs;

  if (!registry.canCall(providerKey)) {
    return { ok: false, provider: 'failed', error: `circuit_open:${providerKey}`, durationMs: 0 };
  }

  const firstTimeoutMs = hasAttemptDeadline
    ? Math.min(DEFAULT_TIMEOUT_MS, remainingAttemptMs())
    : timeoutMs;
  const first = await attemptLocalOllama(req, baseUrl, firstTimeoutMs);
  if (first.ok) {
    registry.recordSuccess(providerKey, first.durationMs);
    return { ok: true, provider: 'failed', result: first.result, durationMs: first.durationMs, totalCostUsd: 0 };
  }

  const retryEligible = shouldRetryColdStart(
    first,
    firstTimeoutMs,
    hasAttemptDeadline ? false : explicitTimeout,
  );
  const retryTimeoutMs = hasAttemptDeadline
    ? Math.min(COLD_START_TIMEOUT_MS, remainingAttemptMs())
    : COLD_START_TIMEOUT_MS;
  if (!req.signal?.aborted && retryEligible && retryTimeoutMs > 0) {
    const second = await attemptLocalOllama(req, baseUrl, retryTimeoutMs);
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
      upstreamStatus: second.upstreamStatus,
      retryAfterMs: second.retryAfterMs,
      coldStartRetried: true,
    };
  }

  registry.recordFailure(providerKey, first.failureReason, first.durationMs);
  return {
    ok: false,
    provider: 'failed',
    error: first.error,
    durationMs: first.durationMs,
    upstreamStatus: first.upstreamStatus,
    retryAfterMs: first.retryAfterMs,
  };
}

module.exports = { callLocalOllama };
