// @ts-nocheck
/**
 * bots/sigma/shared/llm-client.ts — 시그마 LLM 게이트웨이
 *
 * 에이전트 이름(caller) → Hub selector → provider/model 선택 + fallback.
 *
 * 정책 소스: Hub /hub/llm/call + packages/core/lib/llm-model-selector.ts의 sigma.agent_policy
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

import { checkBudget } from './cost-tracker.ts';

const { callHubLlm } = require('../../../packages/core/lib/hub-client');

// ─── 모델 상수 (sigma.agent_policy 기본값) ───────────────────────────

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

function normalizeForceAgent(agentName: string, forceModel: string | null | undefined): string {
  const force = String(forceModel || '').trim();
  if (force === 'anthropic_haiku') return 'pod.growth';
  if (force === 'anthropic_opus') return 'principle.self_critique';
  if (force === 'anthropic_sonnet') return agentName || 'commander';
  return agentName || 'commander';
}

function normalizeAbstractModel(forceModel: string | null | undefined): 'anthropic_haiku' | 'anthropic_sonnet' | 'anthropic_opus' {
  const force = String(forceModel || '').trim();
  if (force === 'anthropic_haiku' || force.includes('haiku')) return 'anthropic_haiku';
  if (force === 'anthropic_opus' || force.includes('opus')) return 'anthropic_opus';
  return 'anthropic_sonnet';
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

  const selectorAgent = normalizeForceAgent(agentName, options.forceModel);
  const result = await callHubLlm({
    callerTeam: 'sigma',
    agent: selectorAgent,
    selectorKey: 'sigma.agent_policy',
    taskType: options.taskType || 'sigma_analysis',
    abstractModel: normalizeAbstractModel(options.forceModel),
    systemPrompt,
    prompt: userPrompt,
    maxTokens,
    timeoutMs: options.timeoutMs || 60000,
    maxBudgetUsd: options.maxBudgetUsd || 0.05,
  });
  return result.text;
}
