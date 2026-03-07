/**
 * shared/llm-client.js — 통합 LLM 클라이언트 (Phase 3-A v2.3)
 *
 * 에이전트별 LLM 라우팅:
 *   - 성능 우선 (luna, nemesis, oracle, athena, zeus) → OpenAI gpt-4o
 *   - 속도 우선 (argos, hermes, sophia, 기타)         → Groq llama-4-scout (무료)
 *
 * Groq 라운드로빈 (다중 키, 429 시 자동 다음 키)
 */

import Anthropic    from '@anthropic-ai/sdk';
import Groq         from 'groq-sdk';
import OpenAI       from 'openai';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import yaml         from 'js-yaml';
import { tracker }  from './cost-tracker.js';

// CJS 토큰 트래커 (orchestrator 공용)
let _trackTokens = null;
try {
  const require = createRequire(import.meta.url);
  const tt = require('../../orchestrator/lib/token-tracker.js');
  _trackTokens = tt.trackTokens;
} catch {
  // 오케스트레이터 모듈 없는 환경에서는 무음 처리
}

// CJS 통합 로거 (packages/core 공용)
let _logLLMCall = null;
try {
  const require = createRequire(import.meta.url);
  const ll = require('../../../packages/core/lib/llm-logger.js');
  _logLLMCall = ll.logLLMCall;
} catch {
  // 로거 없는 환경에서는 무음 처리
}

