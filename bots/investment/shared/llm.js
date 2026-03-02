'use strict';

/**
 * shared/llm.js — 통합 LLM 클라이언트 (Phase 3-A)
 *
 * 지원 프로바이더:
 *   groq      — api.groq.com        (무료, llama-3.1-8b-instant / llama-3.3-70b)
 *   cerebras  — api.cerebras.ai     (무료, llama3.1-8b — 1M TPD)
 *   sambanova — api.sambanova.ai    (무료, Meta-Llama-3.3-70B)
 *   xai       — api.x.ai            (유료 $5/1K, grok-3-mini-fast — x_search 포함)
 *   anthropic — api.anthropic.com   (유료, claude-haiku-4-5)
 *
 * 라운드로빈 다중 키 지원 (429 한도 초과 시 다음 키로 자동 전환):
 *   secrets.json:
 *     "groq_api_key":  "single-key"              ← 단일 키 (하위호환)
 *     "groq_api_keys": ["key1", "key2", "key3"]  ← 다중 키 풀 (우선)
 *   동일 방식: cerebras_api_keys, sambanova_api_keys, anthropic_api_keys
 *
 * 에이전트별 기본 배정:
 *   아리아(aria)     — 규칙 기반 (LLM 없음)
 *   오라클(oracle)   — cerebras → groq fallback
 *   헤르메스(hermes) — groq → cerebras fallback
 *   소피아(sophia)   — sambanova → groq fallback / xAI (30분 주기)
 *   제우스(zeus)     — anthropic haiku
 *   아테나(athena)   — anthropic haiku
 *   네메시스(nemesis)— anthropic haiku
 *   루나(luna)       — anthropic haiku (최종 판단)
 */

const https = require('https');
const os    = require('os');
const fs    = require('fs');
const path  = require('path');
const { loadSecrets } = require('./secrets');

// ─── 사용량 로그 ─────────────────────────────────────────────────────

const LOG_FILE = path.join(os.homedir(), '.openclaw', 'api-usage.jsonl');

function logUsage({ provider, model, promptTokens = 0, completionTokens = 0, latencyMs = 0, caller = '', success = true, keyIndex = 0 }) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify({
      ts:                new Date().toISOString(),
      provider,
      model,
      key_index:         keyIndex,
      prompt_tokens:     promptTokens,
      completion_tokens: completionTokens,
      total_tokens:      promptTokens + completionTokens,
      latency_ms:        latencyMs,
      caller,
      success,
    }) + '\n');
  } catch { /* 로그 실패는 메인 로직에 영향 없음 */ }
}

// ─── KeyPool — 라운드로빈 다중 키 관리 ──────────────────────────────

/**
 * 프로바이더별 라운드로빈 인덱스 (인메모리)
 * 재시작 시 0으로 초기화 — 의도된 동작 (hot 키부터 다시 시작)
 */
const _rrIndex = {};

/**
 * 프로바이더의 키 풀 반환
 * secrets.json 우선순위: `{provider}_api_keys` 배열 > `{provider}_api_key` 단일
 *
 * @param {string} provider   'groq' | 'cerebras' | 'sambanova' | 'xai'
 * @param {string} secretKey  secrets.json 단일 키 이름 (e.g. 'groq_api_key')
 * @param {string} envKey     환경변수 이름 (e.g. 'GROQ_API_KEY')
 * @returns {string[]}        유효한 API 키 배열 (빈 배열 = 키 없음)
 */
function getKeyPool(provider, secretKey, envKey) {
  const s    = loadSecrets();
  const pool = [];

  // 1) 배열 키 우선 (중복 제거)
  const arrayKey = `${provider}_api_keys`;
  if (Array.isArray(s[arrayKey])) {
    s[arrayKey].forEach(k => { if (k && !pool.includes(k)) pool.push(k); });
  }

  // 2) 단일 키 추가 (미포함 시)
  const single = s[secretKey] || process.env[envKey] || '';
  if (single && !pool.includes(single)) pool.push(single);

  return pool.filter(Boolean);
}

/**
 * 라운드로빈으로 다음 키 반환
 * @param {string}   provider
 * @param {string[]} pool
 * @returns {{ key: string, index: number } | null}
 */
function nextKey(provider, pool) {
  if (pool.length === 0) return null;
  if (_rrIndex[provider] === undefined) _rrIndex[provider] = 0;
  const index = _rrIndex[provider] % pool.length;
  return { key: pool[index], index };
}

/**
 * 해당 프로바이더 인덱스를 다음으로 advance
 */
function advanceKey(provider, pool) {
  if (_rrIndex[provider] === undefined) _rrIndex[provider] = 0;
  _rrIndex[provider] = (_rrIndex[provider] + 1) % (pool.length || 1);
}

