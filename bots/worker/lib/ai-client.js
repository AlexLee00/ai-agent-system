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
  getWorkerMonitoringPreference,
  isProviderConfigured,
} = require('./llm-api-monitoring');

function buildSingleChain(model, maxTokens) {
  if (model.startsWith('groq/')) {
    return [{ provider: 'groq', model, maxTokens, temperature: 0.1 }];
  }
  if (model.startsWith('claude-')) {
    return [{ provider: 'anthropic', model, maxTokens, temperature: 0.1 }];
  }
  if (model.startsWith('gpt-') || model.startsWith('o')) {
    return [{ provider: 'openai', model, maxTokens, temperature: 0.1 }];
  }
  if (model.startsWith('gemini-') || model.startsWith('google-gemini-cli/')) {
    return [{ provider: 'gemini', model, maxTokens, temperature: 0.1 }];
  }
  return [{ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens, temperature: 0.1 }];
}

async function callLLM(model, system, user, maxTokens = 1024, logMeta = {}) {
  const result = await callWithFallback({
    chain: buildSingleChain(model, maxTokens),
    systemPrompt: system,
    userPrompt: user,
    logMeta: { team: 'worker', bot: 'ai-client', requestType: 'ai_question', ...logMeta },
  });
  return result.text;
}

async function callLLMWithFallback(groqModel, system, user, maxTokens = 1024, logMeta = {}) {
  const preferredApi = await getWorkerMonitoringPreference().catch(() => 'groq');
  const primaryChain = [];

  if (preferredApi === 'anthropic' && isProviderConfigured('anthropic')) {
    primaryChain.push({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens, temperature: 0.1 });
  } else if (preferredApi === 'openai' && isProviderConfigured('openai')) {
    primaryChain.push({ provider: 'openai', model: 'gpt-4o-mini', maxTokens, temperature: 0.1 });
  } else if (preferredApi === 'gemini' && isProviderConfigured('gemini')) {
    primaryChain.push({ provider: 'gemini', model: 'gemini-2.5-flash', maxTokens, temperature: 0.1 });
  } else if (isProviderConfigured('groq')) {
    primaryChain.push({ provider: 'groq', model: `groq/${groqModel}`, maxTokens, temperature: 0.1 });
  }

  const fallbackChain = [
    { provider: 'groq', model: `groq/${groqModel}`, maxTokens, temperature: 0.1 },
    { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens, temperature: 0.1 },
    { provider: 'gemini', model: 'gemini-2.5-flash', maxTokens, temperature: 0.1 },
    { provider: 'openai', model: 'gpt-4o-mini', maxTokens, temperature: 0.1 },
  ].filter((entry, index, array) => {
    const configured = isProviderConfigured(entry.provider);
    if (!configured) return false;
    return array.findIndex((candidate) => candidate.provider === entry.provider) === index;
  });

  const chain = [...primaryChain];
  for (const entry of fallbackChain) {
    if (!chain.some((candidate) => candidate.provider === entry.provider)) {
      chain.push(entry);
    }
  }

  const result = await callWithFallback({
    chain: chain.length ? chain : [
      { provider: 'groq', model: `groq/${groqModel}`, maxTokens, temperature: 0.1 },
      { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens, temperature: 0.1 },
    ],
    systemPrompt: system,
    userPrompt: user,
    logMeta: { team: 'worker', bot: 'ai-client', requestType: 'ai_question', preferredApi, ...logMeta },
  });
  return { text: result.text, model: `${result.provider}/${result.model}`, preferredApi };
}

module.exports = { callLLM, callLLMWithFallback };
