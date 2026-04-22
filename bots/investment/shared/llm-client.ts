// @ts-nocheck
/**
 * shared/llm-client.js — 통합 LLM 클라이언트 (Phase 3-A v2.4)
 *
 * 에이전트별 LLM 라우팅:
 *   - 루나 전용    (luna)                    → OpenAI gpt-4o (판단 최고 품질)
 *   - Groq 경쟁   (nemesis, oracle)          → Groq dual model (gpt-oss-20b vs scout)
 *   - Mini 우선   (hermes, sophia, zeus, athena) → gpt-4o-mini 메인 + scout 폴백
 *   - 속도 우선   (argos, 기타)              → Groq llama-4-scout (무료)
 *
 * Groq 라운드로빈 (다중 키, 429 시 자동 다음 키)
 */

import { createHash }   from 'crypto';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import yaml         from 'js-yaml';
import { tracker }  from './cost-tracker.ts';
import { getTradingMode, getInvestmentGuardScope, initHubSecrets, loadSecrets } from './secrets.ts';
import { getInvestmentLLMPolicyConfig } from './runtime-config.ts';

// CJS 토큰 트래커 (orchestrator 공용)
let _trackTokens = null;
try {
  const require = createRequire(import.meta.url);
  const tt = require('../../../packages/core/lib/token-tracker.js');
  _trackTokens = tt.trackTokens;
} catch {
  // 오케스트레이터 모듈 없는 환경에서는 무음 처리
}

// CJS billing-guard (긴급 차단)
let _billingGuard = null;
try {
  const require = createRequire(import.meta.url);
  _billingGuard = require('../../../packages/core/lib/billing-guard');
} catch { /* 무음 처리 */ }

// CJS 통합 로거 (packages/core 공용)
let _logLLMCall = null;
try {
  const require = createRequire(import.meta.url);
  const ll = require('../../../packages/core/lib/llm-logger.js');
  _logLLMCall = ll.logLLMCall;
} catch {
  // 로거 없는 환경에서는 무음 처리
}

