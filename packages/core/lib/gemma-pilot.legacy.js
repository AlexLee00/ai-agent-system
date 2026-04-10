'use strict';

const { selectRuntime } = require('./runtime-selector');
const { logLLMCall } = require('./llm-logger');
const { callLocalLLM } = require('./local-llm-client');

function estimateTokens(text = '') {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

async function generateGemmaPilotText({
  team,
  purpose,
  bot,
  requestType,
  prompt,
  maxTokens,
  temperature,
  timeoutMs,
}) {
  const runtime = await selectRuntime(team, purpose);
  const startedAt = Date.now();
  const fallbackResult = { ok: false, content: '', runtime: runtime || null };

  if (!runtime || !runtime.provider || !runtime.base_url || !runtime.model || !prompt) {
    return fallbackResult;
  }

  const resolvedTimeoutMs = Number(timeoutMs || runtime.timeout_ms || 10000);
  const modelLabel = `${runtime.provider}/${runtime.model}`;

  try {
    let content = '';
    if (runtime.provider === 'local') {
      content = String(await callLocalLLM(runtime.model, [
        { role: 'user', content: prompt },
      ], {
        baseUrl: runtime.base_url,
        maxTokens: maxTokens ?? runtime.max_tokens ?? 256,
        temperature: temperature ?? runtime.temperature ?? 0.7,
        timeoutMs: resolvedTimeoutMs,
      }) || '').trim();
    } else if (runtime.provider === 'ollama') {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), resolvedTimeoutMs);
      try {
        const response = await fetch(`${String(runtime.base_url).replace(/\/+$/, '')}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: runtime.model,
            prompt,
            stream: false,
            options: {
              temperature: temperature ?? runtime.temperature ?? 0.7,
              num_predict: maxTokens ?? runtime.max_tokens ?? 256,
            },
          }),
          signal: controller.signal,
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const json = await response.json();
        content = String(json?.response || '').trim();
      } finally {
        clearTimeout(timer);
      }
    } else {
      return fallbackResult;
    }
    const latencyMs = Date.now() - startedAt;

    await logLLMCall({
      team,
      bot,
      model: modelLabel,
      requestType,
      inputTokens: estimateTokens(prompt),
      outputTokens: estimateTokens(content),
      latencyMs,
      success: Boolean(content),
      errorMsg: content ? null : 'empty_response',
    });

    if (!content) return fallbackResult;
    return { ok: true, content, runtime, latencyMs };
  } catch (error) {
    await logLLMCall({
      team,
      bot,
      model: modelLabel,
      requestType,
      inputTokens: estimateTokens(prompt),
      outputTokens: 0,
      latencyMs: Date.now() - startedAt,
      success: false,
      errorMsg: error?.name === 'AbortError' ? 'timeout' : error.message,
    });
    return fallbackResult;
  }
}

module.exports = {
  generateGemmaPilotText,
};
