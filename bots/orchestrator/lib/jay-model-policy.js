'use strict';

const { getJayModelConfig, getLLMSelectorOverrides } = require('./runtime-config');
const { selectLLMPolicy, selectLLMChain } = require('../../../packages/core/lib/llm-model-selector');

/**
 * lib/jay-model-policy.js
 *
 * 제이의 모델 적용 정책을 한 곳에서 정의한다.
 *
 * 중요:
 * - OpenClaw gateway 기본 모델은 ~/.openclaw/openclaw.json 에서 관리된다.
 * - 이 파일은 제이 애플리케이션 레벨의 커스텀 라우팅 정책만 다룬다.
 */

function getGatewayPrimaryModel() {
  return getJayModelConfig().gatewayPrimary || 'google-gemini-cli/gemini-2.5-flash';
}

function buildIntentParsePolicy() {
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

function buildJayChatFallbackChain() {
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
