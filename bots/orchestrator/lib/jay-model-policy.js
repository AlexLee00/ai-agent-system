'use strict';

const { getJayModelConfig } = require('./runtime-config');

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
  return {
    primary: {
      provider: 'openai',
      model: config.intentPrimary || 'gpt-5-mini',
    },
    fallback: {
      provider: 'google',
      model: config.intentFallback || 'gemini-2.5-flash',
    },
  };
}

function buildJayChatFallbackChain() {
  const config = getJayModelConfig();
  if (Array.isArray(config.chatFallbackChain) && config.chatFallbackChain.length > 0) {
    return config.chatFallbackChain.map((item) => ({
      provider: item.provider,
      model: item.model,
      maxTokens: item.maxTokens ?? 300,
      temperature: item.temperature ?? 0.5,
    }));
  }
  return [
    { provider: 'groq', model: 'openai/gpt-oss-20b', maxTokens: 300, temperature: 0.5 },
    { provider: 'gemini', model: 'google-gemini-cli/gemini-2.5-flash', maxTokens: 300, temperature: 0.7 },
  ];
}

module.exports = {
  getGatewayPrimaryModel,
  buildIntentParsePolicy,
  buildJayChatFallbackChain,
};
