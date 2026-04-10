const env = require('./env');

type RequestOptions = RequestInit & {
  baseUrl?: string;
  maxAttempts?: number;
  timeoutMs?: number;
  max_tokens?: number;
  maxTokens?: number;
  temperature?: number;
};

type ModelListResponse = {
  data?: Array<{ id?: string }>;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

const LOCAL_MODEL_FAST = process.env.LOCAL_MODEL_FAST || 'qwen2.5-7b';
const LOCAL_MODEL_DEEP = process.env.LOCAL_MODEL_DEEP || 'deepseek-r1-32b';
const LOCAL_RETRYABLE_STATUS = new Set([404, 500, 502, 503, 504]);

function normalizeBaseUrl(value: unknown): string {
  return String(value || '').replace(/\/+$/, '');
}

function getBaseUrl(options: { baseUrl?: string } = {}): string {
  return normalizeBaseUrl(options.baseUrl || env.LOCAL_LLM_BASE_URL || '');
}

function getEmbeddingsUrl(options: { baseUrl?: string } = {}): string {
  const baseUrl = getBaseUrl(options);
  return baseUrl ? `${baseUrl}/v1/embeddings` : '';
}

async function requestJson(path: string, options: RequestOptions = {}, timeoutMs = 3000): Promise<Record<string, unknown> | null> {
  const baseUrl = getBaseUrl(options);
  if (!baseUrl) return null;

  const url = `${baseUrl}${path}`;
  const maxAttempts = Number(options.maxAttempts || (path === '/v1/chat/completions' ? 3 : 1));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      if (!res.ok) {
        const retryable = LOCAL_RETRYABLE_STATUS.has(res.status) && attempt < maxAttempts;
        console.warn(`[local-llm-client] ${path}: HTTP ${res.status}${retryable ? ` → 재시도 ${attempt}/${maxAttempts - 1}` : ''}`);
        if (!retryable) return null;
      } else {
        return await res.json() as Record<string, unknown>;
      }
    } catch (error) {
      const err = error as { name?: string; message?: string };
      const aborted = err?.name === 'AbortError';
      const retryable = attempt < maxAttempts;
      const message = aborted ? '타임아웃' : String(err?.message || 'unknown error');
      console.warn(`[local-llm-client] ${path}: ${message}${retryable ? ` → 재시도 ${attempt}/${maxAttempts - 1}` : ''}`);
      if (!retryable) return null;
    } finally {
      clearTimeout(timer);
    }

    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }

  return null;
}

async function getAvailableModels(): Promise<string[]> {
  const json = await requestJson('/v1/models') as ModelListResponse | null;
  if (!json?.data || !Array.isArray(json.data)) return [];
  return json.data.map((item) => item.id).filter(Boolean) as string[];
}

function pickGemmaModel(models: string[], preferLarge = false): string | null {
  const gemma = models.filter((model) => /^gemma/i.test(model));
  if (gemma.length === 0) return null;
  if (!preferLarge) {
    return gemma.find((model) => /latest/i.test(model)) || gemma[0] || null;
  }
  return gemma.find((model) => /26b|27b|large/i.test(model))
    || gemma.find((model) => /latest/i.test(model))
    || gemma[0]
    || null;
}

async function resolveRequestedModel(model: string): Promise<string> {
  const models = await getAvailableModels();
  if (models.length === 0 || models.includes(model)) return model;

  const preferLarge = model === LOCAL_MODEL_DEEP || /deepseek|32b|70b|reason/i.test(model);
  const remapped = pickGemmaModel(models, preferLarge) || models[0];
  if (remapped && remapped !== model) {
    console.warn(`[local-llm-client] model '${model}' 없음 → '${remapped}' 사용`);
    return remapped;
  }
  return model;
}

async function isLocalLLMAvailable(): Promise<boolean> {
  const models = await getAvailableModels();
  return models.length > 0;
}

async function callLocalLLM(model: string, messages: unknown[], options: RequestOptions = {}): Promise<string | null> {
  const resolvedModel = await resolveRequestedModel(model);
  const timeoutMs = Number(options.timeoutMs || ((model === LOCAL_MODEL_DEEP || resolvedModel === LOCAL_MODEL_DEEP) ? 120000 : 30000));

  const json = await requestJson('/v1/chat/completions', {
    baseUrl: options.baseUrl,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: resolvedModel,
      messages,
      max_tokens: options.max_tokens || options.maxTokens || 512,
      temperature: options.temperature ?? 0.2,
    }),
  }, timeoutMs) as ChatCompletionResponse | null;

  return json?.choices?.[0]?.message?.content || null;
}

async function callLocalLLMJSON(model: string, messages: unknown[], options: RequestOptions = {}): Promise<unknown | null> {
  const text = await callLocalLLM(model, messages, options);
  if (!text) return null;

  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```json/gi, '```')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const fenceMatch = cleaned.match(/```([\s\S]*?)```/);
    if (fenceMatch) {
      const fenced = fenceMatch[1].trim();
      try {
        return JSON.parse(fenced);
      } catch {
        // continue
      }
    }

    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;

    try {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    } catch {
      for (let start = cleaned.indexOf('{'); start !== -1; start = cleaned.indexOf('{', start + 1)) {
        const end = cleaned.lastIndexOf('}');
        if (end <= start) continue;
        try {
          return JSON.parse(cleaned.slice(start, end + 1));
        } catch {
          // try next start
        }
      }
      return null;
    }
  }
}

export = {
  LOCAL_MODEL_FAST,
  LOCAL_MODEL_DEEP,
  getBaseUrl,
  getEmbeddingsUrl,
  getAvailableModels,
  isLocalLLMAvailable,
  callLocalLLM,
  callLocalLLMJSON,
};