// ─── 프로바이더 설정 ─────────────────────────────────────────────────

const PROVIDERS = {
  groq:      { host: 'api.groq.com',      path: '/openai/v1/chat/completions', secretKey: 'groq_api_key',       envKey: 'GROQ_API_KEY' },
  cerebras:  { host: 'api.cerebras.ai',   path: '/v1/chat/completions',         secretKey: 'cerebras_api_key',  envKey: 'CEREBRAS_API_KEY' },
  sambanova: { host: 'api.sambanova.ai',  path: '/v1/chat/completions',         secretKey: 'sambanova_api_key', envKey: 'SAMBANOVA_API_KEY' },
  xai:       { host: 'api.x.ai',          path: '/v1/chat/completions',         secretKey: 'xai_api_key',       envKey: 'XAI_API_KEY' },
};

const DEFAULT_MODELS = {
  groq:      'llama-3.1-8b-instant',
  cerebras:  'llama3.1-8b',
  sambanova: 'Meta-Llama-3.3-70B-Instruct',
  xai:       'grok-3-mini-fast',
};

/** 단일 키 조회 (하위호환) */
function getApiKey(provider) {
  const cfg  = PROVIDERS[provider];
  if (!cfg) return null;
  const pool = getKeyPool(provider, cfg.secretKey, cfg.envKey);
  return pool[0] || null;
}

// ─── OpenAI 호환 단일 호출 ───────────────────────────────────────────

/**
 * OpenAI 호환 API 단일 호출 (특정 키 지정)
 * @returns {Promise<{ content: string|null, status: number }>}
 *   status: 200=성공, 429=레이트리밋, 4xx/5xx=기타오류
 */
function _callWithKey({ cfg, apiKey, model, systemPrompt, userMessage, caller, tools, maxTokens }) {
  return new Promise((resolve, reject) => {
    const payload = {
      model,
      max_tokens:  maxTokens,
      temperature: 0.1,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage },
      ],
    };
    if (tools && tools.length > 0) payload.tools = tools;

    const body  = Buffer.from(JSON.stringify(payload));
    const start = Date.now();

    const req = https.request({
      hostname: cfg.host,
      path:     cfg.path,
      method:   'POST',
      headers: {
        'Authorization':  `Bearer ${apiKey}`,
        'Content-Type':   'application/json',
        'Content-Length': body.length,
      },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        const latencyMs = Date.now() - start;
        const status    = res.statusCode;
        try {
          // non-JSON 응답 처리 (xAI 폐기 API 오류 등)
          let parsed;
          try { parsed = JSON.parse(raw); }
          catch (_) {
            console.error(`  ⚠️ ${caller} 비JSON 응답 (${status}): ${raw.slice(0, 120)}`);
            resolve({ content: null, status: status || 500, latencyMs });
            return;
          }

          if (status === 429) {
            // 레이트리밋 — 다음 키로 전환해야 함
            resolve({ content: null, status: 429, latencyMs });
            return;
          }

          if (parsed.error) {
            const errMsg = typeof parsed.error === 'string'
              ? parsed.error
              : (parsed.error.message || JSON.stringify(parsed.error));
            console.error(`  ⚠️ LLM 오류 (${status}):`, errMsg.slice(0, 120));
            resolve({ content: null, status: status || 500, latencyMs });
            return;
          }

          const usage = parsed.usage || {};
          logUsage({
            provider: cfg.host.split('.')[1], model,
            promptTokens:     usage.prompt_tokens     || 0,
            completionTokens: usage.completion_tokens || 0,
            latencyMs, caller, success: true,
          });

          const content = parsed.choices?.[0]?.message?.content;
          if (content) { resolve({ content, status: 200, latencyMs }); return; }

          if (parsed.choices?.[0]?.message?.tool_calls) {
            console.warn(`  ⚠️ tool_calls 응답 — content 없음`);
            resolve({ content: null, status: 200, latencyMs });
            return;
          }
          resolve({ content: null, status: 200, latencyMs });
        } catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error(`LLM API 타임아웃 (${cfg.host})`));
    });
    req.write(body);
    req.end();
  });
}

// ─── 라운드로빈 호출 (핵심 함수) ────────────────────────────────────

/**
 * OpenAI 호환 API 라운드로빈 호출
 * - 429 레이트리밋 → 즉시 다음 키로 재시도
 * - 모든 키 소진 → null 반환
 *
 * @param {object} opts
 * @param {string} opts.provider
 * @param {string} opts.model
 * @param {string} opts.systemPrompt
 * @param {string} opts.userMessage
 * @param {string} [opts.caller]
 * @param {object[]} [opts.tools]
 * @param {number}   [opts.maxTokens]
 * @returns {Promise<string|null>}
 */
