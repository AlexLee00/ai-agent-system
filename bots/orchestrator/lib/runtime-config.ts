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
    httpTimeoutMs: 2500,
    payloadWarningWithinHours: 24,
    payloadWarningLimit: 50,
  },
  jayModels: {
    gatewayPrimary: 'openai-oauth/gpt-5.4-mini',
    intentPrimary: 'gpt-5.4',
    intentFallback: 'openai-oauth/gpt-5.4-mini',
    chatFallbackChain: [
      { provider: 'groq', model: 'openai/gpt-oss-20b', maxTokens: 300, temperature: 0.5 },
      { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 300, temperature: 0.3 },
    ],
  },
  llmSelectorOverrides: {
    'orchestrator.jay.intent': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4' },
      fallback: { provider: 'openai-oauth', model: 'gpt-5.4-mini' },
    },
    'orchestrator.jay.chat_fallback': {
      chain: [
        { provider: 'groq', model: 'openai/gpt-oss-20b', maxTokens: 300, temperature: 0.5 },
        { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 300, temperature: 0.3 },
      ],
    },
    'orchestrator.steward.digest': {
      chain: [
        { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 220, temperature: 0.1, timeoutMs: 20_000 },
      ],
    },
    'orchestrator.steward.work': {
      chain: [
        { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 320, temperature: 0.2, timeoutMs: 20_000 },
        { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 320, temperature: 0.2, timeoutMs: 25_000 },
      ],
    },
    'orchestrator.steward.incident_plan': {
      chain: [
        { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 700, temperature: 0.2, timeoutMs: 30_000 },
        { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 700, temperature: 0.2, timeoutMs: 30_000 },
      ],
    },
    'orchestrator.steward.pro_canary': {
      chain: [
        { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 128, temperature: 0.2, timeoutMs: 20_000 },
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
    growthEnabled: false,
    growthDisabledReason: 'master_decision:growth_pod_not_cutover',
    growthDecisionOwner: 'master',
    llmDailyBudgetUsd: 5.0,
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
