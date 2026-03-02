'use strict';

/**
 * shared/llm.js — 통합 LLM 클라이언트 (Phase 3-A)
 *
 * 지원 프로바이더:
 *   groq      — api.groq.com        (무료, llama-3.1-8b-instant / llama-3.3-70b)
 *   cerebras  — api.cerebras.ai     (무료, llama3.1-8b — 1M TPD)
 *   sambanova — api.sambanova.ai    (무료, Meta-Llama-3.3-70B)
 *   xai       — api.x.ai            (유료 $5/1K, grok-4-1-fast — x_search 포함)
 *   anthropic — api.anthropic.com   (유료, claude-haiku-4-5)
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

// ─── 사용량 로그 (api-usage.jsonl 공유) ─────────────────────────────

const LOG_FILE = path.join(os.homedir(), '.openclaw', 'api-usage.jsonl');

function logUsage({ provider, model, promptTokens = 0, completionTokens = 0, latencyMs = 0, caller = '', success = true }) {
  try {
    const record = {
      ts:                new Date().toISOString(),
      provider,
      model,
      prompt_tokens:     promptTokens,
      completion_tokens: completionTokens,
      total_tokens:      promptTokens + completionTokens,
      latency_ms:        latencyMs,
      caller,
      success,
    };
    fs.appendFileSync(LOG_FILE, JSON.stringify(record) + '\n');
  } catch { /* 로그 실패는 메인 로직에 영향 없음 */ }
}

// ─── OpenAI 호환 프로바이더 ──────────────────────────────────────────

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

function getApiKey(provider) {
  const cfg = PROVIDERS[provider];
  if (!cfg) return null;
  const s = loadSecrets();
  return s[cfg.secretKey] || process.env[cfg.envKey] || null;
}

/**
 * OpenAI 호환 API 호출 (내부 공통 함수)
 * @param {object} opts
 * @param {string} opts.provider
 * @param {string} opts.model
 * @param {string} opts.systemPrompt
 * @param {string} opts.userMessage
 * @param {string} opts.caller
 * @param {object[]} [opts.tools]        — xAI x_search 등 도구
 * @param {number}   [opts.maxTokens=256]
 * @returns {Promise<string|null>}
 */
function callOpenAICompat({ provider, model, systemPrompt, userMessage, caller, tools, maxTokens = 256 }) {
  const cfg    = PROVIDERS[provider];
  const apiKey = getApiKey(provider);
  if (!apiKey) return Promise.resolve(null);

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
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) {
            console.error(`⚠️ ${provider} 오류:`, parsed.error.message || JSON.stringify(parsed.error));
            logUsage({ provider, model, latencyMs, caller, success: false });
            resolve(null);
            return;
          }
          const usage = parsed.usage || {};
          logUsage({
            provider, model,
            promptTokens:     usage.prompt_tokens     || 0,
            completionTokens: usage.completion_tokens || 0,
            latencyMs, caller, success: true,
          });
          // 일반 콘텐츠 응답
          const content = parsed.choices?.[0]?.message?.content;
          if (content) { resolve(content); return; }
          // tool_calls 응답 (xAI x_search hosted tool — 내용 추출 불가)
          const toolCalls = parsed.choices?.[0]?.message?.tool_calls;
          if (toolCalls) {
            console.warn(`  ⚠️ ${provider} tool_calls 응답 — 내용 없음`);
            resolve(null);
            return;
          }
          resolve(null);
        } catch (e) { reject(e); }
      });
    });

    req.on('error', (e) => {
      logUsage({ provider, model, latencyMs: Date.now() - start, caller, success: false });
      reject(e);
    });
    req.setTimeout(15000, () => {
      req.destroy();
      logUsage({ provider, model, latencyMs: 15000, caller, success: false });
      reject(new Error(`${provider} API 타임아웃`));
    });
    req.write(body);
    req.end();
  });
}

/**
 * 무료 LLM 호출 (프로바이더 지정 + groq 자동 fallback)
 *
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {string} [model]       — 생략 시 프로바이더 기본값
 * @param {string} [caller]      — 호출 모듈명 (로그용)
 * @param {string} [provider]    — 'groq' | 'cerebras' | 'sambanova'
 * @param {number} [maxTokens]
 * @returns {Promise<string|null>}
 */
async function callFreeLLM(
  systemPrompt,
  userMessage,
  model    = null,
  caller   = '',
  provider = 'groq',
  maxTokens = 256,
) {
  if (PROVIDERS[provider]) {
    const key = getApiKey(provider);
    if (key) {
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

  // groq fallback
  if (provider !== 'groq') {
    const groqKey = getApiKey('groq');
    if (groqKey) {
      const fallbackModel = model || DEFAULT_MODELS.groq;
      console.warn(`  ↩️  groq/${fallbackModel} 으로 대체`);
      return callOpenAICompat({
        provider: 'groq', model: fallbackModel,
        systemPrompt, userMessage, caller: `${caller}[groq-fallback]`, maxTokens,
      });
    }
  }

  console.warn('⚠️ 무료 LLM API 키 없음 — null 반환');
  return null;
}

/**
 * xAI X Search 호출 (소피아 — 30분 주기)
 *
 * @param {string} systemPrompt
 * @param {string} userMessage   — X 검색 맥락 포함
 * @param {string} caller
 * @returns {Promise<string|null>}
 */
async function callXAI(systemPrompt, userMessage, caller = 'sophia-xai') {
  const apiKey = getApiKey('xai');
  if (!apiKey) {
    console.warn('  ⚠️ xAI API 키 없음 — xAI 호출 스킵');
    return null;
  }

  try {
    const result = await callOpenAICompat({
      provider: 'xai',
      model:    'grok-3-mini-fast',
      systemPrompt,
      userMessage,
      caller,
      tools:     [{ type: 'x_search' }],
      maxTokens: 512,
    });
    return result;
  } catch (e) {
    console.warn(`  ⚠️ xAI 호출 실패: ${e.message}`);
    return null;
  }
}

// ─── Anthropic Messages API ──────────────────────────────────────────

/**
 * Claude Haiku 호출 (루나·제우스·아테나·네메시스 전용)
 *
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {string} [caller]
 * @param {number} [maxTokens=512]
 * @returns {Promise<string|null>}
 */
function callHaiku(systemPrompt, userMessage, caller = '', maxTokens = 512) {
  const s      = loadSecrets();
  const apiKey = s.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('⚠️ Anthropic API 키 없음');
    return Promise.resolve(null);
  }

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
        try {
          const parsed = JSON.parse(raw);
          const usage  = parsed.usage || {};
          logUsage({
            provider: 'anthropic', model: 'claude-haiku-4-5-20251001',
            promptTokens:     usage.input_tokens  || 0,
            completionTokens: usage.output_tokens || 0,
            latencyMs, caller, success: !!parsed.content?.[0]?.text,
          });
          resolve(parsed.content?.[0]?.text || null);
        } catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Haiku API 타임아웃')); });
    req.write(body);
    req.end();
  });
}

/** JSON 파싱 (마크다운 코드블록 제거 후) */
function parseJSON(raw) {
  if (!raw) return null;
  try {
    const cleaned = raw.replace(/```json?\n?|\n?```/g, '').trim();
    const s = cleaned.indexOf('{'), e2 = cleaned.lastIndexOf('}');
    return JSON.parse(s >= 0 && e2 > s ? cleaned.slice(s, e2 + 1) : cleaned);
  } catch { return null; }
}

module.exports = {
  callFreeLLM, callXAI, callHaiku, parseJSON,
  getApiKey, PROVIDERS, DEFAULT_MODELS, logUsage,
};