async function callOpenAICompat({ provider, model, systemPrompt, userMessage, caller = '', tools, maxTokens = 256 }) {
  const cfg  = PROVIDERS[provider];
  if (!cfg) return null;

  const pool = getKeyPool(provider, cfg.secretKey, cfg.envKey);
  if (pool.length === 0) {
    console.warn(`  ⚠️ ${provider} API 키 없음 — groq fallback`);
    return null;
  }

  // 모든 키를 최대 1번씩 시도 (라운드로빈)
  const startIdx = (_rrIndex[provider] || 0) % pool.length;
  for (let tried = 0; tried < pool.length; tried++) {
    const idx    = (startIdx + tried) % pool.length;
    const apiKey = pool[idx];
    const keyTag = pool.length > 1 ? `[키${idx + 1}/${pool.length}]` : '';

    try {
      const { content, status } = await _callWithKey({
        cfg, apiKey, model, systemPrompt, userMessage, caller, tools, maxTokens,
      });

      if (status === 429) {
        console.warn(`  ⚠️ ${provider} ${keyTag} 레이트리밋(429) → 다음 키 시도`);
        advanceKey(provider, pool); // 다음 호출도 다음 키부터
        continue;
      }

      if (content !== null) {
        // 성공 → 다음 호출은 이 키 그대로 (또는 rotate 선택 가능)
        _rrIndex[provider] = (idx + 1) % pool.length; // 부하 분산 위해 rotate
        return content;
      }

      // 성공이지만 content 없음 (tool_calls 등) → fallback
      return null;

    } catch (e) {
      console.warn(`  ⚠️ ${provider} ${keyTag} 오류: ${e.message}`);
      // 타임아웃/네트워크 오류는 같은 키가 아니라 다음 키 시도
      advanceKey(provider, pool);
    }
  }

  console.warn(`  ⚠️ ${provider} 모든 키(${pool.length}개) 소진 — null 반환`);
  return null;
}

// ─── 무료 LLM (프로바이더 + groq fallback) ──────────────────────────

/**
 * 무료 LLM 호출 (프로바이더 지정 + groq 자동 fallback)
 *
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {string} [model]         — 생략 시 프로바이더 기본값
 * @param {string} [caller]        — 호출 모듈명 (로그용)
 * @param {string} [provider]      — 'groq' | 'cerebras' | 'sambanova'
 * @param {number} [maxTokens]
 * @param {string} [groqModel]     — Groq fallback 시 사용할 모델 (기본: llama-3.1-8b-instant)
 *                                   70B 품질이 필요한 경우: 'llama-3.3-70b-versatile'
 * @returns {Promise<string|null>}
 */
async function callFreeLLM(
  systemPrompt,
  userMessage,
  model     = null,
  caller    = '',
  provider  = 'groq',
  maxTokens = 256,
  groqModel = null,   // Groq fallback 전용 모델 — null이면 DEFAULT_MODELS.groq
) {
  if (PROVIDERS[provider]) {
    const pool = getKeyPool(provider, PROVIDERS[provider].secretKey, PROVIDERS[provider].envKey);
    if (pool.length > 0) {
      const m = model || DEFAULT_MODELS[provider];
      try {
        const result = await callOpenAICompat({ provider, model: m, systemPrompt, userMessage, caller, maxTokens });
        if (result !== null) return result;
        console.warn(`  ⚠️ ${provider} 응답 없음 — groq fallback`);
      } catch (e) {
        console.warn(`  ⚠️ ${provider} 오류: ${e.message} — groq fallback`);
      }
    } else {
      console.warn(`  ⚠️ ${provider} API 키 없음 — groq fallback`);
    }
  }

  // groq fallback — 항상 Groq 전용 모델명 사용 (타 프로바이더 모델명 그대로 전달 금지)
  if (provider !== 'groq') {
    const groqPool = getKeyPool('groq', PROVIDERS.groq.secretKey, PROVIDERS.groq.envKey);
    if (groqPool.length > 0) {
      // groqModel 명시 > DEFAULT_MODELS.groq 순서 (타 프로바이더 model명 사용 금지)
      const fallbackModel = groqModel || DEFAULT_MODELS.groq;
      console.warn(`  ↩️  groq/${fallbackModel} 으로 대체`);
      return callOpenAICompat({
        provider: 'groq', model: fallbackModel,
        systemPrompt, userMessage, caller: `${caller}[groq-fb]`, maxTokens,
      });
    }
  }

  console.warn('⚠️ 무료 LLM API 키 없음 — null 반환');
  return null;
}

// ─── Anthropic Messages API (라운드로빈) ─────────────────────────────

/**
 * Claude Haiku 호출 (루나·제우스·아테나·네메시스 전용)
 * anthropic_api_keys 배열로 다중 키 라운드로빈 지원
 *
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {string} [caller]
 * @param {number} [maxTokens=512]
 * @returns {Promise<string|null>}
 */