// CJS 타임아웃 상수 로드
let _LLM_TIMEOUTS = null;
try {
  const require = createRequire(import.meta.url);
  _LLM_TIMEOUTS = require('../../../packages/core/lib/llm-timeouts.js').LLM_TIMEOUTS;
} catch {
  // 타임아웃 모듈 없으면 기본값 사용
  _LLM_TIMEOUTS = { groq: 5_000, haiku: 15_000, sonnet: 30_000, openai: 30_000 };
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 설정 로드 (config.yaml → secrets.json fallback) ─────────────────

let _cfg;
try {
  _cfg = yaml.load(readFileSync(join(__dirname, '..', 'config.yaml'), 'utf8'));
} catch {
  try {
    const s = JSON.parse(readFileSync(join(__dirname, '..', 'secrets.json'), 'utf8'));
    _cfg = {
      paper_mode: s.paper_mode,
      anthropic: { api_key: s.anthropic_api_key || '' },
      groq: { accounts: (s.groq_api_keys || [s.groq_api_key]).filter(Boolean).map(k => ({ api_key: k })) },
    };
  } catch {
    _cfg = { paper_mode: true, anthropic: { api_key: '' }, groq: { accounts: [] } };
  }
}

export const PAPER_MODE = process.env.PAPER_MODE !== 'false' && _cfg.paper_mode !== false;

// ─── 모델 상수 ───────────────────────────────────────────────────────

export const GROQ_SCOUT_MODEL  = 'meta-llama/llama-4-scout-17b-16e-instruct';
export const OPENAI_PERF_MODEL = _cfg.openai?.model || 'gpt-4o';
export const HAIKU_MODEL       = 'claude-haiku-4-5-20251001';

// 성능 우선 에이전트 — OpenAI gpt-4o 라우팅
const OPENAI_AGENTS = new Set(['luna', 'nemesis', 'oracle', 'athena', 'zeus']);

// ─── Groq 클라이언트 (라운드로빈) ────────────────────────────────────

const _groqAccounts = (_cfg.groq?.accounts || []).filter(a => a.api_key);
const _groqClients  = _groqAccounts.map(a => new Groq({ apiKey: a.api_key, timeout: _LLM_TIMEOUTS.groq, maxRetries: 1 }));
let   _groqIdx      = 0;

function nextGroqClient() {
  if (_groqClients.length === 0) throw new Error('Groq API 키 없음 — config.yaml groq.accounts 설정 필요');
  const client = _groqClients[_groqIdx % _groqClients.length];
  _groqIdx++;
  return client;
}

// ─── Anthropic 클라이언트 (지연 초기화) ─────────────────────────────

let _anthropic = null;
function getAnthropic() {
  if (_anthropic) return _anthropic;
  const apiKey = _cfg.anthropic?.api_key || '';
  if (!apiKey) throw new Error('Anthropic API 키 없음 — config.yaml anthropic.api_key 설정 필요');
  _anthropic = new Anthropic({
    apiKey,
    timeout:        _LLM_TIMEOUTS.sonnet,  // Sonnet 기본, Opus 호출 시 per-request 60s 오버라이드
    maxRetries:     2,
    defaultHeaders: { 'anthropic-beta': 'prompt-caching-2024-07-31' },
  });
  return _anthropic;
}

// ─── OpenAI 클라이언트 (지연 초기화) ─────────────────────────────────

let _openai = null;
function getOpenAI() {
  if (_openai) return _openai;
  const apiKey = _cfg.openai?.api_key || '';
  if (!apiKey) throw new Error('OpenAI API 키 없음 — config.yaml openai.api_key 설정 필요');
  _openai = new OpenAI({ apiKey, timeout: _LLM_TIMEOUTS.openai, maxRetries: 1 });
  return _openai;
}

// ─── JSON 파싱 헬퍼 ──────────────────────────────────────────────────

export function parseJSON(text) {
  if (!text) return null;
  let clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const start = clean.search(/[\[{]/);
  const end   = Math.max(clean.lastIndexOf('}'), clean.lastIndexOf(']'));
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(clean.slice(start, end + 1)); } catch {}
  try { return JSON.parse(clean); } catch { return null; }
}

// ─── 통합 LLM 호출 ───────────────────────────────────────────────────

/**
 * @param {string} agentName  'luna'|'nemesis'|'zeus'|'athena'|'oracle'|'hermes'|'sophia'
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {number} [maxTokens=512]
 * @returns {Promise<string>}  LLM 응답 텍스트
 */
export async function callLLM(agentName, systemPrompt, userPrompt, maxTokens = 512) {
  // 성능 우선 에이전트 → OpenAI gpt-4o
  if (OPENAI_AGENTS.has(agentName)) {
    return callOpenAI(agentName, systemPrompt, userPrompt, maxTokens);
  }
  // 속도 우선 에이전트 → Groq Scout
  return callGroq(agentName, systemPrompt, userPrompt, maxTokens);
}

async function callOpenAI(agentName, systemPrompt, userPrompt, maxTokens) {
  const t0 = Date.now();
  try {
    const openai = getOpenAI();
    const res    = await openai.chat.completions.create({
      model:           OPENAI_PERF_MODEL,
      max_tokens:      maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
    });
    const dur = Date.now() - t0;
    const inTok  = res.usage?.prompt_tokens     || 0;
    const outTok = res.usage?.completion_tokens || 0;
    _trackTokens?.({
      bot: agentName, team: 'investment', model: OPENAI_PERF_MODEL, provider: 'openai',
      taskType: 'trade_signal', tokensIn: inTok, tokensOut: outTok, durationMs: dur,
    });
    _logLLMCall?.({
      team: 'luna', bot: agentName, model: OPENAI_PERF_MODEL,
      requestType: 'trade_signal', inputTokens: inTok, outputTokens: outTok, latencyMs: dur,
    });
    return res.choices[0]?.message?.content || '';
  } catch (err) {
    // OpenAI 실패 시 Groq로 폴백
    console.warn(`  ⚠️ [${agentName}] OpenAI 실패 (${err.message?.slice(0,60)}) → Groq 폴백`);
    return callGroq(agentName, systemPrompt, userPrompt, maxTokens);
  }
}

async function callGroq(agentName, systemPrompt, userPrompt, maxTokens) {
  let lastErr;
  const maxAttempts = Math.max(_groqClients.length, 1);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const t0 = Date.now();
    try {
      const groq = nextGroqClient();
      const res  = await groq.chat.completions.create({
        model:           GROQ_SCOUT_MODEL,
        max_tokens:      maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   },
        ],
      });
      const dur    = Date.now() - t0;
      const inTok  = res.usage?.prompt_tokens     || 0;
      const outTok = res.usage?.completion_tokens || 0;
      _trackTokens?.({
        bot: agentName, team: 'investment', model: GROQ_SCOUT_MODEL, provider: 'groq',
        taskType: 'trade_signal', tokensIn: inTok, tokensOut: outTok, durationMs: dur,
      });
      _logLLMCall?.({
        team: 'luna', bot: agentName, model: GROQ_SCOUT_MODEL,
        requestType: 'trade_signal', inputTokens: inTok, outputTokens: outTok, latencyMs: dur,
      });
      return res.choices[0]?.message?.content || '';
    } catch (err) {
      if (err.status === 429) { lastErr = err; continue; }
      throw err;
    }
  }
  throw lastErr ?? new Error(`Groq 전체 키 rate limit — ${agentName}`);
}
