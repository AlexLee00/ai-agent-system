'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const { callWithFallback } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/llm-fallback'));
const { initHubConfig } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/llm-keys'));

let _initialized = false;

async function ensureInit() {
  if (!_initialized) {
    await initHubConfig();
    _initialized = true;
  }
}

// 저스틴팀 표준 LLM 폴백 체인
// Primary: Claude Code OAuth (구독 활용, Anthropic API 크레딧 절약)
//   - 헤드리스 환경에서 실패 시 빠른 폴백 위해 timeoutMs: 10000
// Fallback 1: Anthropic API (OAuth 장애 시)
// Fallback 2: Groq (빠른 속도)
// Fallback 3: Local Ollama (완전 오프라인 안전망)
const LEGAL_CHAIN = [
  { provider: 'claude-code', model: 'sonnet', maxTokens: 8192, temperature: 0.1, timeoutMs: 10000 },
  { provider: 'anthropic', model: 'claude-sonnet-4-6', maxTokens: 8192, temperature: 0.1 },
  { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 4096, temperature: 0.1 },
  { provider: 'local', model: 'deepseek-r1-32b', maxTokens: 4096, temperature: 0.1 },
];

function stripThinkTags(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

async function callLegal({ systemPrompt, userPrompt, agent, requestType, maxTokens = 8192 }) {
  await ensureInit();
  const chain = LEGAL_CHAIN.map(e => ({ ...e, maxTokens: Math.min(e.maxTokens, maxTokens) }));
  const result = await callWithFallback({
    chain,
    systemPrompt,
    userPrompt,
    logMeta: { team: 'legal', bot: agent, requestType },
  });
  if (result && result.text) result.text = stripThinkTags(result.text);
  return result;
}

module.exports = { callLegal };