// CJS pgPool (LLM 시맨틱 캐시용 — reservation 스키마)
let _pgPool = null;
try {
  const require = createRequire(import.meta.url);
  _pgPool = require('../../../packages/core/lib/pg-pool');
} catch {
  // pgPool 없는 환경에서는 캐시 비활성화
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
const require = createRequire(import.meta.url);

// ─── 설정 로드 (config.yaml 런타임 + Hub secrets 병합) ───────────────

let _cfg;
try {
  _cfg = yaml.load(readFileSync(join(__dirname, '..', 'config.yaml'), 'utf8')) || {};
} catch {
  try {
    const s = JSON.parse(readFileSync(join(__dirname, '..', 'secrets.json'), 'utf8'));
    _cfg = {
      trading_mode: s.trading_mode,
      paper_mode: s.paper_mode,
      anthropic: { api_key: s.anthropic_api_key || '' },
      groq: { accounts: (s.groq_api_keys || [s.groq_api_key]).filter(Boolean).map(k => ({ api_key: k })) },
    };
  } catch {
    _cfg = { trading_mode: 'paper', paper_mode: true, anthropic: { api_key: '' }, groq: { accounts: [] } };
  }
}

const _secrets = loadSecrets();

if (!_cfg.anthropic?.api_key) {
  _cfg.anthropic = {
    ...(_cfg.anthropic || {}),
    api_key: _secrets.anthropic_api_key || '',
    admin_api_key: _secrets.anthropic_admin_api_key || '',
  };
}
if (!_cfg.groq?.accounts?.length) {
  _cfg.groq = {
    ...(_cfg.groq || {}),
    accounts: (_secrets.groq_api_keys || []).map((api_key) => ({ api_key })),
  };
}
if (!_cfg.openai?.api_key) {
  _cfg.openai = {
    ...(_cfg.openai || {}),
    api_key: _secrets.openai_api_key || '',
    admin_api_key: _secrets.openai_admin_api_key || '',
    model: _cfg.openai?.model || _secrets.openai_model || 'gpt-4o',
  };
}
if (!_cfg.gemini?.api_key) {
  _cfg.gemini = {
    ...(_cfg.gemini || {}),
    api_key: _secrets.gemini_api_key || '',
    image_api_key: _secrets.gemini_image_api_key || '',
  };
}
if (!_cfg.cerebras?.api_key) {
  _cfg.cerebras = { ...(_cfg.cerebras || {}), api_key: _secrets.cerebras_api_key || '' };
}
if (!_cfg.sambanova?.api_key) {
  _cfg.sambanova = { ...(_cfg.sambanova || {}), api_key: _secrets.sambanova_api_key || '' };
}
if (!_cfg.xai?.api_key) {
  _cfg.xai = { ...(_cfg.xai || {}), api_key: _secrets.xai_api_key || '' };
}

export const PAPER_MODE = getTradingMode() === 'paper';

const {
  selectLLMPolicy,
} = require('../../../packages/core/lib/llm-model-selector.js');
const { getAgent: getRegistryAgent } = require('../../../packages/core/lib/agent-registry');
const { callWithFallback } = require('../../../packages/core/lib/llm-fallback.js');

const INVESTMENT_LLM_POLICIES = getInvestmentLLMPolicyConfig();
const INVESTMENT_AGENT_POLICY_OVERRIDE = INVESTMENT_LLM_POLICIES.investmentAgentPolicy || null;
const USE_SHARED_FALLBACK_ENGINE = INVESTMENT_AGENT_POLICY_OVERRIDE?.useSharedFallbackEngine !== false;

// ─── 모델 상수 ───────────────────────────────────────────────────────

const DEFAULT_INVESTMENT_POLICY = selectLLMPolicy('investment.agent_policy', {
  agentName: 'luna',
  openaiPerfModel: _cfg.openai?.model || 'gpt-4o',
  policyOverride: INVESTMENT_AGENT_POLICY_OVERRIDE,
});
export const GROQ_SCOUT_MODEL  = DEFAULT_INVESTMENT_POLICY.groqScoutModel;
export const GPT_OSS_20B_MODEL = DEFAULT_INVESTMENT_POLICY.groqCompetitionModels[0];
export const OPENAI_PERF_MODEL = DEFAULT_INVESTMENT_POLICY.openaiPerfModel;
export const HAIKU_MODEL       = DEFAULT_INVESTMENT_POLICY.anthropicModel;
export const OPENAI_MINI_MODEL = DEFAULT_INVESTMENT_POLICY.openaiMiniModel;

// 멀티 모델 경쟁 활성 여부 (GROQ_AGENTS에만 적용, 기본: true)
const DUAL_MODEL = process.env.LUNA_DUAL_MODEL !== 'false';

// ─── Groq 클라이언트 (라운드로빈) ────────────────────────────────────

let   _GroqClass    = null;
let   _groqClients  = null;
let   _groqIdx      = 0;

function getGroqClass() {
  if (_GroqClass) return _GroqClass;
  const mod = require('groq-sdk');
  _GroqClass = mod.default || mod;
  return _GroqClass;
}

function nextGroqClient() {
  const groqAccounts = (loadSecrets().groq_api_keys || []).filter(Boolean).map((api_key) => ({ api_key }));

  if (!_groqClients) {
    const GroqClass = getGroqClass();
    _groqClients = groqAccounts.map(a =>
      new GroqClass({ apiKey: a.api_key, timeout: _LLM_TIMEOUTS.groq, maxRetries: 1 }));
  }
  if (_groqClients.length === 0) throw new Error('Groq API 키 없음 — Hub secrets groq.accounts 설정 필요');
  const client = _groqClients[_groqIdx % _groqClients.length];
  _groqIdx++;
  return client;
}

// ─── Anthropic 클라이언트 (지연 초기화) ─────────────────────────────

let _anthropic = null;
let _AnthropicClass = null;
function getAnthropicClass() {
  if (_AnthropicClass) return _AnthropicClass;
  const mod = require('@anthropic-ai/sdk');
  _AnthropicClass = mod.default || mod;
  return _AnthropicClass;
}

function getAnthropic() {
  if (_anthropic) return _anthropic;
  const apiKey = loadSecrets().anthropic_api_key || '';
  if (!apiKey) throw new Error('Anthropic API 키 없음 — Hub secrets anthropic.api_key 설정 필요');
  const AnthropicClass = getAnthropicClass();
  _anthropic = new AnthropicClass({
    apiKey,
    timeout:        _LLM_TIMEOUTS.sonnet,  // Sonnet 기본, Opus 호출 시 per-request 60s 오버라이드
    maxRetries:     2,
    defaultHeaders: { 'anthropic-beta': 'prompt-caching-2024-07-31' },
  });
  return _anthropic;
}

// ─── OpenAI 클라이언트 (지연 초기화) ─────────────────────────────────

let _openai = null;
let _OpenAIClass = null;
function getOpenAIClass() {
  if (_OpenAIClass) return _OpenAIClass;
  const mod = require('openai');
  _OpenAIClass = mod.default || mod;
  return _OpenAIClass;
}

function getOpenAI() {
  if (_openai) return _openai;
  const apiKey = loadSecrets().openai_api_key || '';
  if (!apiKey) throw new Error('OpenAI API 키 없음 — Hub secrets openai.api_key 설정 필요');
  const OpenAIClass = getOpenAIClass();
  _openai = new OpenAIClass({ apiKey, timeout: _LLM_TIMEOUTS.openai, maxRetries: 1 });
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

// ─── Hub LLM 클라이언트 (지연 로드) ─────────────────────────────────

let _hubLLM = null;
function getHubLLM() {
  if (!_hubLLM) {
    try {
      _hubLLM = require('./hub-llm-client.ts');
    } catch {
      _hubLLM = { isHubEnabled: () => false, isHubShadow: () => false, callViaHub: async () => ({ ok: false }) };
    }
  }
  return _hubLLM;
}

// ─── 통합 LLM 호출 ───────────────────────────────────────────────────

/**
 * @param {string} agentName  'luna'|'nemesis'|'zeus'|'athena'|'oracle'|'hermes'|'sophia'
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {number} [maxTokens=512]
 * @returns {Promise<string>}  LLM 응답 텍스트
 */
export async function callLLM(agentName, systemPrompt, userPrompt, maxTokens = 512, options = {}) {
  await initHubSecrets();
  // ★ 긴급 차단 체크
  const guardScope = resolveInvestmentLLMGuardScope(options);
  if (_billingGuard?.isBlocked(guardScope)) {
    const r = _billingGuard.getBlockReason(guardScope);
    throw new Error(`🚨 LLM 긴급 차단 중: ${r?.reason || '알 수 없음'} — 마스터 해제 필요`);
  }

  const hub = getHubLLM();
  const hubEnabled = hub.isHubEnabled();
  const hubShadow  = hub.isHubShadow();

  // ── Hub 직접 활성 모드 (INVESTMENT_LLM_HUB_ENABLED=true, Shadow=false) ──
  if (hubEnabled && !hubShadow) {
    const result = await hub.callViaHub(agentName, systemPrompt, userPrompt, {
      maxTokens,
      symbol:  options.symbol,
      market:  options.market || getCurrentInvestmentMarket(),
      urgency: agentName === 'luna' ? 'high' : 'medium',
    });
    if (result.ok) return result.text;
    // Hub 실패 시 직접 호출로 폴백
    console.warn(`[llm-client] Hub 실패(${result.error}) → 직접 호출 폴백`);
  }

  // ── 직접 호출 (기존 로직) ──
  const directText = await _callDirect(agentName, systemPrompt, userPrompt, maxTokens, options, guardScope);

  // ── Shadow Mode: 직접 결과로 Hub 비교 로그 ──
  if (hubShadow) {
    hub.callViaHub(agentName, systemPrompt, userPrompt, {
      maxTokens,
      symbol:        options.symbol,
      market:        options.market || getCurrentInvestmentMarket(),
      urgency:       agentName === 'luna' ? 'high' : 'medium',
      shadowCompare: directText,
    }).catch(() => {});
  }

  return directText;
}

async function _callDirect(agentName, systemPrompt, userPrompt, maxTokens, options, guardScope) {
  const registryAgent = await getRegistryAgent(agentName).catch(() => null);
  const agentPolicy = selectLLMPolicy('investment.agent_policy', {
    agentName,
    agentModel: registryAgent?.llm_model || null,
    openaiPerfModel: _cfg.openai?.model || 'gpt-4o',
    policyOverride: INVESTMENT_AGENT_POLICY_OVERRIDE,
  });
  if (USE_SHARED_FALLBACK_ENGINE && agentPolicy.route !== 'dual_groq') {
    return callSharedFallback(agentName, agentPolicy, systemPrompt, userPrompt, maxTokens, {
      ...options,
      guardScope,
    });
  }
  if (agentPolicy.route === 'openai_perf') {
    return callOpenAI(agentName, systemPrompt, userPrompt, maxTokens, { ...options, guardScope });
  }
  if (agentPolicy.route === 'dual_groq') {
    return DUAL_MODEL
      ? callDualModel(agentName, systemPrompt, userPrompt, maxTokens, { ...options, guardScope })
      : callGroq(agentName, systemPrompt, userPrompt, maxTokens, { ...options, guardScope });
  }
  if (agentPolicy.route === 'openai_mini') {
    return callOpenAIMini(agentName, systemPrompt, userPrompt, maxTokens, { ...options, guardScope });
  }
  return callGroq(agentName, systemPrompt, userPrompt, maxTokens, { ...options, guardScope });
}

async function callSharedFallback(agentName, agentPolicy, systemPrompt, userPrompt, maxTokens, options = {}) {
  const isExitCritical = String(options.purpose || '').toLowerCase().includes('exit');
  const filteredChain = (agentPolicy.fallbackChain || []).filter((entry) => {
    if (agentName !== 'luna' || !isExitCritical) return true;
    return !String(entry.model || '').includes('openai/gpt-oss-20b');
  });

  const chain = filteredChain.map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    maxTokens: isExitCritical ? Math.min(entry.maxTokens || maxTokens, 512) : (entry.maxTokens || maxTokens),
    temperature: entry.temperature ?? 0.1,
  }));
  const result = await callWithFallback({
    chain,
    systemPrompt,
    userPrompt,
    timeoutMs: options.timeoutMs || (isExitCritical ? 45000 : null),
    logMeta: {
      team: 'luna',
      purpose: options.purpose || (String(options.requestType || '').toLowerCase().includes('valid') ? 'validator' : 'analyst'),
      bot: agentName,
      agentName,
      requestType: 'trade_signal',
      selectorKey: `investment.${agentPolicy.route}`,
      market: getCurrentInvestmentMarket(),
      symbol: options.symbol || null,
      guardScope: options.guardScope || null,
    },
  });
  return result.text || '';
}

function normalizeScopeToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function resolveInvestmentLLMGuardScope(options = {}) {
  const baseScope = getInvestmentGuardScope();
  const explicit = normalizeScopeToken(options.guardScopeSuffix || options.scopeSuffix || '');
  if (explicit) return `${baseScope}.${explicit}`;

  const symbolToken = normalizeScopeToken(options.symbol || '');
  if (symbolToken) return `${baseScope}.${symbolToken}`;

  return baseScope;
}

function getCurrentInvestmentMarket() {
  const market = String(process.env.INVESTMENT_MARKET || '').trim().toLowerCase();
  return ['crypto', 'domestic', 'overseas'].includes(market) ? market : null;
}

// ─── 재시도 헬퍼 (500/502/503 Exponential Backoff) ──────────────────

/**
 * 서버 오류(500/502/503) 시 지수 백오프 재시도
 * 429는 Groq 키 라운드로빈에서 처리 — 여기서는 서버 장애만 대상
 */
async function callWithRetry(fn, agentName, maxRetries = 3) {
  const extractRetryMeta = (error) => {
    const message = String(
      error?.message
      || error?.error?.message
      || error?.response?.data?.error?.message
      || ''
    );
    const status = error?.status || error?.statusCode || error?.response?.status || null;
    const type = String(
      error?.type
      || error?.error?.type
      || error?.response?.data?.error?.type
      || ''
    ).toLowerCase();
    const code = String(
      error?.code
      || error?.error?.code
      || error?.response?.data?.error?.code
      || ''
    ).toLowerCase();
    const requestIdMatch =
      message.match(/request id[:\\s]+([a-z0-9-]+)/i)
      || message.match(/request[_-]?id[\"'=:\\s]+([a-z0-9-]+)/i);
    const requestId = requestIdMatch?.[1] || null;
    const transientByStatus = [500, 502, 503, 504].includes(Number(status));
    const transientByText =
      type === 'server_error'
      || code === 'server_error'
      || /\\bserver_error\\b/i.test(message)
      || /timed out/i.test(message)
      || /temporar/i.test(message)
      || /internal server error/i.test(message);
    return {
      status,
      message,
      requestId,
      retryable: transientByStatus || transientByText,
    };
  };
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      const meta = extractRetryMeta(e);
      if (meta.retryable && i < maxRetries - 1) {
        const delay = Math.pow(2, i) * 1000;  // 1s → 2s → 4s
        const statusLabel = meta.status ? `HTTP ${meta.status}` : 'server_error';
        const requestIdLabel = meta.requestId ? ` / request_id=${meta.requestId}` : '';
        console.warn(`  ⚠️ [${agentName}] ${statusLabel} 재시도 ${i + 1}/${maxRetries - 1} (${delay}ms 대기)${requestIdLabel}`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
}

// ─── 단건 Groq 호출 (모델 지정, 라운드로빈 1회) ─────────────────────

async function callGroqModel(agentName, systemPrompt, userPrompt, maxTokens, model) {
  const groq = nextGroqClient();
  const t0   = Date.now();
  // gpt-oss-20b는 추론(reasoning) 모델 — reasoning_effort:low로 내부 추론 토큰 최소화
  const isReasoning = model.includes('gpt-oss-20b');
  const params = {
    model,
    max_tokens:      maxTokens,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
  };
  if (isReasoning) params.reasoning_effort = 'low';
  const res  = await groq.chat.completions.create(params);
  return {
    text:         res.choices[0]?.message?.content || '',
    inputTokens:  res.usage?.prompt_tokens     || 0,
    outputTokens: res.usage?.completion_tokens || 0,
    latencyMs:    Date.now() - t0,
  };
}

// ─── 응답 품질 점수 (0~10) ────────────────────────────────────────────

function _scoreResponse(text) {
  const json = parseJSON(text);
  if (!json) return 0;
  let score = 3;  // JSON 파싱 성공
  if (['BUY', 'SELL', 'HOLD', 'STRONG_BUY', 'STRONG_SELL'].includes(json.signal)) score += 2;
  if (typeof json.confidence === 'number' && json.confidence >= 0 && json.confidence <= 1) score += json.confidence * 2;
  if (typeof json.reasoning === 'string') score += json.reasoning.length > 200 ? 2 : json.reasoning.length > 50 ? 1 : 0;
  const fields = ['signal', 'confidence', 'reasoning', 'entry_price', 'stop_loss', 'take_profit'];
  score += fields.filter(f => json[f] != null).length / fields.length;
  return score;
}

function _buildWinReason(ossScore, scoutScore, ossJson, scoutJson) {
  const reasons = [];
  const diff = Math.abs(ossScore - scoutScore);
  reasons.push(diff < 0.5 ? `점수근소(${diff.toFixed(1)})` : `점수차(${diff.toFixed(1)})`);
  if (!ossJson && scoutJson)   reasons.push('oss JSON실패');
  if (ossJson  && !scoutJson)  reasons.push('scout JSON실패');
  if (ossJson?.signal && scoutJson?.signal) {
    reasons.push(ossJson.signal === scoutJson.signal
      ? `신호일치(${ossJson.signal})`
      : `신호불일치(oss:${ossJson.signal} scout:${scoutJson.signal})`);
  }
  return reasons.join(' | ');
}

// ─── 멀티 모델 경쟁 (gpt-oss-20b vs llama-4-scout, 둘 다 무료) ──────

async function callDualModel(agentName, systemPrompt, userPrompt, maxTokens = 512, options = {}) {
  const { symbol, cycleId } = options;
  const t0 = Date.now();

  const [ossResult, scoutResult] = await Promise.allSettled([
    callGroqModel(agentName, systemPrompt, userPrompt, maxTokens, GPT_OSS_20B_MODEL),
    callGroqModel(agentName, systemPrompt, userPrompt, maxTokens, GROQ_SCOUT_MODEL),
  ]);

  const ossOk   = ossResult.status   === 'fulfilled';
  const scoutOk = scoutResult.status === 'fulfilled';

  let winner, chosen, winnerData;

  if (ossOk && scoutOk) {
    const ossText   = ossResult.value.text;
    const scoutText = scoutResult.value.text;
    const ossScore  = _scoreResponse(ossText);
    const scoutScore = _scoreResponse(scoutText);

    winner    = ossScore >= scoutScore ? 'gpt-oss-20b' : 'llama-4-scout';
    chosen    = winner === 'gpt-oss-20b' ? ossText : scoutText;
    winnerData = winner === 'gpt-oss-20b' ? ossResult.value : scoutResult.value;

    console.log(`  🏆 [${agentName}] 멀티모델: gpt-oss=${ossScore.toFixed(1)} vs scout=${scoutScore.toFixed(1)} → ${winner} 채택`);

    // 경쟁 결과 DB 기록
    const ossJson   = parseJSON(ossText);
    const scoutJson = parseJSON(scoutText);
    try {
      const { createRequire } = await import('module');
      const require = createRequire(import.meta.url);
      const pg = require('../../../packages/core/lib/pg-pool');
      await pg.run('investment', `
        INSERT INTO dual_model_results (
          agent, symbol, cycle_id,
          oss_response, oss_signal, oss_confidence, oss_reasoning,
          oss_score, oss_parseable, oss_latency_ms, oss_input_tokens, oss_output_tokens,
          scout_response, scout_signal, scout_confidence, scout_reasoning,
          scout_score, scout_parseable, scout_latency_ms, scout_input_tokens, scout_output_tokens,
          winner, win_reason, score_diff, signals_agree
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
      `, [
        agentName, symbol || null, cycleId || null,
        ossText.slice(0, 2000), ossJson?.signal, ossJson?.confidence, ossJson?.reasoning?.slice(0, 500),
        ossScore, !!ossJson, ossResult.value.latencyMs, ossResult.value.inputTokens, ossResult.value.outputTokens,
        scoutText.slice(0, 2000), scoutJson?.signal, scoutJson?.confidence, scoutJson?.reasoning?.slice(0, 500),
        scoutScore, !!scoutJson, scoutResult.value.latencyMs, scoutResult.value.inputTokens, scoutResult.value.outputTokens,
        winner, _buildWinReason(ossScore, scoutScore, ossJson, scoutJson),
        Math.abs(ossScore - scoutScore), ossJson?.signal === scoutJson?.signal,
      ]);
    } catch { /* DB 없으면 무시 */ }
  } else if (ossOk) {
    winner     = 'gpt-oss-20b';
    chosen     = ossResult.value.text;
    winnerData = ossResult.value;
    console.log(`  ℹ️ [${agentName}] scout 실패 → gpt-oss-20b 사용`);
  } else if (scoutOk) {
    winner     = 'llama-4-scout';
    chosen     = scoutResult.value.text;
    winnerData = scoutResult.value;
    console.log(`  ℹ️ [${agentName}] gpt-oss 실패 → llama-4-scout 사용`);
  } else {
    // 둘 다 실패 → OpenAI 폴백
    console.warn(`  ⚠️ [${agentName}] 무료 모델 전체 실패 → OpenAI gpt-4o 폴백`);
    return callOpenAI(agentName, systemPrompt, userPrompt, maxTokens, {
      skipFallback: true,
      symbol: options.symbol || null,
      guardScope: options.guardScope || null,
    });
  }

  const dur = Date.now() - t0;
  const model = winner === 'gpt-oss-20b' ? GPT_OSS_20B_MODEL : GROQ_SCOUT_MODEL;
  _trackTokens?.({ bot: agentName, team: 'investment', model, provider: 'groq',
    taskType: 'trade_signal_dual', tokensIn: winnerData.inputTokens, tokensOut: winnerData.outputTokens, durationMs: dur });
  _logLLMCall?.({ team: 'luna', bot: agentName, model, requestType: 'trade_signal_dual',
    market: getCurrentInvestmentMarket(), symbol: options.symbol || null, guardScope: options.guardScope || null,
    inputTokens: winnerData.inputTokens, outputTokens: winnerData.outputTokens, latencyMs: dur });

  return chosen;
}

// ─── OpenAI 호출 ─────────────────────────────────────────────────────

async function callOpenAIMini(agentName, systemPrompt, userPrompt, maxTokens, { skipFallback = false, symbol = null, guardScope = null } = {}) {
  const MINI_MODEL = OPENAI_MINI_MODEL;
  const t0 = Date.now();
  const doCall = async () => {
    const openai = getOpenAI();
    return openai.chat.completions.create({
      model:           MINI_MODEL,
      max_tokens:      maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
    });
  };
  try {
    const res    = await callWithRetry(doCall, agentName);
    const dur    = Date.now() - t0;
    const inTok  = res.usage?.prompt_tokens     || 0;
    const outTok = res.usage?.completion_tokens || 0;
    _trackTokens?.({
      bot: agentName, team: 'investment', model: MINI_MODEL, provider: 'openai',
      taskType: 'trade_signal', tokensIn: inTok, tokensOut: outTok, durationMs: dur,
    });
    _logLLMCall?.({
      team: 'luna', bot: agentName, model: MINI_MODEL,
      market: getCurrentInvestmentMarket(), symbol, guardScope,
      requestType: 'trade_signal', inputTokens: inTok, outputTokens: outTok, latencyMs: dur,
    });
    return res.choices[0]?.message?.content || '';
  } catch (err) {
    if (skipFallback) throw err;
    // 1차 폴백: Groq Scout
    console.warn(`  ⚠️ [${agentName}] gpt-4o-mini 실패 (${err.message?.slice(0,60)}) → Groq Scout 폴백`);
    try {
      return await callGroq(agentName, systemPrompt, userPrompt, maxTokens, { skipFallback: true, symbol, guardScope });
    } catch (groqErr) {
      // 2차 폴백: gpt-4o (최종 안전망)
      console.warn(`  ⚠️ [${agentName}] Groq Scout도 실패 (${groqErr.message?.slice(0,60)}) → gpt-4o 최종 폴백`);
      return callOpenAI(agentName, systemPrompt, userPrompt, maxTokens, { skipFallback: true, symbol, guardScope });
    }
  }
}

async function callOpenAI(agentName, systemPrompt, userPrompt, maxTokens, { skipFallback = false, symbol = null, guardScope = null } = {}) {
  const t0 = Date.now();
  const doCall = async () => {
    const openai = getOpenAI();
    return openai.chat.completions.create({
      model:           OPENAI_PERF_MODEL,
      max_tokens:      maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
    });
  };
  try {
    const res    = await callWithRetry(doCall, agentName);
    const dur    = Date.now() - t0;
    const inTok  = res.usage?.prompt_tokens     || 0;
    const outTok = res.usage?.completion_tokens || 0;
    _trackTokens?.({
      bot: agentName, team: 'investment', model: OPENAI_PERF_MODEL, provider: 'openai',
      taskType: 'trade_signal', tokensIn: inTok, tokensOut: outTok, durationMs: dur,
    });
    _logLLMCall?.({
      team: 'luna', bot: agentName, model: OPENAI_PERF_MODEL,
      market: getCurrentInvestmentMarket(), symbol, guardScope,
      requestType: 'trade_signal', inputTokens: inTok, outputTokens: outTok, latencyMs: dur,
    });
    return res.choices[0]?.message?.content || '';
  } catch (err) {
    if (skipFallback) throw err;
    // OpenAI 실패 시 Groq로 폴백
    console.warn(`  ⚠️ [${agentName}] OpenAI 실패 (${err.message?.slice(0,60)}) → Groq 폴백`);
    return callGroq(agentName, systemPrompt, userPrompt, maxTokens, { skipFallback: true, symbol, guardScope });
  }
}

async function callGroq(agentName, systemPrompt, userPrompt, maxTokens, { skipFallback = false, symbol = null, guardScope = null } = {}) {
  let lastErr;
  const maxAttempts = Math.max(_groqClients?.length || 0, 1);
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
        market: getCurrentInvestmentMarket(), symbol, guardScope,
        requestType: 'trade_signal', inputTokens: inTok, outputTokens: outTok, latencyMs: dur,
      });
      return res.choices[0]?.message?.content || '';
    } catch (err) {
      lastErr = err;
      if (err.status === 429) { continue; }
      break;  // 429 외 오류 → 루프 종료 후 폴백
    }
  }
  if (skipFallback) throw lastErr ?? new Error(`Groq 전체 실패 — ${agentName}`);
  // Groq 전체 실패 → gpt-4o-mini 폴백 (비용 절감)
  const reason = lastErr?.status === 429 ? '전체 키 rate limit' : (lastErr?.message?.slice(0, 60) ?? '알 수 없는 오류');
  console.warn(`  ⚠️ [${agentName}] Groq 실패 (${reason}) → gpt-4o-mini 폴백`);
  return callOpenAIMini(agentName, systemPrompt, userPrompt, maxTokens, { skipFallback: true, symbol, guardScope });
}

