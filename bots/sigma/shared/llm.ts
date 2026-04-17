// @ts-nocheck
/**
 * bots/sigma/shared/llm.ts — 하위 호환 래퍼
 *
 * 루나 bots/investment/shared/llm.ts 패턴 차용.
 * 메인 클라이언트: llm-client.ts
 */

export { callLLM, parseJSON, HAIKU_MODEL, SONNET_MODEL, OPUS_MODEL } from './llm-client.ts';

export async function callHaiku(systemPrompt: string, userPrompt: string, caller = 'sigma', maxTokens = 512) {
  const { callLLM: _callLLM } = await import('./llm-client.ts');
  return _callLLM(caller, systemPrompt, userPrompt, maxTokens, { forceModel: 'anthropic_haiku' });
}

export async function callSonnet(systemPrompt: string, userPrompt: string, caller = 'sigma', maxTokens = 1024) {
  const { callLLM: _callLLM } = await import('./llm-client.ts');
  return _callLLM(caller, systemPrompt, userPrompt, maxTokens, { forceModel: 'anthropic_sonnet' });
}

export async function callOpus(systemPrompt: string, userPrompt: string, caller = 'sigma', maxTokens = 2048) {
  const { callLLM: _callLLM } = await import('./llm-client.ts');
  return _callLLM(caller, systemPrompt, userPrompt, maxTokens, { forceModel: 'anthropic_opus' });
}
