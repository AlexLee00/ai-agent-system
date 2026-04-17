// @ts-nocheck
/**
 * bots/sigma/shared/llm-client.ts — 시그마 LLM 게이트웨이
 *
 * 루나 패턴 (bots/investment/shared/llm-client.ts) 차용, 시그마 특화 축약.
 * 에이전트 이름(caller) → provider/model 선택 + fallback + 비용 추적.
 *
 * 정책 소스: packages/core/lib/llm-model-selector.ts의 sigma.agent_policy
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

import { loadSecrets } from './secrets.ts';
import { trackTokens, checkBudget } from './cost-tracker.ts';

const { selectLLMPolicy } = require('../../../packages/core/lib/llm-model-selector.js');

let _LLM_TIMEOUTS: Record<string, number> = { groq: 5_000, haiku: 15_000, sonnet: 30_000, opus: 60_000, ollama: 30_000 };
try {
  _LLM_TIMEOUTS = require('../../../packages/core/lib/llm-timeouts.js').LLM_TIMEOUTS;
} catch { /* 기본값 유지 */ }

// ─── 모델 상수 (sigma.agent_policy 기본값) ───────────────────────────

const DEFAULT_SIGMA_POLICY = selectLLMPolicy('sigma.agent_policy', { agentName: 'commander' });

export const HAIKU_MODEL  = 'claude-haiku-4-5-20251001';
export const SONNET_MODEL = 'claude-sonnet-4-6';
export const OPUS_MODEL   = 'claude-opus-4-7';
export const OLLAMA_8B    = 'qwen2.5-7b';
export const OLLAMA_32B   = 'deepseek-r1-32b';

// ─── JSON 파싱 헬퍼 (루나 패턴) ──────────────────────────────────────

export function parseJSON(text: string): any {
  if (!text) return null;
  let clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const start = clean.search(/[\[{]/);
  const end   = Math.max(clean.lastIndexOf('}'), clean.lastIndexOf(']'));
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(clean.slice(start, end + 1)); } catch {}
  try { return JSON.parse(clean); } catch { return null; }
}

// ─── Anthropic 클라이언트 (지연 초기화) ─────────────────────────────

let _anthropic: any = null;

function getAnthropic() {
  if (_anthropic) return _anthropic;
  const mod = require('@anthropic-ai/sdk');
  const AnthropicClass = mod.default || mod;
  const apiKey = loadSecrets().anthropic_api_key;
  if (!apiKey) throw new Error('[sigma/llm] Anthropic API 키 없음 — secrets.json 또는 ANTHROPIC_API_KEY 설정 필요');
  _anthropic = new AnthropicClass({
    apiKey,
    timeout: _LLM_TIMEOUTS.sonnet,
    maxRetries: 2,
    defaultHeaders: { 'anthropic-beta': 'prompt-caching-2024-07-31' },
  });
  return _anthropic;
}

// ─── Anthropic 호출 ──────────────────────────────────────────────────

async function callAnthropic(
  agentName: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  model: string,
  options: any = {},
): Promise<string> {
  const client = getAnthropic();
  const timeoutMs = model.includes('opus') ? _LLM_TIMEOUTS.opus : _LLM_TIMEOUTS.sonnet;

  const response = await client.messages.create(
    {
      model,
      max_tokens: maxTokens,
      temperature: options.temperature ?? 0.1,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    },
    { timeout: timeoutMs },
  );

  const text = response.content?.[0]?.text || '';
  trackTokens({
    agent: agentName,
    model,
    provider: 'anthropic',
    tokens_in:  response.usage?.input_tokens  || 0,
    tokens_out: response.usage?.output_tokens || 0,
  });
  return text;
}

// ─── Ollama 호출 ─────────────────────────────────────────────────────

async function callOllama(
  agentName: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  model: string,
  options: any = {},
): Promise<string> {
  const url = `${loadSecrets().ollama_url}/v1/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), _LLM_TIMEOUTS.ollama);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature: options.temperature ?? 0.1,
      }),
    });
    const data = await res.json() as any;
    const text = data.choices?.[0]?.message?.content || '';
    trackTokens({
      agent: agentName,
      model,
      provider: 'ollama',
      tokens_in:  data.usage?.prompt_tokens     || 0,
      tokens_out: data.usage?.completion_tokens || 0,
    });
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ─── 통합 LLM 호출 ───────────────────────────────────────────────────

/**
 * @param agentName  'commander'|'pod.risk'|'skill.causal'|... (sigma.agent_policy 참조)
 * @param systemPrompt
 * @param userPrompt
 * @param maxTokens
 * @param options    { forceModel?, temperature? }
 */
export async function callLLM(
  agentName: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 1024,
  options: any = {},
): Promise<string> {
  // 예산 체크
  const budget = await checkBudget();
  if (!budget.ok) {
    console.error(`[sigma/llm] 일일 예산 초과 ($${budget.daily.toFixed(4)} / $${budget.limit})`);
    throw new Error('sigma.llm: 일일 LLM 예산 초과');
  }

  // 정책 조회
  const policy = selectLLMPolicy('sigma.agent_policy', { agentName });
  const chain: Array<{ provider: string; model: string }> =
    policy.fallbackChain || [policy.primary, ...(policy.fallbacks || [])].filter(Boolean);

  // forceModel 옵션 처리
  if (options.forceModel) {
    const forceModelMap: Record<string, string> = {
      anthropic_haiku:  HAIKU_MODEL,
      anthropic_sonnet: SONNET_MODEL,
      anthropic_opus:   OPUS_MODEL,
    };
    const model = forceModelMap[options.forceModel] || options.forceModel;
    return callAnthropic(agentName, systemPrompt, userPrompt, maxTokens, model, options);
  }

  // 체인 순서대로 시도
  let lastError: Error | null = null;
  for (const entry of chain) {
    try {
      if (entry.provider === 'anthropic') {
        return await callAnthropic(agentName, systemPrompt, userPrompt, maxTokens, entry.model, options);
      }
      if (entry.provider === 'local') {
        return await callOllama(agentName, systemPrompt, userPrompt, maxTokens, entry.model, options);
      }
    } catch (err: any) {
      console.warn(`[sigma/llm] ${agentName} → ${entry.provider}/${entry.model} 실패: ${err.message}`);
      lastError = err;
    }
  }

  throw lastError || new Error(`[sigma/llm] ${agentName}: 모든 폴백 실패`);
}
