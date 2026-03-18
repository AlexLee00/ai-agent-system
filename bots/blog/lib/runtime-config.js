'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const DEFAULTS = {
  health: {
    nodeServerHealthUrl: 'http://127.0.0.1:3100/health',
    n8nHealthUrl: 'http://127.0.0.1:5678/healthz',
    blogWebhookUrl: 'http://127.0.0.1:5678/webhook/blog-pipeline',
    nodeServerTimeoutMs: 3000,
    n8nHealthTimeoutMs: 2500,
    webhookTimeoutMs: 5000,
    dailyLogStaleMs: 36 * 60 * 60 * 1000,
  },
  generation: {
    gemsMinChars: 8000,
    posMinChars: 7000,
    continueMaxTokens: 8000,
    writerMaxRetries: 1,
    maestroWebhookTimeoutMs: 180000,
    maestroHealthTimeoutMs: 2500,
    maestroCircuitCooldownMs: 30 * 60 * 1000,
  },
  llmSelectorOverrides: {
    'blog.pos.writer': {
      chain: [
        { provider: 'openai', model: 'gpt-4o', maxTokens: 16000, temperature: 0.82 },
        { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 16000, temperature: 0.82 },
        { provider: 'gemini', model: 'google-gemini-cli/gemini-2.5-flash', maxTokens: 12000, temperature: 0.75 },
      ],
    },
    'blog.gems.writer': {
      chain: [
        { provider: 'openai', model: 'gpt-4o', maxTokens: 16000, temperature: 0.85 },
        { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 16000, temperature: 0.85 },
        { provider: 'gemini', model: 'google-gemini-cli/gemini-2.5-flash', maxTokens: 12000, temperature: 0.75 },
      ],
    },
    'blog.social.summarize': {
      chain: [
        { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 1024, temperature: 0.1 },
      ],
    },
    'blog.social.caption': {
      chain: [
        { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 1024, temperature: 0.1 },
      ],
    },
    'blog.star.summarize': {
      chain: [
        { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 1024, temperature: 0.1 },
        { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 1024, temperature: 0.1 },
      ],
    },
    'blog.star.caption': {
      chain: [
        { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 1024, temperature: 0.1 },
        { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 1024, temperature: 0.1 },
      ],
    },
    'blog.curriculum.recommend': {
      chain: [
        { provider: 'openai', model: 'gpt-4o', maxTokens: 2000, temperature: 0.7 },
        { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 2000, temperature: 0.7 },
      ],
    },
    'blog.curriculum.generate': {
      chain: [
        { provider: 'openai', model: 'gpt-4o', maxTokens: 8000, temperature: 0.5 },
      ],
    },
  },
};

function mergeDeep(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const next = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      next[key] = mergeDeep(base[key], value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

function loadRuntimeConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return mergeDeep(DEFAULTS, parsed.runtime_config || {});
  } catch {
    return DEFAULTS;
  }
}

function getBlogHealthRuntimeConfig() {
  return loadRuntimeConfig().health;
}

function getBlogGenerationRuntimeConfig() {
  return loadRuntimeConfig().generation;
}

function getBlogLLMSelectorOverrides() {
  return loadRuntimeConfig().llmSelectorOverrides || {};
}

module.exports = {
  getBlogHealthRuntimeConfig,
  getBlogGenerationRuntimeConfig,
  getBlogLLMSelectorOverrides,
};
