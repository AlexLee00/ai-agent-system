'use strict';

const { getJayModelConfig } = require('./runtime-config');
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
  return selectLLMPolicy('orchestrator.jay.intent', {
    intentPrimary: config.intentPrimary,
    intentFallback: config.intentFallback,
  });
}

function buildJayChatFallbackChain() {
  const config = getJayModelConfig();
  return selectLLMChain('orchestrator.jay.chat_fallback', {
    chatFallbackChain: config.chatFallbackChain,
  });
}

module.exports = {
  getGatewayPrimaryModel,
  buildIntentParsePolicy,
  buildJayChatFallbackChain,
};
