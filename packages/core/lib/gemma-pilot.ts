import { logLLMCall } from './llm-logger';
import { selectRuntime } from './runtime-selector';

type Runtime = {
  provider?: string;
  base_url?: string;
  model?: string;
  timeout_ms?: number;
  temperature?: number;
  max_tokens?: number;
};

function estimateTokens(text = ''): number {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

export async function generateGemmaPilotText({
  team,
  purpose,
  bot,
  requestType,
  prompt,
  maxTokens,
  temperature,
  timeoutMs,
}: {
  team?: string;
  purpose?: string;
  bot?: string;
  requestType?: string;
  prompt?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}): Promise<{ ok: boolean; content: string; runtime: Runtime | null; latencyMs?: number }> {
  const safePrompt = prompt ?? '';
  const safeTeam = team ?? '';
  const safePurpose = purpose ?? '';
  const safeBot = bot ?? '';
  const safeRequestType = requestType ?? '';
  const runtime = (await selectRuntime(safeTeam, safePurpose)) as Runtime | null;
  const startedAt = Date.now();
  const fallbackResult = { ok: false, content: '', runtime: runtime || null };

  if (!runtime || runtime.provider !== 'ollama' || !runtime.base_url || !runtime.model || !prompt) {
    return fallbackResult;
  }

  const controller = new AbortController();
  const resolvedTimeoutMs = Number(timeoutMs || runtime.timeout_ms || 10000);
  const timer = setTimeout(() => controller.abort(), resolvedTimeoutMs);

  try {
    const response = await fetch(`${String(runtime.base_url).replace(/\/+$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: runtime.model,
        prompt: safePrompt,
        stream: false,
        options: {
          temperature: temperature ?? runtime.temperature ?? 0.7,
          num_predict: maxTokens ?? runtime.max_tokens ?? 256,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const json = (await response.json()) as { response?: string };
    const content = String(json?.response || '').trim();
    const latencyMs = Date.now() - startedAt;

    await logLLMCall({
      team: safeTeam,
      bot: safeBot,
      model: `ollama/${runtime.model}`,
      requestType: safeRequestType,
      inputTokens: estimateTokens(safePrompt),
      outputTokens: estimateTokens(content),
      latencyMs,
      success: Boolean(content),
      errorMsg: content ? null : 'empty_response',
    });

    if (!content) return fallbackResult;
    return { ok: true, content, runtime, latencyMs };
  } catch (error) {
    const err = error as Error & { name?: string };
    await logLLMCall({
      team: safeTeam,
      bot: safeBot,
      model: `ollama/${runtime.model}`,
      requestType: safeRequestType,
      inputTokens: estimateTokens(safePrompt),
      outputTokens: 0,
      latencyMs: Date.now() - startedAt,
      success: false,
      errorMsg: err?.name === 'AbortError' ? 'timeout' : err.message,
    });
    return fallbackResult;
  } finally {
    clearTimeout(timer);
  }
}
