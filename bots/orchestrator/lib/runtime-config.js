'use strict';

const fs = require('fs');
const path = require('path');
const { createRuntimeConfigLoader } = require('../../../packages/core/lib/runtime-config-loader');

const DEFAULT_RUNTIME_CONFIG = {
  health: {
    n8nHealthUrl: 'http://127.0.0.1:5678/healthz',
    criticalWebhookUrl: 'http://127.0.0.1:5678/webhook/critical',
    httpTimeoutMs: 2500,
    webhookTimeoutMs: 5000,
    payloadWarningWithinHours: 24,
    payloadWarningLimit: 50,
  },
  jayModels: {
    gatewayPrimary: 'google-gemini-cli/gemini-2.5-flash',
    intentPrimary: 'gpt-5.4',
    intentFallback: 'gemini-2.5-flash',
    chatFallbackChain: [
      { provider: 'groq', model: 'openai/gpt-oss-20b', maxTokens: 300, temperature: 0.5 },
      { provider: 'gemini', model: 'google-gemini-cli/gemini-2.5-flash', maxTokens: 300, temperature: 0.7 },
    ],
  },
  llmSelectorOverrides: {
    'orchestrator.jay.intent': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4' },
      fallback: { provider: 'gemini', model: 'gemini-2.5-flash' },
    },
    'orchestrator.jay.chat_fallback': {
      chain: [
        { provider: 'groq', model: 'openai/gpt-oss-20b', maxTokens: 300, temperature: 0.5 },
        { provider: 'gemini', model: 'google-gemini-cli/gemini-2.5-flash', maxTokens: 300, temperature: 0.7 },
      ],
    },
  },
};

const { loadRuntimeConfig: loadOrchestratorRuntimeConfig } = createRuntimeConfigLoader({
  fs,
  defaults: DEFAULT_RUNTIME_CONFIG,
  configPath: path.join(__dirname, '..', 'config.json'),
});

function getOrchestratorHealthConfig() {
  return loadOrchestratorRuntimeConfig().health;
}

function getJayModelConfig() {
  return loadOrchestratorRuntimeConfig().jayModels;
}

function getLLMSelectorOverrides() {
  return loadOrchestratorRuntimeConfig().llmSelectorOverrides || {};
}

module.exports = {
  loadOrchestratorRuntimeConfig,
  getOrchestratorHealthConfig,
  getJayModelConfig,
  getLLMSelectorOverrides,
};
