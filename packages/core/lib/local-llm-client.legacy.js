'use strict';

const env = require('./env');
const { execFile } = require('node:child_process');

const LOCAL_MODEL_FAST = process.env.LOCAL_MODEL_FAST || 'qwen2.5-7b';
const LOCAL_MODEL_DEEP = process.env.LOCAL_MODEL_DEEP || 'deepseek-r1-32b';
const LOCAL_MODEL_EMBED = process.env.EMBED_MODEL || 'qwen3-embed-0.6b';
const LOCAL_RETRYABLE_STATUS = new Set([404, 500, 502, 503, 504]);
const EXPECTED_MLX_MODELS = new Set([LOCAL_MODEL_FAST, LOCAL_MODEL_DEEP, LOCAL_MODEL_EMBED]);

function normalizeBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function getBaseUrl(options = {}) {
  return normalizeBaseUrl(options.baseUrl || env.LOCAL_LLM_BASE_URL || '');
}

function getEmbeddingsUrl(options = {}) {
  const baseUrl = getBaseUrl(options);
  return baseUrl ? `${baseUrl}/v1/embeddings` : '';
}

function execCurlJson(url, options = {}, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const headers = options.headers || {};
    const args = ['-sS', '-m', String(Math.max(1, Math.ceil(timeoutMs / 1000)))];
    for (const [key, value] of Object.entries(headers)) {
      args.push('-H', `${key}: ${value}`);
    }
    if (options.method) args.push('-X', String(options.method));
    if (options.body) args.push('-d', String(options.body));
    args.push(url);

    execFile('curl', args, { maxBuffer: 5 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

async function requestJson(path, options = {}, timeoutMs = 3000) {
  const baseUrl = getBaseUrl(options);
  if (!baseUrl) return null;

  const url = `${baseUrl}${path}`;
  const maxAttempts = options.maxAttempts || (path === '/v1/chat/completions' ? 3 : 1);

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
        return await res.json();
      }
    } catch (err) {
      const aborted = err.name === 'AbortError';
      const retryable = attempt < maxAttempts;
      const message = aborted ? '타임아웃' : err.message;
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

async function getAvailableModels() {
  const json = await requestJson('/v1/models');
  if (!json?.data || !Array.isArray(json.data)) return [];
  const models = json.data.map((item) => item.id).filter(Boolean);
  const baseUrl = getBaseUrl();
  if (/127\.0\.0\.1:11434|localhost:11434/.test(baseUrl)) {
    const hasExpectedMlxModel = models.some((model) => EXPECTED_MLX_MODELS.has(model));
    if (!hasExpectedMlxModel && models.length > 0) {
      console.warn(`[local-llm-client] MLX endpoint mismatch on ${baseUrl}: ${models.join(', ')}`);
      return [];
    }
  }
  return models;
}

function pickGemmaModel(models, preferLarge = false) {
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

async function resolveRequestedModel(model) {
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

async function resolveEmbeddingModel(model = LOCAL_MODEL_EMBED) {
  const models = await getAvailableModels();
  if (models.length === 0 || models.includes(model)) return model;

  const remapped = models.find((candidate) => /embed/i.test(candidate))
    || models.find((candidate) => /qwen/i.test(candidate))
    || models[0];
  if (remapped && remapped !== model) {
    console.warn(`[local-llm-client] embedding model '${model}' 없음 → '${remapped}' 사용`);
    return remapped;
  }
  return model;
}

async function isLocalLLMAvailable() {
  const models = await getAvailableModels();
  return models.length > 0;
}

async function callLocalLLM(model, messages, options = {}) {
  const resolvedModel = await resolveRequestedModel(model);
  const timeoutMs = options.timeoutMs
    || ((model === LOCAL_MODEL_DEEP || resolvedModel === LOCAL_MODEL_DEEP) ? 120000 : 30000);

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
  }, timeoutMs);

  return json?.choices?.[0]?.message?.content || null;
}

async function callLocalLLMJSON(model, messages, options = {}) {
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

    const candidate = cleaned.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
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

module.exports = {
  LOCAL_MODEL_FAST,
  LOCAL_MODEL_DEEP,
  LOCAL_MODEL_EMBED,
  getBaseUrl,
  getEmbeddingsUrl,
  getAvailableModels,
  isLocalLLMAvailable,
  resolveEmbeddingModel,
  callLocalLLM,
  callLocalLLMJSON,
};
