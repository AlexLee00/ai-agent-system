/**
 * shared/llm.js — 하위 호환 래퍼 (deprecated → llm-client.js 사용)
 *
 * Phase 3-A v2.1부터 llm-client.js가 메인 LLM 클라이언트.
 * 이 파일은 "type":"module" 전환 후 ESM 오류 방지용으로 유지.
 */

export { callLLM, parseJSON, PAPER_MODE, GROQ_SCOUT_MODEL, HAIKU_MODEL } from './llm-client.js';

// callHaiku(system, user, caller, maxTokens) → callLLM(caller, system, user, maxTokens) 어댑터
export async function callHaiku(systemPrompt, userPrompt, caller = 'luna', maxTokens = 512) {
  const { callLLM: _callLLM } = await import('./llm-client.js');
  return _callLLM(caller, systemPrompt, userPrompt, maxTokens);
}

// callFreeLLM(system, user, model, caller, provider, maxTokens) → callLLM 어댑터
export async function callFreeLLM(systemPrompt, userPrompt, model, caller = 'hermes', provider = 'groq', maxTokens = 256) {
  const { callLLM: _callLLM } = await import('./llm-client.js');
  return _callLLM(caller, systemPrompt, userPrompt, maxTokens);
}