// ─── 시맨틱 캐싱 (SHA256 해시, PostgreSQL reservation.llm_cache) ──────

let _cacheReady = false;

async function ensureLLMCache() {
  if (_cacheReady || !_pgPool) return;
  try {
    await _pgPool.run('reservation', `
      CREATE TABLE IF NOT EXISTS llm_cache (
        cache_key  TEXT PRIMARY KEY,
        response   TEXT NOT NULL,
        model      TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      )
    `);
    await _pgPool.run('reservation',
      `CREATE INDEX IF NOT EXISTS idx_llm_cache_expires ON llm_cache (expires_at)`
    );
    _cacheReady = true;
  } catch {
    // 캐시 테이블 생성 실패 시 조용히 비활성화
  }
}

/**
 * 캐싱 래퍼 — 동일 프롬프트는 TTL 내에서 DB 캐시 반환
 *
 * @param {string} agentName
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {number} [maxTokens=512]
 * @param {object} [opts]
 * @param {number} [opts.cacheTTL=300]  캐시 유효 시간(초) — 루나팀 기본 5분
 * @param {boolean} [opts.skipCache]    true: 캐시 우회 (긴급 시)
 * @returns {Promise<string>}
 */
export async function cachedCallLLM(agentName, systemPrompt, userPrompt, maxTokens = 512, opts = {}) {
  const ttl = Math.max(60, Math.min(86400, Math.floor(opts.cacheTTL ?? 300)));  // 1분~24시간

  if (opts.skipCache || !_pgPool) {
    return callLLM(agentName, systemPrompt, userPrompt, maxTokens, opts);
  }

  await ensureLLMCache();
  if (!_cacheReady) {
    return callLLM(agentName, systemPrompt, userPrompt, maxTokens, opts);
  }

  const key = createHash('sha256')
    .update(agentName + systemPrompt + userPrompt)
    .digest('hex');

  // 캐시 조회
  try {
    const rows = await _pgPool.query('reservation',
      'SELECT response FROM llm_cache WHERE cache_key = $1 AND expires_at > NOW()',
      [key],
    );
    if (rows.length > 0) {
      console.log(`  💾 [${agentName}] LLM 캐시 히트 (${key.slice(0, 8)}...)`);
      return rows[0].response;
    }
  } catch { /* 조회 실패 → API 직접 호출 */ }

  // 캐시 미스 → API 호출
  const result = await callLLM(agentName, systemPrompt, userPrompt, maxTokens, opts);

  // 캐시 저장 (실패해도 결과는 반환)
  try {
    await _pgPool.run('reservation',
      `INSERT INTO llm_cache (cache_key, response, model, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '${ttl} seconds')
       ON CONFLICT (cache_key) DO UPDATE
         SET response = $2, expires_at = NOW() + INTERVAL '${ttl} seconds'`,
      [key, result, agentName],
    );
  } catch { /* 저장 실패 → 무시 */ }

  return result;
}
