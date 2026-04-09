'use strict';

const fs = require('fs');
const path = require('path');
const { createRuntimeConfigLoader } = require('../../../packages/core/lib/runtime-config-loader');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const DEFAULTS = {
  lead: {
    defaultPollMs: 2000,
    noTokenPollMs: 30000,
    telegramLongPollSeconds: 10,
    telegramRequestTimeoutMs: 15000,
  },
  health: {
    httpTimeoutMs: 5000,
  },
  n8n: {
    healthUrl: 'http://127.0.0.1:5678/healthz',
    workerWebhookUrl: 'http://127.0.0.1:5678/webhook/worker-chat-intake',
    healthTimeoutMs: 2500,
    webhookTimeoutMs: 5000,
  },
  llmSelectorOverrides: {
    'worker.ai.fallback': {
      providerModels: {
        groq: 'llama-4-scout-17b-16e-instruct',
        anthropic: 'claude-haiku-4-5-20251001',
        openai: 'gpt-4o-mini',
        gemini: 'gemini-2.5-flash',
      },
    },
    'worker.chat.task_intake': {
      chain: [
        { provider: 'groq', model: 'llama-4-scout-17b-16e-instruct', maxTokens: 250, temperature: 0.1 },
        { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens: 250, temperature: 0.1 },
      ],
    },
  },
};

const { loadRuntimeConfig } = createRuntimeConfigLoader({
  fs,
  defaults: DEFAULTS,
  configPath: CONFIG_PATH,
});

function getWorkerLeadRuntimeConfig() {
  return loadRuntimeConfig().lead;
}

function getWorkerHealthRuntimeConfig() {
  return loadRuntimeConfig().health;
}

function getWorkerN8nRuntimeConfig() {
  return loadRuntimeConfig().n8n;
}

function getWorkerLLMSelectorOverrides() {
  return loadRuntimeConfig().llmSelectorOverrides || {};
}

module.exports = {
  getWorkerLeadRuntimeConfig,
  getWorkerHealthRuntimeConfig,
  getWorkerN8nRuntimeConfig,
  getWorkerLLMSelectorOverrides,
};
