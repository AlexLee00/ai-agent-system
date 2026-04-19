'use strict';

// Local Ollama HTTP caller with Circuit Breaker + empty-response detection
// Default timeout 15s. Uses fetch (no axios). Calls /v1/chat/completions (OpenAI compat).

const registry = require('./provider-registry');

const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_RESPONSE_LENGTH = 3;

function getBaseUrl(baseUrl) {
  return baseUrl || process.env.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:11434';
}

async function callLocalOllama(req) {
  const providerKey = `local/${req.model}`;
  const baseUrl = getBaseUrl(req.baseUrl);
  const timeoutMs = req.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!registry.canCall(providerKey)) {
    return { ok: false, provider: 'failed', error: `circuit_open:${providerKey}`, durationMs: 0 };
  }

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
      registry.recordFailure(providerKey, reason, latency);
      return { ok: false, provider: 'failed', error: `${reason}:${res.status}`, durationMs: latency };
    }

    const json = await res.json();
    const text = (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';

    if (!text || text.trim().length < MIN_RESPONSE_LENGTH) {
      registry.recordFailure(providerKey, 'empty_response', latency);
      return { ok: false, provider: 'failed', error: `empty_response (len=${text.length})`, durationMs: latency };
    }

    registry.recordSuccess(providerKey, latency);
    return { ok: true, provider: 'failed', result: text, durationMs: latency, totalCostUsd: 0 };
  } catch (err) {
    const latency = Date.now() - start;
    const reason = (err && err.name === 'AbortError') ? 'timeout'
      : (err && err.code === 'ECONNREFUSED') ? 'network' : 'unknown';
    registry.recordFailure(providerKey, reason, latency);
    return { ok: false, provider: 'failed', error: `${reason}:${(err && err.message) || 'unknown'}`, durationMs: latency };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { callLocalOllama };
