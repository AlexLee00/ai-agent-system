'use strict';

/**
 * lib/jay-model-policy.js
 *
 * 제이의 모델 적용 정책을 한 곳에서 정의한다.
 *
 * 중요:
 * - OpenClaw gateway 기본 모델은 ~/.openclaw/openclaw.json 에서 관리된다.
 * - 이 파일은 제이 애플리케이션 레벨의 커스텀 라우팅 정책만 다룬다.
 */

const JAY_OPENCLAW_GATEWAY_PRIMARY = 'google-gemini-cli/gemini-2.5-flash';

const JAY_INTENT_PARSE_POLICY = {
  primary: {
    provider: 'openai',
    model: 'gpt-5-mini',
  },
  fallback: {
    provider: 'google',
    model: 'gemini-2.5-flash',
  },
};

function buildJayChatFallbackChain() {
  return [
    { provider: 'groq', model: 'openai/gpt-oss-20b', maxTokens: 300, temperature: 0.5 },
    { provider: 'gemini', model: 'google-gemini-cli/gemini-2.5-flash', maxTokens: 300, temperature: 0.7 },
  ];
}

module.exports = {
  JAY_OPENCLAW_GATEWAY_PRIMARY,
  JAY_INTENT_PARSE_POLICY,
  buildJayChatFallbackChain,
};
