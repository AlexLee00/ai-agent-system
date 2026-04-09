'use strict';

const env = require('../../../packages/core/lib/env') as {
  PROJECT_ROOT: string;
};
const path = require('path') as typeof import('node:path');
const { getJayModelConfig, getLLMSelectorOverrides } = require(
  path.join(env.PROJECT_ROOT, 'bots/orchestrator/lib/runtime-config.js')
) as {
  getJayModelConfig: () => Record<string, any>;
  getLLMSelectorOverrides: () => Record<string, any>;
};
const { selectLLMPolicy, selectLLMChain } = require('../../../packages/core/lib/llm-model-selector') as {
  selectLLMPolicy: (key: string, options: Record<string, any>) => Record<string, any>;
  selectLLMChain: (key: string, options: Record<string, any>) => Array<Record<string, any>>;
};

function getGatewayPrimaryModel(): string {
  return getJayModelConfig().gatewayPrimary || 'google-gemini-cli/gemini-2.5-flash';
}

function buildIntentParsePolicy(): Record<string, any> {
  const config = getJayModelConfig();
  const selectorOverrides = getLLMSelectorOverrides();
  const legacyOverride = {
    primary: { provider: 'openai-oauth', model: config.intentPrimary || 'gpt-5.4' },
    fallback: { provider: 'gemini', model: config.intentFallback || 'gemini-2.5-flash' },
  };
  return selectLLMPolicy('orchestrator.jay.intent', {
    policyOverride: selectorOverrides['orchestrator.jay.intent'] || legacyOverride,
  });
}

function buildJayChatFallbackChain(): Array<Record<string, any>> {
  const config = getJayModelConfig();
  const selectorOverrides = getLLMSelectorOverrides();
  return selectLLMChain('orchestrator.jay.chat_fallback', {
    policyOverride: selectorOverrides['orchestrator.jay.chat_fallback'] || { chain: config.chatFallbackChain },
  });
}

module.exports = {
  getGatewayPrimaryModel,
  buildIntentParsePolicy,
  buildJayChatFallbackChain,
};
