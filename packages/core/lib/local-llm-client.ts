const env = require('./env');
const { execFile } = require('node:child_process');

// ─── LLM 동시성 제한 세마포어 (32GB 메모리 가드, Step 4) ─────────────────
const LLM_MAX_CONCURRENT = Number(process.env.LLM_MAX_CONCURRENT || 2);

function makeSemaphore(max) {
  let count = 0;
  const queue = [];

  function acquire() {
    if (count < max) { count++; return Promise.resolve(); }
    return new Promise((resolve) => {
      queue.push(() => { count++; resolve(); });
    });
  }

  function release() {
    count--;
    const next = queue.shift();
    if (next) next();
  }

  return { acquire, release };
}

const llmSemaphore = makeSemaphore(LLM_MAX_CONCURRENT);

type RequestOptions = RequestInit & {
  baseUrl?: string;
  maxAttempts?: number;
  timeoutMs?: number;
  max_tokens?: number;
  maxTokens?: number;
  temperature?: number;
  jsonAttempts?: number;
  validateResult?: (value: unknown) => boolean;
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
const LOCAL_MODEL_EMBED = process.env.EMBED_MODEL || 'qwen3-embed-0.6b';
const LOCAL_RETRYABLE_STATUS = new Set([404, 500, 502, 503, 504]);
const EXPECTED_MLX_MODELS = new Set([LOCAL_MODEL_FAST, LOCAL_MODEL_DEEP, LOCAL_MODEL_EMBED]);

function normalizeBaseUrl(value: unknown): string {
  return String(value || '').replace(/\/+$/, '');
}

function getBaseUrl(options: { baseUrl?: string } = {}): string {
  return normalizeBaseUrl(options.baseUrl || env.LOCAL_LLM_CHAT_BASE_URL || env.OLLAMA_BASE_URL || env.LOCAL_LLM_BASE_URL || '');
}

function getEmbeddingsBaseUrl(options: { baseUrl?: string } = {}): string {
  const raw = normalizeBaseUrl(options.baseUrl || process.env.EMBED_URL || env.LOCAL_LLM_BASE_URL || env.LOCAL_LLM_CHAT_BASE_URL || '');
  return raw.replace(/\/v1\/embeddings$/i, '');
}

function getEmbeddingsUrl(options: { baseUrl?: string } = {}): string {
  const baseUrl = getEmbeddingsBaseUrl(options);
  return baseUrl ? `${baseUrl}/v1/embeddings` : '';
}

function execCurlJson(url: string, options: RequestOptions = {}, timeoutMs = 3000): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const headers = options.headers || {};
    const args = ['-sS', '-m', String(Math.max(1, Math.ceil(timeoutMs / 1000)))];
    for (const [key, value] of Object.entries(headers)) {
      args.push('-H', `${key}: ${value}`);
    }
    if (options.method) args.push('-X', String(options.method));
    if (options.body) args.push('-d', String(options.body));
    args.push(url);

    execFile('curl', args, { maxBuffer: 5 * 1024 * 1024 }, (error: Error | null, stdout: string) => {
      if (error) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(stdout) as Record<string, unknown>);
      } catch {
        resolve(null);
      }
    });
  });
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
      if (!aborted && attempt === maxAttempts) {
        const curlJson = await execCurlJson(url, options, timeoutMs);
        if (curlJson) return curlJson;
      }
      if (!retryable) return null;
    } finally {
      clearTimeout(timer);
    }

    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }

  return null;
}

