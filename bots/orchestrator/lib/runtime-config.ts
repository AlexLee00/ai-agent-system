'use strict';

const fs = require('fs') as typeof import('node:fs');
const path = require('path') as typeof import('node:path');
const { createRuntimeConfigLoader } = require('../../../packages/core/lib/runtime-config-loader') as {
  createRuntimeConfigLoader: (options: {
    fs: typeof import('node:fs');
    defaults: Record<string, unknown>;
    configPath: string;
  }) => {
    loadRuntimeConfig: () => {
      health: Record<string, unknown>;
      jayModels: Record<string, unknown>;
      llmSelectorOverrides?: Record<string, unknown>;
    };
  };
};

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
    gatewayPrimary: 'gemini-cli-oauth/gemini-2.5-flash',
    intentPrimary: 'gpt-5.4',
    intentFallback: 'gemini-cli-oauth/gemini-2.5-flash',
    chatFallbackChain: [
      { provider: 'groq', model: 'openai/gpt-oss-20b', maxTokens: 300, temperature: 0.5 },
      { provider: 'gemini-cli-oauth', model: 'gemini-cli-oauth/gemini-2.5-flash', maxTokens: 300, temperature: 0.7 },
    ],
  },
  llmSelectorOverrides: {
    'orchestrator.jay.intent': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4' },
      fallback: { provider: 'gemini-cli-oauth', model: 'gemini-cli-oauth/gemini-2.5-flash' },
    },
    'orchestrator.jay.chat_fallback': {
      chain: [
        { provider: 'groq', model: 'openai/gpt-oss-20b', maxTokens: 300, temperature: 0.5 },
        { provider: 'gemini-cli-oauth', model: 'gemini-cli-oauth/gemini-2.5-flash', maxTokens: 300, temperature: 0.7 },
      ],
    },
    'orchestrator.steward.digest': {
      chain: [
        { provider: 'gemini-cli-oauth', model: 'gemini-cli-oauth/gemini-2.5-flash-lite', maxTokens: 220, temperature: 0.1, timeoutMs: 20_000 },
      ],
    },
    'orchestrator.steward.work': {
      chain: [
        { provider: 'gemini-cli-oauth', model: 'gemini-cli-oauth/gemini-2.5-flash', maxTokens: 320, temperature: 0.2, timeoutMs: 30_000 },
        { provider: 'gemini-cli-oauth', model: 'gemini-cli-oauth/gemini-2.5-flash-lite', maxTokens: 320, temperature: 0.2, timeoutMs: 25_000 },
      ],
    },
    'orchestrator.steward.incident_plan': {
      chain: [
        { provider: 'gemini-cli-oauth', model: 'gemini-cli-oauth/gemini-2.5-flash', maxTokens: 700, temperature: 0.2, timeoutMs: 45_000 },
        { provider: 'gemini-cli-oauth', model: 'gemini-cli-oauth/gemini-2.5-flash-lite', maxTokens: 700, temperature: 0.2, timeoutMs: 30_000 },
      ],
    },
    'orchestrator.steward.pro_canary': {
      chain: [
        { provider: 'gemini-cli-oauth', model: 'gemini-cli-oauth/gemini-2.5-pro', maxTokens: 128, temperature: 0.2, timeoutMs: 60_000 },
      ],
    },
  },
  jayOrchestration: {
    commanderEnabled: false,
    hubPlanIntegration: false,
    incidentStoreEnabled: false,
    commanderDispatch: false,
    teamBusEnabled: false,
    threeTierTelegram: false,
    skillExtraction: false,
    sessionCompaction: false,
    incidentLoopIntervalMs: 5000,
    commanderDispatchLimit: 3,
  },
};

const { loadRuntimeConfig: loadOrchestratorRuntimeConfig } = createRuntimeConfigLoader({
  fs,
  defaults: DEFAULT_RUNTIME_CONFIG,
  configPath: path.join(__dirname, '..', 'config.json'),
});

function getOrchestratorHealthConfig(): Record<string, unknown> {
  return loadOrchestratorRuntimeConfig().health;
}

function getJayModelConfig(): Record<string, unknown> {
  return loadOrchestratorRuntimeConfig().jayModels;
}

function getLLMSelectorOverrides(): Record<string, unknown> {
  return loadOrchestratorRuntimeConfig().llmSelectorOverrides || {};
}

function getJayOrchestrationConfig(): Record<string, unknown> {
  return loadOrchestratorRuntimeConfig().jayOrchestration || {};
}

module.exports = {
  loadOrchestratorRuntimeConfig,
  getOrchestratorHealthConfig,
  getJayModelConfig,
  getLLMSelectorOverrides,
  getJayOrchestrationConfig,
};