async function callHaiku(systemPrompt, userMessage, caller = '', maxTokens = 512) {
  const s = loadSecrets();

  // 키 풀 구성 (anthropic_api_keys 배열 우선, 단일 키 하위호환)
  const pool = [];
  if (Array.isArray(s.anthropic_api_keys)) {
    s.anthropic_api_keys.forEach(k => { if (k && !pool.includes(k)) pool.push(k); });
  }
  const single = s.anthropic_api_key || process.env.ANTHROPIC_API_KEY || '';
  if (single && !pool.includes(single)) pool.push(single);

  if (pool.length === 0) {
    console.warn('⚠️ Anthropic API 키 없음');
    return null;
  }

  const provider = 'anthropic';
  if (_rrIndex[provider] === undefined) _rrIndex[provider] = 0;
  const startIdx = _rrIndex[provider] % pool.length;

  for (let tried = 0; tried < pool.length; tried++) {
    const idx    = (startIdx + tried) % pool.length;
    const apiKey = pool[idx];
    const keyTag = pool.length > 1 ? `[키${idx + 1}/${pool.length}]` : '';

    const result = await _callHaikuWithKey({ apiKey, systemPrompt, userMessage, caller, maxTokens });

    if (result.status === 429) {
      console.warn(`  ⚠️ Anthropic ${keyTag} 레이트리밋(429) → 다음 키 시도`);
      _rrIndex[provider] = (idx + 1) % pool.length;
      continue;
    }
    if (result.content !== null) {
      _rrIndex[provider] = (idx + 1) % pool.length;
      return result.content;
    }
    return null;
  }

  console.warn(`  ⚠️ Anthropic 모든 키(${pool.length}개) 소진`);
  return null;
}

function _callHaikuWithKey({ apiKey, systemPrompt, userMessage, caller, maxTokens }) {
  return new Promise((resolve, reject) => {
    const body  = Buffer.from(JSON.stringify({
      model:       'claude-haiku-4-5-20251001',
      max_tokens:  maxTokens,
      temperature: 0.1,
      system:      systemPrompt,
      messages:    [{ role: 'user', content: userMessage }],
    }));
    const start = Date.now();

    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
        'content-length':    body.length,
      },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        const latencyMs = Date.now() - start;
        const status    = res.statusCode;
        try {
          const parsed = JSON.parse(raw);
          if (status === 429) { resolve({ content: null, status: 429 }); return; }
          const usage = parsed.usage || {};
          logUsage({
            provider: 'anthropic', model: 'claude-haiku-4-5-20251001',
            promptTokens:     usage.input_tokens  || 0,
            completionTokens: usage.output_tokens || 0,
            latencyMs, caller, success: !!parsed.content?.[0]?.text,
          });
          resolve({ content: parsed.content?.[0]?.text || null, status: 200 });
        } catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Haiku API 타임아웃')); });
    req.write(body);
    req.end();
  });
}

// ─── 유틸 ───────────────────────────────────────────────────────────

/** JSON 파싱 (마크다운 코드블록 제거 후) */
function parseJSON(raw) {
  if (!raw) return null;
  try {
    const cleaned = raw.replace(/```json?\n?|\n?```/g, '').trim();
    const s = cleaned.indexOf('{'), e2 = cleaned.lastIndexOf('}');
    return JSON.parse(s >= 0 && e2 > s ? cleaned.slice(s, e2 + 1) : cleaned);
  } catch { return null; }
}

/** 현재 키 풀 상태 출력 (디버그용) */
function printKeyPoolStatus() {
  const providers = ['groq', 'cerebras', 'sambanova', 'xai'];
  providers.forEach(p => {
    const cfg  = PROVIDERS[p];
    const pool = getKeyPool(p, cfg.secretKey, cfg.envKey);
    const idx  = (_rrIndex[p] || 0) % (pool.length || 1);
    console.log(`  [${p}] ${pool.length}개 키 | 현재 인덱스: ${idx}`);
  });
  const s = loadSecrets();
  const aPool = [];
  if (Array.isArray(s.anthropic_api_keys)) s.anthropic_api_keys.forEach(k => k && aPool.push(k));
  if (s.anthropic_api_key && !aPool.includes(s.anthropic_api_key)) aPool.push(s.anthropic_api_key);
  const aIdx = (_rrIndex['anthropic'] || 0) % (aPool.length || 1);
  console.log(`  [anthropic] ${aPool.length}개 키 | 현재 인덱스: ${aIdx}`);
}

module.exports = {
  callFreeLLM, callHaiku, parseJSON,
  callOpenAICompat, getApiKey, getKeyPool,
  PROVIDERS, DEFAULT_MODELS, logUsage, printKeyPoolStatus,
};