async function getAvailableModels(options: { baseUrl?: string } = {}): Promise<string[]> {
  const json = await requestJson('/v1/models', { baseUrl: options.baseUrl }) as ModelListResponse | null;
  if (!json?.data || !Array.isArray(json.data)) return [];
  const models = json.data.map((item) => item.id).filter(Boolean) as string[];
  const baseUrl = getBaseUrl(options);
  if (/127\.0\.0\.1:11434|localhost:11434/.test(baseUrl)) {
    const hasExpectedMlxModel = models.some((model) => EXPECTED_MLX_MODELS.has(model));
    if (!hasExpectedMlxModel && models.length > 0) {
      console.warn(`[local-llm-client] MLX endpoint mismatch on ${baseUrl}: ${models.join(', ')}`);
      return [];
    }
  }
  return models;
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

async function resolveRequestedModel(model: string, options: { baseUrl?: string } = {}): Promise<string> {
  const models = await getAvailableModels({ baseUrl: options.baseUrl });
  if (models.length === 0 || models.includes(model)) return model;

  const preferLarge = model === LOCAL_MODEL_DEEP || /deepseek|32b|70b|reason/i.test(model);
  const remapped = pickGemmaModel(models, preferLarge) || models[0];
  if (remapped && remapped !== model) {
    console.warn(`[local-llm-client] model '${model}' 없음 → '${remapped}' 사용`);
    return remapped;
  }
  return model;
}

async function resolveEmbeddingModel(model = LOCAL_MODEL_EMBED, options: { baseUrl?: string } = {}): Promise<string> {
  const baseUrl = getEmbeddingsBaseUrl(options);
  const models = await getAvailableModels({ baseUrl });
  const requestedLooksLikeEmbed = /embed/i.test(model);
  if (models.length === 0) {
    if (!requestedLooksLikeEmbed && LOCAL_MODEL_EMBED !== model) {
      console.warn(`[local-llm-client] embedding model '${model}' 부적합 → 기본 embedding 모델 '${LOCAL_MODEL_EMBED}' 사용`);
      return LOCAL_MODEL_EMBED;
    }
    return requestedLooksLikeEmbed ? model : LOCAL_MODEL_EMBED;
  }

  const hasRequestedModel = models.includes(model);
  if (hasRequestedModel && requestedLooksLikeEmbed) return model;

  const remapped = models.find((candidate) => /embed/i.test(candidate)) || null;
  if (remapped) {
    if (remapped !== model) {
      console.warn(`[local-llm-client] embedding model '${model}' 없음/부적합 → '${remapped}' 사용`);
    }
    return remapped;
  }

  throw new Error(`지원되는 embedding 모델 없음: requested='${model}', available='${models.join(', ')}'`);
}

async function isLocalLLMAvailable(options: { baseUrl?: string } = {}): Promise<boolean> {
  const models = await getAvailableModels({ baseUrl: options.baseUrl });
  return models.length > 0;
}

async function callLocalLLM(model: string, messages: unknown[], options: RequestOptions = {}): Promise<string | null> {
  const baseUrl = getBaseUrl(options);
  const cb = require('./local-circuit-breaker');

  // Circuit open → 즉시 null 반환 (대기 없음)
  if (cb.isCircuitOpen(baseUrl)) {
    console.warn(`[local-llm-client] circuit OPEN, skip (${baseUrl})`);
    return null;
  }

  // 빠른 헬스 체크 (3s timeout) — Ollama 다운 시 90s hang 방지
  const available = await isLocalLLMAvailable({ baseUrl });
  if (!available) {
    cb.recordFailure(baseUrl);
    return null;
  }

  const resolvedModel = await resolveRequestedModel(model, { baseUrl });
  const timeoutMs = Number(options.timeoutMs || ((model === LOCAL_MODEL_DEEP || resolvedModel === LOCAL_MODEL_DEEP) ? 120000 : 30000));

  await llmSemaphore.acquire();
  try {
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

    const result = json?.choices?.[0]?.message?.content || null;
    if (result) {
      cb.recordSuccess(baseUrl);
    } else {
      cb.recordFailure(baseUrl);
    }
    return result;
  } catch (err) {
    cb.recordFailure(baseUrl);
    throw err;
  } finally {
    llmSemaphore.release();
  }
}

function cleanLocalLLMText(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/think>/gi, '')
    .replace(/```json/gi, '```')
    .trim();
}

function tryParseLocalLLMJSON(text: string): unknown | null {
  const cleaned = cleanLocalLLMText(text);
  if (!cleaned) return null;

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

async function callLocalLLMJSON(model: string, messages: unknown[], options: RequestOptions = {}): Promise<unknown | null> {
  const maxJsonAttempts = Math.max(
    1,
    Number(options.jsonAttempts || ((model === LOCAL_MODEL_DEEP || /deepseek|32b|70b|reason/i.test(model)) ? 2 : 1)),
  );

  for (let attempt = 1; attempt <= maxJsonAttempts; attempt++) {
    const text = await callLocalLLM(model, messages, options);
    if (!text) {
      if (attempt === maxJsonAttempts) return null;
      continue;
    }

    const parsed = tryParseLocalLLMJSON(text);
    if (parsed == null) {
      console.warn(`[local-llm-client] JSON parse failed for model '${model}'${attempt < maxJsonAttempts ? ` → 재시도 ${attempt}/${maxJsonAttempts - 1}` : ''}`);
      if (attempt === maxJsonAttempts) return null;
      continue;
    }

    if (typeof options.validateResult === 'function' && !options.validateResult(parsed)) {
      console.warn(`[local-llm-client] JSON validation failed for model '${model}'${attempt < maxJsonAttempts ? ` → 재시도 ${attempt}/${maxJsonAttempts - 1}` : ''}`);
      if (attempt === maxJsonAttempts) return null;
      continue;
    }

    return parsed;
  }

  return null;
}

type HealthCheckOptions = {
  baseUrl?: string;
  timeoutMs?: number;
};

type LLMHealthStatus = {
  available: boolean;
  models: string[];
  fastModelOk: boolean;
  embedModelOk: boolean;
  responseMs: number | null;
  error?: string;
};

async function checkLocalLLMHealth(options: HealthCheckOptions = {}): Promise<LLMHealthStatus> {
  const start = Date.now();
  const baseUrl = getBaseUrl(options);
  const timeoutMs = Number(options.timeoutMs || 5000);
  try {
    const models = await getAvailableModels({ baseUrl });
    if (!models.length) {
      return { available: false, models: [], fastModelOk: false, embedModelOk: false, responseMs: Date.now() - start, error: 'local 모델 없음' };
    }

    const fastModelOk = models.some((m) => m === LOCAL_MODEL_FAST || /qwen/i.test(m) || /gemma/i.test(m));
    const embedModelOk = models.some((m) => /embed/i.test(m) || m === LOCAL_MODEL_EMBED);

    // 빠른 inference 테스트 (최대 5초)
    const testResult = await callLocalLLM(LOCAL_MODEL_FAST, [
      { role: 'user', content: '1+1=?' },
    ], { baseUrl, maxTokens: 8, timeoutMs });

    return {
      available: true,
      models,
      fastModelOk,
      embedModelOk,
      responseMs: Date.now() - start,
      error: testResult === null ? '추론 테스트 실패 (응답 없음)' : undefined,
    };
  } catch (err: unknown) {
    return {
      available: false,
      models: [],
      fastModelOk: false,
      embedModelOk: false,
      responseMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export = {
  LOCAL_MODEL_FAST,
  LOCAL_MODEL_DEEP,
  LOCAL_MODEL_EMBED,
  getBaseUrl,
  getEmbeddingsUrl,
  getAvailableModels,
  isLocalLLMAvailable,
  checkLocalLLMHealth,
  resolveEmbeddingModel,
  callLocalLLM,
  callLocalLLMJSON,
};
