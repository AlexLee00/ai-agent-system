// @ts-nocheck
'use strict';

/**
 * bots/worker/lib/ai-client.js — 워커팀 공용 LLM 호출 래퍼
 *
 * 워커팀도 Hub LLM 경로를 사용해 공급자 전환 / 비용 로깅 / 장애 폴백
 * 정책을 한 곳에서 따른다.
 */

const path = require('path');
const { callHubLlm } = require(path.join(__dirname, '../../../packages/core/lib/hub-client'));
const {
  getWorkerMonitoringPreference,
  isProviderConfigured,
} = require('./llm-api-monitoring.ts');

async function callLLM(model, system, user, maxTokens = 1024, logMeta = {}) {
  const result = await callHubLlm({
    callerTeam: 'worker',
    agent: 'ai-fallback',
    selectorKey: 'worker.ai.fallback',
    taskType: logMeta.requestType || 'ai_question',
    abstractModel: 'anthropic_haiku',
    systemPrompt: system,
    prompt: user,
    maxTokens,
    groqModel: model,
    timeoutMs: 30000,
    maxBudgetUsd: 0.03,
  });
  return result.text;
}

async function callLLMWithFallback(groqModel, system, user, maxTokens = 1024, logMeta = {}) {
  const forcedPreferredApi = String(logMeta?.preferredApi || '').trim().toLowerCase();
  const preferredApi = forcedPreferredApi || await getWorkerMonitoringPreference().catch(() => 'groq');
  const configuredProviders = ['groq', 'claude-code', 'anthropic', 'gemini', 'openai']
    .filter((provider) => isProviderConfigured(provider));

  const result = await callHubLlm({
    callerTeam: 'worker',
    agent: 'ai-fallback',
    selectorKey: 'worker.ai.fallback',
    taskType: logMeta.requestType || 'ai_question',
    abstractModel: 'anthropic_haiku',
    systemPrompt: system,
    prompt: user,
    maxTokens,
    groqModel,
    preferredApi,
    configuredProviders,
    timeoutMs: 30000,
    maxBudgetUsd: 0.03,
  });
  const resolvedModel = String(result.model || result.selected_route || result.provider || 'hub');
  const provider = String(result.provider || '').replace(/-oauth$/, '');
  const modelId = resolvedModel === provider || resolvedModel.startsWith(`${provider}/`) || resolvedModel.includes('/')
    ? resolvedModel
    : `${provider}/${resolvedModel}`;
  return { text: result.text, model: modelId, preferredApi };
}

module.exports = { callLLM, callLLMWithFallback };
