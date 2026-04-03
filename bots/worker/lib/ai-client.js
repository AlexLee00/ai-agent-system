'use strict';

/**
 * bots/worker/lib/ai-client.js — 워커팀 공용 LLM 호출 래퍼
 *
 * 워커팀도 공용 llm-fallback 체인을 사용해
 * 공급자 전환 / 비용 로깅 / 장애 폴백 정책을 같이 따른다.
 */

const path = require('path');
const { callWithFallback } = require(path.join(__dirname, '../../../packages/core/lib/llm-fallback'));
const {
  buildSingleChain,
  selectLLMChain,
} = require(path.join(__dirname, '../../../packages/core/lib/llm-model-selector'));
const {
  getWorkerMonitoringPreference,
  isProviderConfigured,
} = require('./llm-api-monitoring');
const { getWorkerLLMSelectorOverrides } = require('./runtime-config');

async function callLLM(model, system, user, maxTokens = 1024, logMeta = {}) {
  const result = await callWithFallback({
    chain: buildSingleChain(model, maxTokens, 0.1),
    systemPrompt: system,
    userPrompt: user,
    logMeta: { team: 'worker', purpose: 'assistant', bot: 'ai-client', requestType: 'ai_question', ...logMeta },
  });
  return result.text;
}

async function callLLMWithFallback(groqModel, system, user, maxTokens = 1024, logMeta = {}) {
  const forcedPreferredApi = String(logMeta?.preferredApi || '').trim().toLowerCase();
  const preferredApi = forcedPreferredApi || await getWorkerMonitoringPreference().catch(() => 'groq');
  const configuredProviders = ['groq', 'claude-code', 'anthropic', 'gemini', 'openai']
    .filter((provider) => isProviderConfigured(provider));
  const selectorOverrides = getWorkerLLMSelectorOverrides();
  const chain = selectLLMChain('worker.ai.fallback', {
    groqModel,
    preferredApi,
    configuredProviders,
    maxTokens,
    policyOverride: selectorOverrides['worker.ai.fallback'],
  });

  const result = await callWithFallback({
    chain,
    systemPrompt: system,
    userPrompt: user,
    logMeta: { team: 'worker', purpose: 'assistant', bot: 'ai-client', requestType: 'ai_question', preferredApi, ...logMeta },
  });
  const resolvedModel = String(result.model || '');
  const modelId = resolvedModel.startsWith(`${result.provider}/`)
    ? resolvedModel
    : `${result.provider}/${resolvedModel}`;
  return { text: result.text, model: modelId, preferredApi };
}

module.exports = { callLLM, callLLMWithFallback };
