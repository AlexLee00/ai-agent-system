// Local Ollama HTTP caller with Circuit Breaker + empty-response detection
// Uses fetch (no axios dependency). Default timeout 15s (short to fail fast).

import * as registry from './provider-registry';
import type { LLMCallResponse } from './types';

const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_RESPONSE_LENGTH = 3;
const LOCAL_OLLAMA_URL = process.env.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:11434';

export interface LocalOllamaRequest {
  prompt: string;
  model: string;           // e.g. 'qwen2.5-7b'
  systemPrompt?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export async function callLocalOllama(req: LocalOllamaRequest): Promise<LLMCallResponse> {
  const providerKey = `local/${req.model}`;
  const baseUrl = req.baseUrl || LOCAL_OLLAMA_URL;
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!registry.canCall(providerKey)) {
    return { ok: false, provider: 'failed', error: `circuit_open:${providerKey}`, durationMs: 0 };
  }

  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const messages: Array<{ role: string; content: string }> = [];
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
      registry.recordFailure(providerKey, reason, latency);
      return { ok: false, provider: 'failed', error: `${reason}:${res.status}`, durationMs: latency };
    }

    const json: any = await res.json();
    const text: string = json?.choices?.[0]?.message?.content ?? '';

    if (!text || text.trim().length < MIN_RESPONSE_LENGTH) {
      registry.recordFailure(providerKey, 'empty_response', latency);
      return { ok: false, provider: 'failed', error: `empty_response (len=${text.length})`, durationMs: latency };
    }

    registry.recordSuccess(providerKey, latency);
    return { ok: true, provider: 'failed', result: text, durationMs: latency, totalCostUsd: 0 };
  } catch (err: any) {
    const latency = Date.now() - start;
    const reason = err?.name === 'AbortError' ? 'timeout'
      : (err?.code === 'ECONNREFUSED' ? 'network' : 'unknown');
    registry.recordFailure(providerKey, reason, latency);
    return { ok: false, provider: 'failed', error: `${reason}:${err.message}`, durationMs: latency };
  } finally {
    clearTimeout(timer);
  }
}
